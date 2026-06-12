<script lang="ts">
  // Bootstrap discovery wizard (bootstrap slice) — the first-run "scan your
  // machine for existing primitives and import them" flow, plus a Reconcile tab
  // (the `forget` home). Rendered as a modal the Library route mounts when the
  // user opens it. The statefulness lives in core (the resumable session file)
  // and the BootstrapPlan held between scan and execute — not here.
  //
  // No useEffect: the initial session read is a resource() (the repo's mount-load
  // primitive); every step transition is event-handler-driven. The in-flight scan
  // shows a STATIC three-stage list + a CSS indeterminate bar (the stages are a
  // fixed, known sequence) — no timer, no effect.
  //
  // Resume is the subtle path: a session carries `completed` + `excluded_ids` but
  // NOT the plan, so a cold resume re-scans (to re-derive the plan) and executes
  // with `resume=session` — core's filter_remaining drops already-completed items
  // by (kind,name,action), so no double-create even if the candidate set shifted.
  import Badge from "./ui/Badge.svelte";
  import Icon from "./ui/Icon.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import ReconcileView from "./ReconcileView.svelte";
  import { resource } from "../resource.svelte";
  import {
    bootstrapScan,
    bootstrapExecute,
    readBootstrapSession,
    clearBootstrapSession,
    LibraryApiError,
    type LibraryBootstrapScanResult,
    type LibraryBootstrapExecuteSummary,
    type LibraryBootstrapAction,
  } from "../api";
  import {
    classificationCue,
    bootstrapSkipReasonCue,
    bootstrapCommitCue,
    selectionKey,
    KIND_LABELS,
    type OrphanInstall,
  } from "../library";

  let {
    onClose,
    onImported,
    orphans,
    onForgotten,
  }: {
    onClose: () => void;
    /** Reload the primitives + drift reads after an import landed. */
    onImported: () => void;
    /** Orphaned install records for the Reconcile tab (parent-derived). */
    orphans: OrphanInstall[];
    /** Reload the driftBatch after a forget (re-derives the orphan list). */
    onForgotten: () => void;
  } = $props();

  type Tab = "bootstrap" | "reconcile";
  type Step = "start" | "review" | "result";
  let tab = $state<Tab>("bootstrap");
  let step = $state<Step>("start");

  // The resumable session — read once at mount (resource = the no-effect load).
  const sessionRes = resource("bootstrap:session", readBootstrapSession);

  let scanResult = $state<LibraryBootstrapScanResult | null>(null);
  let scanBusy = $state(false);
  let scanError = $state<string | null>(null);

  // Selection keys the user UNCHECKED in review → excluded. Default: everything
  // checked, so `excluded` empty means "import all".
  let excluded = $state<Set<string>>(new Set());

  let execBusy = $state(false);
  let execError = $state<string | null>(null);
  let result = $state<LibraryBootstrapExecuteSummary | null>(null);

  const SCAN_STAGES = ["Scanning install roots", "Deduplicating candidates", "Cross-referencing library state"];

  // The executable, frontend-filtered plan (raw action objects only) + the
  // excluded ids for the session bookkeeping.
  function filteredPlan(): { creates: Record<string, unknown>[]; reimports: Record<string, unknown>[] } {
    const keep = (a: LibraryBootstrapAction) => !excluded.has(selectionKey(a.kind, a.name));
    return {
      creates: (scanResult?.plan.creates ?? []).filter(keep).map((a) => a.raw),
      reimports: (scanResult?.plan.reimports ?? []).filter(keep).map((a) => a.raw),
    };
  }

  async function runScan(): Promise<LibraryBootstrapScanResult | null> {
    scanBusy = true;
    scanError = null;
    try {
      const r = await bootstrapScan();
      scanResult = r;
      excluded = new Set(); // reset selection on a fresh scan (don't execute a stale plan)
      return r;
    } catch (e) {
      scanError = messageFor(e, "Couldn’t scan your machine.");
      return null;
    } finally {
      scanBusy = false;
    }
  }

  async function doScan(): Promise<void> {
    const r = await runScan();
    if (r) step = "review";
  }

  function toggle(key: string): void {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    excluded = next;
  }

  async function execute(resume: Record<string, unknown> | null): Promise<void> {
    if (execBusy) return;
    execBusy = true;
    execError = null;
    try {
      const res = await bootstrapExecute({
        plan: filteredPlan(),
        resume,
        excluded_ids: [...excluded],
      });
      result = res;
      step = "result";
      onImported();
      sessionRes.reload(); // a partial run left a session; a clean one cleared it
    } catch (e) {
      execError = messageFor(e, "Couldn’t import the selected items.");
    } finally {
      execBusy = false;
    }
  }

  // Cold resume (from the start gate): re-scan to re-derive the plan, then execute
  // with the persisted session. filter_remaining skips already-done items.
  async function resumeFromGate(): Promise<void> {
    const session = sessionRes.data;
    if (!session) return;
    const r = await runScan();
    if (r) await execute(session.raw);
  }

  async function discardSession(): Promise<void> {
    if (execBusy) return;
    execBusy = true;
    try {
      await clearBootstrapSession();
      sessionRes.reload();
    } catch {
      // a failed clear is non-fatal — the user can still scan over it
    } finally {
      execBusy = false;
    }
  }

  // Resume the unresolved skips after the user fixed them (from the result step).
  async function resumeRemaining(): Promise<void> {
    const session = await readBootstrapSession();
    await execute(session?.raw ?? null);
  }

  function messageFor(e: unknown, fallback: string): string {
    if (e instanceof LibraryApiError) return `${fallback} (${e.code})`;
    return fallback;
  }

  function copyPath(path: string): void {
    void navigator.clipboard?.writeText(path);
  }

  // Derived display lists for the review step.
  const creates = $derived(scanResult?.plan.creates ?? []);
  const reimports = $derived(scanResult?.plan.reimports ?? []);
  const alreadyImported = $derived(
    (scanResult?.crossReferenced.groups ?? []).filter((g) => g.classification === "already_imported"),
  );
  const needsReview = $derived(scanResult?.crossReferenced.needs_manual_review ?? []);
  const selectedCount = $derived(creates.length + reimports.length - excluded.size);
</script>

<div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="bootstrap-title">
  <div class="wizard">
    <header class="wizard-head">
      <h3 id="bootstrap-title">Bootstrap from your machine</h3>
      <button type="button" class="close" title="Close" aria-label="Close" onclick={onClose}>
        <Icon name="x" size={16} />
      </button>
    </header>

    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={tab === "bootstrap"}
        aria-selected={tab === "bootstrap"}
        onclick={() => (tab = "bootstrap")}
      >
        Import
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={tab === "reconcile"}
        aria-selected={tab === "reconcile"}
        onclick={() => (tab = "reconcile")}
      >
        Reconcile{#if orphans.length}<span class="tab-badge">{orphans.length}</span>{/if}
      </button>
    </div>

    <div class="wizard-body">
      {#if tab === "reconcile"}
        <ReconcileView {orphans} {onForgotten} />
      {:else if step === "start"}
        <!-- Step 1: resume gate (if a session exists) or the scan CTA. -->
        {#if sessionRes.loading && !sessionRes.data}
          <div class="muted">Checking for an in-progress import…</div>
        {:else if sessionRes.data}
          <section class="gate" aria-label="Resume or discard the previous import">
            <p>
              An import started <strong>{sessionRes.data.startedAt}</strong> didn’t finish. Resume it (it skips items
              already imported), or discard it and start fresh.
            </p>
            <div class="gate-actions">
              <button type="button" class="act primary" disabled={execBusy || scanBusy} onclick={resumeFromGate}>
                {scanBusy || execBusy ? "Resuming…" : "Resume previous import"}
              </button>
              <button type="button" class="act" disabled={execBusy || scanBusy} onclick={discardSession}>
                Discard &amp; start fresh
              </button>
            </div>
            {#if scanError}<div class="route-notice warn" role="status">{scanError}</div>{/if}
            {#if execError}<div class="route-notice warn" role="status">{execError}</div>{/if}
          </section>
        {:else}
          <section class="scan-cta">
            <p>
              Scan <span class="mono">~/.claude</span>, <span class="mono">~/.pi</span>, and
              <span class="mono">~/.codex</span> for primitives not yet in your library, then choose what to import.
            </p>
            {#if scanBusy}
              <div class="scanning" role="status" aria-live="polite" aria-busy="true">
                <div class="scan-bar"><span></span></div>
                <ul class="scan-stages">
                  {#each SCAN_STAGES as s (s)}<li>{s}…</li>{/each}
                </ul>
              </div>
            {:else}
              <button type="button" class="act primary" onclick={doScan}>
                <Icon name="search" size={14} /> Scan my machine
              </button>
            {/if}
            {#if scanError}<div class="route-notice warn" role="status">{scanError}</div>{/if}
          </section>
        {/if}
      {:else if step === "review" && scanResult}
        <!-- Step 3: review the plan; deselect anything you don't want. -->
        {@const s = scanResult.crossReferenced.summary}
        <section class="review">
          <p class="banner">
            Found <strong>{s.new}</strong> new, <strong>{s.drifted}</strong> drifted,
            <strong>{s.already_imported}</strong> already imported, <strong>{s.needs_manual_review}</strong> need review.
          </p>

          {#if !creates.length && !reimports.length}
            <EmptyState
              icon="check"
              title="Nothing to import"
              message="Every primitive on your machine is already in the library (or needs manual review)."
            />
          {:else}
            <div class="action-groups">
              {#if creates.length}
                <h4>New — will be created at v1</h4>
                <ul class="action-list">
                  {#each creates as a (selectionKey(a.kind, a.name))}
                    {@const key = selectionKey(a.kind, a.name)}
                    {@const cue = classificationCue("new")}
                    <li class="action-row">
                      <label>
                        <input type="checkbox" checked={!excluded.has(key)} onchange={() => toggle(key)} />
                        <span class="action-name">{a.name}</span>
                        <Badge>{KIND_LABELS[a.kind]}</Badge>
                        <small class="cue cyan">{cue.glyph} {cue.label}</small>
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if reimports.length}
                <h4>Drifted — will be reimported as a new version</h4>
                <ul class="action-list">
                  {#each reimports as a (selectionKey(a.kind, a.name))}
                    {@const key = selectionKey(a.kind, a.name)}
                    {@const cue = classificationCue("drifted")}
                    <li class="action-row">
                      <label>
                        <input type="checkbox" checked={!excluded.has(key)} onchange={() => toggle(key)} />
                        <span class="action-name">{a.name}</span>
                        <Badge>{KIND_LABELS[a.kind]}</Badge>
                        <small class="cue amber">{cue.glyph} {cue.label}</small>
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}

          {#if alreadyImported.length || needsReview.length}
            <details class="info-rows">
              <summary>{alreadyImported.length + needsReview.length} found but not importable</summary>
              <ul class="action-list muted">
                {#each alreadyImported as g (selectionKey(g.kind, g.name))}
                  {@const cue = classificationCue("already_imported")}
                  <li class="action-row info">
                    <span class="action-name">{g.name}</span>
                    <Badge>{KIND_LABELS[g.kind]}</Badge>
                    <small class="cue">{cue.glyph} {cue.label}</small>
                  </li>
                {/each}
                {#each needsReview as g (selectionKey(g.kind, g.name))}
                  {@const cue = classificationCue("needs_review")}
                  <li class="action-row info">
                    <span class="action-name">{g.name}</span>
                    <Badge>{KIND_LABELS[g.kind]}</Badge>
                    <small class="cue">{cue.glyph} {cue.label}</small>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}

          {#if execError}<div class="route-notice warn" role="status">{execError}</div>{/if}

          <div class="review-actions">
            <button type="button" class="act" disabled={execBusy} onclick={() => (step = "start")}>Back</button>
            <button
              type="button"
              class="act primary"
              disabled={execBusy || selectedCount <= 0}
              onclick={() => execute(null)}
            >
              {execBusy ? "Importing…" : `Import ${selectedCount} ${selectedCount === 1 ? "item" : "items"}`}
            </button>
          </div>
        </section>
      {:else if step === "result" && result}
        <!-- Step 4: the result + a skipped section with per-reason remedies. -->
        {@const commit = bootstrapCommitCue(result.committed, result.commit_error)}
        {@const backupPath = result.backup_path}
        <section class="result">
          <p class="banner">
            Created <strong>{result.created}</strong>, reimported <strong>{result.reimported}</strong>.
            {#if result.created + result.reimported > 0}
              <small class="cue" class:amber={commit.tone === "amber"}>{commit.glyph} {commit.label}</small>
            {/if}
          </p>

          {#if backupPath}
            <div class="backup">
              A backup of your source dirs was written to
              <code class="mono">{backupPath}</code>
              <button type="button" class="copy" title="Copy path" onclick={() => copyPath(backupPath)}>
                <Icon name="copy" size={13} />
              </button>
            </div>
          {/if}

          {#if result.skipped > 0}
            <section class="skipped" aria-label="Skipped items">
              <h4>{result.skipped} skipped — needs a fix, then Resume</h4>
              <ul class="action-list">
                {#each result.skipped_items as item (item.kind + "/" + item.name + "/" + item.source_target)}
                  {@const cue = bootstrapSkipReasonCue(item.reason)}
                  <li class="action-row">
                    <span class="action-name">{item.name}</span>
                    <Badge>{KIND_LABELS[item.kind]}</Badge>
                    <code class="mono">{item.source_target}</code>
                    <small class="cue" class:amber={cue.tone === "amber"} class:cyan={cue.tone === "cyan"}>
                      {cue.glyph} {cue.label}
                    </small>
                  </li>
                {/each}
              </ul>
              {#if execError}<div class="route-notice warn" role="status">{execError}</div>{/if}
              <button type="button" class="act primary" disabled={execBusy} onclick={resumeRemaining}>
                {execBusy ? "Resuming…" : "Resume the skipped items"}
              </button>
            </section>
          {:else}
            <EmptyState icon="check" title="Import complete" message="Everything selected was imported." />
          {/if}

          <div class="review-actions">
            <button type="button" class="act primary" onclick={onClose}>Done</button>
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .wizard {
    background: var(--panel, #15151c);
    border: 1px solid var(--border, #2a2a33);
    border-radius: 10px;
    width: min(620px, 92vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .wizard-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border, #2a2a33);
  }
  .wizard-head h3 {
    margin: 0;
    font-size: 1rem;
  }
  .close {
    background: none;
    border: none;
    color: var(--text-muted, #9aa);
    cursor: pointer;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem 0;
    border-bottom: 1px solid var(--border, #2a2a33);
  }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted, #9aa);
    padding: 0.4rem 0.7rem;
    cursor: pointer;
    font-size: 0.86rem;
  }
  .tab.active {
    color: var(--text, #eee);
    border-bottom-color: var(--cue-cyan, #56b4e9);
  }
  .tab-badge {
    margin-left: 0.35rem;
    background: var(--cue-cyan, #56b4e9);
    color: #06121b;
    border-radius: 999px;
    padding: 0 0.4rem;
    font-size: 0.72rem;
    font-weight: 700;
  }
  .wizard-body {
    padding: 1rem;
    overflow-y: auto;
  }
  .muted {
    color: var(--text-muted, #9aa);
    font-size: 0.86rem;
  }
  .banner {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
  }
  .scanning {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .scan-bar {
    height: 4px;
    background: var(--border, #2a2a33);
    border-radius: 2px;
    overflow: hidden;
  }
  .scan-bar span {
    display: block;
    height: 100%;
    width: 40%;
    background: var(--cue-cyan, #56b4e9);
    animation: indeterminate 1.1s ease-in-out infinite;
  }
  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }
  .scan-stages {
    list-style: none;
    margin: 0;
    padding: 0;
    color: var(--text-muted, #9aa);
    font-size: 0.82rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .action-list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .action-row label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .action-row.info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    opacity: 0.85;
  }
  .action-name {
    font-weight: 600;
  }
  h4 {
    margin: 0.5rem 0 0.4rem;
    font-size: 0.82rem;
    color: var(--text-muted, #9aa);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cue {
    font-size: 0.76rem;
  }
  .cue.cyan {
    color: var(--cue-cyan, #56b4e9);
  }
  .cue.amber {
    color: var(--cue-amber, #e69f00);
  }
  .info-rows summary {
    cursor: pointer;
    color: var(--text-muted, #9aa);
    font-size: 0.82rem;
    margin-bottom: 0.4rem;
  }
  .backup {
    font-size: 0.8rem;
    color: var(--text-muted, #9aa);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
  }
  .copy {
    background: none;
    border: 1px solid var(--border, #2a2a33);
    border-radius: 4px;
    color: var(--text-muted, #9aa);
    cursor: pointer;
    padding: 0.1rem 0.3rem;
  }
  .gate-actions,
  .review-actions,
  .scan-cta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .review-actions {
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
  .act {
    border: 1px solid var(--border, #2a2a33);
    border-radius: 5px;
    padding: 0.4rem 0.75rem;
    background: none;
    color: var(--text, #ddd);
    cursor: pointer;
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .act.primary {
    border-color: var(--cue-cyan, #56b4e9);
    color: var(--cue-cyan, #56b4e9);
  }
  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mono {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.82em;
  }
  .route-notice {
    border-radius: 5px;
    padding: 0.4rem 0.6rem;
    font-size: 0.82rem;
    border: 1px solid var(--border, #2a2a33);
    margin: 0.5rem 0;
  }
  .route-notice.warn {
    border-color: var(--cue-amber, #e69f00);
  }
</style>
