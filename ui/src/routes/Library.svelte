<script lang="ts">
  // Production Library route (ADR-0007, Variant B — Explorer detail). Renders the
  // real /api/library/* read models: a left explorer grouped by Kind, a central
  // read-only Working-copy / Versions / allowed-Targets detail surface, and a
  // right status rail. Drift + per-target install records are out of v1 (Option
  // A / C2), so those cells/tabs are absent — not stubbed.
  import Badge from "../lib/components/ui/Badge.svelte";
  import Icon from "../lib/components/ui/Icon.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
  import WorkingFileEditor from "../lib/components/WorkingFileEditor.svelte";
  import { resource } from "../lib/resource.svelte";
  import {
    getLibraryStatus,
    getLibraryKindInfo,
    getLibraryTargetInfo,
    getLibraryPrimitives,
    getLibraryPrimitiveDetail,
    getInstallsForPrimitive,
    getDrift,
    getDriftBatch,
    installPrimitive,
    uninstallPrimitive,
    acknowledgeDrift,
    importInstalls,
    publishVersion,
    setCurrentVersion,
    revertToVersion,
    readPrimitiveVersion,
    LibraryApiError,
    type LibraryKind,
    type LibraryTarget,
    type LibraryInstallSummary,
    type LibraryUninstallSummary,
    type LibraryPublishResult,
    type WorkingContent,
  } from "../lib/api";
  import {
    filterPrimitives,
    groupByKind,
    selectionKey,
    parseSelection,
    dirtyCue,
    gitSummary,
    driftByTarget,
    installStateFor,
    stateCue,
    outcomeCue,
    uninstallCue,
    anyDrift,
    publishStateCue,
    currentVersionCue,
    KIND_LABELS,
  } from "../lib/library";

  // Status gates everything — the route always 200s, so error here means the
  // bridge itself is unreachable.
  const status = resource("library:status", getLibraryStatus);
  const valid = $derived(status.data?.is_valid === true);

  // Capability tables + the primitive list load only once the library is valid;
  // an "idle" key resolves to empty so we never hit the bridge while unconfigured.
  const gate = (k: string) => (valid ? k : "library:idle");
  const kindInfo = resource(
    () => gate("library:kind-info"),
    (k) => (k === "library:idle" ? Promise.resolve(null) : getLibraryKindInfo()),
  );
  const targetInfo = resource(
    () => gate("library:target-info"),
    (k) => (k === "library:idle" ? Promise.resolve(null) : getLibraryTargetInfo()),
  );
  const primitivesRes = resource(
    () => gate("library:primitives"),
    (k) => (k === "library:idle" ? Promise.resolve([]) : getLibraryPrimitives()),
  );

  let query = $state("");
  let selected = $state<string | null>(null);
  // Kind sections the user has explicitly expanded — empty by default, so every
  // section starts collapsed. An active filter force-opens groups (below) so
  // matches are never hidden behind a collapsed header.
  let expanded = $state<Set<string>>(new Set());

  const primitives = $derived(primitivesRes.data ?? []);
  const filtered = $derived(filterPrimitives(primitives, query));
  const groups = $derived(groupByKind(filtered));
  const filtering = $derived(query.trim() !== "");

  function isOpen(kind: string): boolean {
    return filtering || expanded.has(kind);
  }
  function toggle(kind: string): void {
    const next = new Set(expanded); // reassign — Svelte tracks the binding, not mutation
    next.has(kind) ? next.delete(kind) : next.add(kind);
    expanded = next;
  }

  // On-demand detail, keyed by the selected kind/name (ADR: detail loads per
  // selection, file bytes are not bundled into the list payload). No
  // auto-selection — with every section collapsed by default, the detail pane
  // invites the user to pick rather than showing a primitive from a hidden group.
  const detailRes = resource(
    () => selected ?? "library:none",
    (k) => {
      const sel = parseSelection(k);
      return sel ? getLibraryPrimitiveDetail(sel.kind, sel.name) : Promise.resolve(null);
    },
  );
  const detail = $derived(detailRes.data);

  function kindTone(kind: string): "accent" | "cyan" | "amber" | "default" {
    if (kind === "skill") return "accent";
    if (kind === "agent") return "cyan";
    if (kind === "codex_agent") return "amber";
    return "default"; // command — avoid green (CVD)
  }

  // ── install / drift (write-flow slice, ADR-0008) ──────────────────────────
  // Batch drift feeds the explorer badges and rides the 30s poll (dataEpoch).
  const driftBatchRes = resource(
    () => gate("library:drift"),
    (k) => (k === "library:idle" ? Promise.resolve([]) : getDriftBatch()),
  );
  const driftBatch = $derived(driftBatchRes.data ?? []);

  // Per-selection installs + per-primitive drift (D8: the per-primitive scan is
  // AUTHORITATIVE for the detail rows; the batch above is for explorer badges).
  const installsRes = resource(
    () => selected ?? "library:none",
    (k) => {
      const sel = parseSelection(k);
      return sel ? getInstallsForPrimitive(sel.kind, sel.name) : Promise.resolve([]);
    },
  );
  const driftDetailRes = resource(
    () => selected ?? "library:none",
    (k) => {
      const sel = parseSelection(k);
      return sel ? getDrift(sel.kind, sel.name) : Promise.resolve([]);
    },
  );
  const installs = $derived(installsRes.data ?? []);
  const driftDetail = $derived(driftDetailRes.data ?? []);
  const driftMap = $derived(
    detail ? driftByTarget(driftDetail, detail.kind, detail.name) : new Map(),
  );
  // One row per allowed target, folding install record + drift into a state.
  const targetRows = $derived(
    detail
      ? detail.metadata.allowed_targets.map((t) => ({
          target: t,
          state: installStateFor(t, installs, driftMap),
          installed: installs.find((i) => i.target === t) ?? null,
        }))
      : [],
  );

  // D2 — pending-write lock keyed (kind/name/target): disable a row's actions
  // while a write to it is in flight, and refuse a duplicate dispatch. Cleared in
  // `finally` so a rejected write never strands a row disabled.
  let pending = $state<Set<string>>(new Set());
  const writeKey = (kind: string, name: string, target: string) => `${kind}/${name}/${target}`;
  function isPending(kind: string, name: string, target: string): boolean {
    return pending.has(writeKey(kind, name, target));
  }
  function setPending(key: string, on: boolean): void {
    const next = new Set(pending);
    on ? next.add(key) : next.delete(key);
    pending = next;
  }

  // D2 — captured-intent snapshot. The dialog stores {action,kind,name,target,
  // conflicts} at open time; confirm re-issues the write reading ONLY the
  // snapshot (never the live selection), so a selection change or a 30s re-paint
  // across the confirm await can't redirect `force:true` at the wrong primitive.
  // A singleton ($state<…|null>) so dialogs can't stack/clobber.
  interface ConflictIntent {
    action: "install" | "uninstall";
    kind: LibraryKind;
    name: string;
    target: LibraryTarget;
    conflicts: string[];
  }
  let dialog = $state<ConflictIntent | null>(null);

  // Route-local notices (never the shell): per-target action feedback + a list of
  // pre-flight failures (D5 — rendered, never silently dropped).
  let notice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);
  let failures = $state<{ target: string; text: string }[]>([]);
  let importing = $state(false);
  let importNotice = $state<{ tone: "default" | "amber"; text: string } | null>(null);

  function reloadInstallState(): void {
    installsRes.reload();
    driftDetailRes.reload();
    driftBatchRes.reload(); // refresh explorer badges too
  }

  // W6 — after any successful working-file write, re-read the detail (its
  // `working` primary may have changed) and the primitive list (the `dirty` badge
  // recomputes). The editor owns its own working-files tree reload. Event-handler
  // driven `.reload()`, never an effect.
  function reloadAfterWorkingWrite(): void {
    detailRes.reload();
    primitivesRes.reload();
  }

  /** Map a route-local LibraryApiError to a friendly notice (detail is withheld
   *  server-side; we only ever see code + safe message). */
  function noticeFor(e: unknown, fallback: string): string {
    return e instanceof LibraryApiError ? e.message : fallback;
  }

  // ── versioning / publishing (versioning slice) ────────────────────────────
  // The editor instance — bound through the {#key} block. Its pull-based exports
  // let publish refuse stale (unsaved) bytes and let revert reseed the buffer,
  // both WITHOUT an effect-driven prop sync.
  let editorRef = $state<{
    hasUnsavedEdits(): boolean;
    applyWorking(w: WorkingContent): void;
  } | null>(null);

  let publishOpen = $state(false);
  let publishLabel = $state("");
  let publishNotes = $state("");
  let versionBusy = $state(false);
  // The PublishResult of the last publish/set-current — drives the commit-state
  // cue (committed / not-committed / no-commit). Cleared on a new action/selection.
  let publishResult = $state<LibraryPublishResult | null>(null);
  // Route-local version notices (label hint, save-first guard, route errors,
  // restore confirmation) — never the shell.
  let versionNotice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);

  // The inspected (frozen) version — lazily read per (selection, label). Reuses
  // resource() for loading/error, keyed so a label change refetches; resets to
  // closed (null label) whenever the selection changes (selectPrimitive).
  let inspectLabel = $state<string | null>(null);
  const inspectRes = resource(
    () => (selected && inspectLabel ? `inspect:${selected}@${inspectLabel}` : "library:none"),
    (k) => {
      if (k === "library:none") return Promise.resolve(null);
      const sel = parseSelection(selected ?? "");
      return sel && inspectLabel
        ? readPrimitiveVersion(sel.kind, sel.name, inspectLabel)
        : Promise.resolve(null);
    },
  );
  const inspectView = $derived(inspectRes.data);

  // Captured-intent revert confirm (mirrors the install conflict dialog, D2): the
  // dialog stores {kind,name,label} so a selection change across the confirm await
  // can't redirect the rewind at the wrong primitive.
  let revertDialog = $state<{ kind: LibraryKind; name: string; label: string } | null>(null);

  /** Select a primitive AND reset all version UI (inspector/publish form/cues) so
   *  a label or commit cue never leaks across primitives. */
  function selectPrimitive(key: string): void {
    selected = key;
    inspectLabel = null;
    publishOpen = false;
    publishLabel = "";
    publishNotes = "";
    publishResult = null;
    versionNotice = null;
  }

  /** Publish the SAVED working copy as a new immutable version. Refuses while the
   *  editor has unsaved edits (publish snapshots on-disk state, not the buffer)
   *  and validates the label shape client-side before the round-trip. */
  async function doPublish(): Promise<void> {
    if (!detail || versionBusy) return;
    versionNotice = null;
    publishResult = null;
    const label = publishLabel.trim();
    if (!/^v\d/.test(label)) {
      versionNotice = {
        tone: "amber",
        text: "A version label looks like v1, v2, or v1.0 — start with “v” and a number.",
      };
      return;
    }
    if (editorRef?.hasUnsavedEdits()) {
      versionNotice = {
        tone: "amber",
        text: "Save your edits in the editor first — publish snapshots the saved working copy.",
      };
      return;
    }
    versionBusy = true;
    try {
      const res = await publishVersion(detail.kind, detail.name, label, publishNotes.trim() || undefined);
      publishResult = res;
      publishOpen = false;
      publishLabel = "";
      publishNotes = "";
      detailRes.reload(); // versions + current_version + the dirty badge
      primitivesRes.reload();
    } catch (e) {
      versionNotice = { tone: "amber", text: noticeFor(e, "Couldn’t publish this version.") };
    } finally {
      versionBusy = false;
    }
  }

  /** Move the current pointer (what a FUTURE install reads). Distinct from a
   *  revert — it does NOT touch the working copy. */
  async function doSetCurrent(label: string): Promise<void> {
    if (!detail || versionBusy) return;
    versionNotice = null;
    publishResult = null;
    versionBusy = true;
    try {
      const res = await setCurrentVersion(detail.kind, detail.name, label);
      publishResult = res;
      detailRes.reload(); // current_version + dirty
      reloadInstallState(); // the install section gates on current_version
    } catch (e) {
      versionNotice = { tone: "amber", text: noticeFor(e, "Couldn’t set the current version.") };
    } finally {
      versionBusy = false;
    }
  }

  /** Open the captured-intent confirm for a working-copy restore (it discards
   *  uncommitted working edits, so it's destructive-adjacent — two-phase). */
  function askRevert(label: string): void {
    if (!detail) return;
    revertDialog = { kind: detail.kind, name: detail.name, label };
  }

  async function confirmRevert(): Promise<void> {
    const intent = revertDialog;
    if (!intent || versionBusy) return;
    revertDialog = null;
    versionNotice = null;
    publishResult = null;
    versionBusy = true;
    try {
      await revertToVersion(intent.kind, intent.name, intent.label);
      // Reseed the open editor buffer from the reverted working copy — fetch fresh
      // detail directly so the reseed is deterministic regardless of resource
      // reload timing (the buffer never tracks the `working` prop — W5).
      const fresh = await getLibraryPrimitiveDetail(intent.kind, intent.name);
      editorRef?.applyWorking(fresh.working);
      detailRes.reload(); // keep the resource (working/dirty) consistent
      primitivesRes.reload();
      versionNotice = { tone: "default", text: `Working copy restored from ${intent.label}.` };
    } catch (e) {
      versionNotice = { tone: "amber", text: noticeFor(e, "Couldn’t restore the working copy.") };
    } finally {
      versionBusy = false;
    }
  }

  /** Display text for a frozen version's primary (fenced for md, raw for toml). */
  function versionDisplayText(w: WorkingContent): string {
    return w.kind === "md" ? `---\n${w.frontmatter}---\n${w.body}` : w.text;
  }

  async function doInstall(
    kind: LibraryKind,
    name: string,
    target: LibraryTarget,
    force = false,
  ): Promise<void> {
    const key = writeKey(kind, name, target);
    if (pending.has(key)) return; // refuse a duplicate dispatch
    setPending(key, true);
    try {
      const summary = await installPrimitive(kind, name, { targets: [target], force });
      applyInstallSummary(kind, name, target, summary, force);
    } catch (e) {
      notice = { tone: "amber", text: noticeFor(e, "install failed") };
    } finally {
      setPending(key, false);
      reloadInstallState();
    }
  }

  function applyInstallSummary(
    kind: LibraryKind,
    name: string,
    target: LibraryTarget,
    summary: LibraryInstallSummary,
    forced: boolean,
  ): void {
    // D5 — render pre-flight failures for this target (occupied/io/other). These
    // are NOT overwrite-able: never offer the confirm dialog on them.
    const failure = summary.failures.find((f) => f.target === target);
    if (failure) {
      const r = failure.reason;
      const text =
        r.kind === "occupied_by_unexpected_kind"
          ? `${target}: a ${r.actual} occupies the install path (expected ${r.expected}) — resolve on disk`
          : r.kind === "io"
            ? `${target}: ${r.message}`
            : `${target}: ${r.message}`;
      failures = [{ target, text }];
      return;
    }
    failures = [];
    const result = summary.successes.find((s) => s.target === target);
    if (!result) return;
    const outcome = result.outcome;
    // colliding_content + not yet forced → open the two-phase confirm dialog
    // (D5: scoped to THIS target only). Otherwise show the outcome cue.
    if (outcome.kind === "colliding_content" && !forced) {
      dialog = { action: "install", kind, name, target, conflicts: outcome.conflicts };
      return;
    }
    const cue = outcomeCue(outcome);
    notice = { tone: cue.tone, text: `${target}: ${cue.label}` };
  }

  async function doUninstall(
    kind: LibraryKind,
    name: string,
    target: LibraryTarget,
    force = false,
  ): Promise<void> {
    const key = writeKey(kind, name, target);
    if (pending.has(key)) return;
    setPending(key, true);
    try {
      const summary = await uninstallPrimitive(kind, name, { targets: [target], force });
      applyUninstallSummary(kind, name, target, summary, force);
    } catch (e) {
      notice = { tone: "amber", text: noticeFor(e, "uninstall failed") };
    } finally {
      setPending(key, false);
      reloadInstallState();
    }
  }

  function applyUninstallSummary(
    kind: LibraryKind,
    name: string,
    target: LibraryTarget,
    summary: LibraryUninstallSummary,
    forced: boolean,
  ): void {
    const failure = summary.failures.find((f) => f.target === target);
    if (failure) {
      failures = [{ target, text: `${target}: ${failure.reason.kind}` }];
      return;
    }
    failures = [];
    const result = summary.successes.find((s) => s.target === target);
    if (!result) return;
    const outcome = result.outcome;
    if (outcome.kind === "drifted" && !forced) {
      dialog = { action: "uninstall", kind, name, target, conflicts: outcome.conflicts };
      return;
    }
    const cue = uninstallCue(outcome);
    notice = { tone: cue.tone, text: `${target}: ${cue.label}` };
  }

  // Confirm reads ONLY the snapshot (D2) — never the live selection.
  async function confirmConflict(): Promise<void> {
    const intent = dialog;
    if (!intent) return;
    dialog = null;
    if (intent.action === "install") {
      await doInstall(intent.kind, intent.name, intent.target, true);
    } else {
      await doUninstall(intent.kind, intent.name, intent.target, true);
    }
  }
  function cancelConflict(): void {
    dialog = null;
  }

  async function doAcknowledge(
    kind: LibraryKind,
    name: string,
    target: LibraryTarget,
  ): Promise<void> {
    const key = writeKey(kind, name, target);
    if (pending.has(key)) return;
    setPending(key, true);
    try {
      await acknowledgeDrift(kind, name, target);
      notice = { tone: "default", text: `${target}: adopted current contents as truth` };
    } catch (e) {
      notice = { tone: "amber", text: noticeFor(e, "acknowledge failed") };
    } finally {
      setPending(key, false);
      reloadInstallState();
    }
  }

  async function doImport(): Promise<void> {
    if (importing) return;
    importing = true;
    importNotice = null;
    try {
      const r = await importInstalls();
      importNotice = { tone: "default", text: `Imported ${r.imported} install record(s).` };
      reloadInstallState();
    } catch (e) {
      const text =
        e instanceof LibraryApiError
          ? e.code === "installs_already_present"
            ? "Already imported — the dashboard ledger is in use."
            : e.code === "installs_format_mismatch"
              ? "Source format differs from this build — upgrade the dashboard."
              : e.message
          : "Import failed.";
      importNotice = { tone: "amber", text };
    } finally {
      importing = false;
    }
  }
</script>

<div class="library">
  {#if status.loading && !status.data}
    <div class="muted">Loading…</div>
  {:else if status.error}
    <div class="panel pad">
      <EmptyState
        icon="book-open"
        title="Library unavailable"
        error={true}
        onRetry={status.reload}
      />
    </div>
  {:else if status.data?.unavailable}
    <div class="panel pad">
      <EmptyState icon="alert" title="Library bridge unavailable">
        {#if status.data.unavailable.code === "bridge_not_found"}
          The library bridge binary isn’t built. Run <code>cargo build</code> in the
          repo root to compile it, then reload.
        {:else}
          The library bridge couldn’t respond ({status.data.unavailable.message}).
        {/if}
        <div class="retry-row">
          <button type="button" class="retry-btn" onclick={status.reload}>Reload</button>
        </div>
      </EmptyState>
    </div>
  {:else if !status.data?.configured}
    <div class="panel pad">
      <EmptyState icon="book-open" title="No library configured">
        Set <code>library_path</code> in <code>config/library.yaml</code> (or the
        <code>CC_LIBRARY_PATH</code> env override) to a directory containing a
        <code>.prompt-library</code> marker, then reload.
      </EmptyState>
    </div>
  {:else if !valid}
    <div class="panel pad">
      <EmptyState icon="alert" title="Not a prompt-library directory">
        The configured <code>library_path</code> exists but has no
        <code>.prompt-library</code> marker. Point it at a real library directory,
        then reload.
      </EmptyState>
    </div>
  {:else}
    <div class="state-strip">
      <span class="mono">prompt library</span>
      <span>{primitives.length} primitives</span>
      <span>{gitSummary(status.data)}</span>
      <button
        type="button"
        class="import-btn"
        onclick={doImport}
        disabled={importing}
        title="Copy the standalone app’s install records into the dashboard (one-time, idempotent)"
      >
        <Icon name="database" size={13} />
        {importing ? "Importing…" : "Import existing installs"}
      </button>
    </div>
    {#if importNotice}
      <div class="route-notice" class:warn={importNotice.tone === "amber"} role="status">
        {importNotice.text}
      </div>
    {/if}

    <section class="explorer-detail">
      <!-- Left: grouped explorer -->
      <aside class="explorer panel">
        <div class="panel-head">
          <h3>Library</h3>
          <Badge>{filtered.length} items</Badge>
        </div>
        <label class="search">
          <Icon name="search" size={14} />
          <input type="text" bind:value={query} placeholder="Filter primitives" />
        </label>

        {#if primitivesRes.loading && !primitivesRes.data}
          <div class="muted">Loading…</div>
        {:else if !primitives.length}
          <EmptyState icon="box" title="Library is empty" message="No primitives found in this library yet." error={primitivesRes.error} onRetry={primitivesRes.reload} />
        {:else if !filtered.length}
          <EmptyState icon="search" title="No matches" message={`Nothing matches “${query}”.`} />
        {:else}
          <div class="kind-groups">
            {#each groups as group (group.kind)}
              {@const open = isOpen(group.kind)}
              <section>
                <button
                  type="button"
                  class="group-head"
                  aria-expanded={open}
                  onclick={() => toggle(group.kind)}
                >
                  <span class="group-label">
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={13} />
                    {group.label}
                  </span>
                  <span class="group-count">{group.items.length}</span>
                </button>
                {#if open}
                  <div class="group-items">
                    {#each group.items as p (p.kind + "/" + p.name)}
                      {@const key = selectionKey(p.kind, p.name)}
                      {@const cue = dirtyCue(p.dirty)}
                      {@const drifted = anyDrift(driftBatch, p.kind, p.name)}
                      <button
                        type="button"
                        class="item"
                        class:selected={selected === key}
                        onclick={() => selectPrimitive(key)}
                      >
                        <span class="item-name">{p.name}</span>
                        {#if drifted}
                          <small class="cue drift" title="an installed target has drifted">● drift</small>
                        {:else if p.dirty}
                          <small class="cue" title={cue.label}>{cue.glyph} {cue.label}</small>
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      </aside>

      <!-- Center: read-only detail -->
      <main class="document panel">
        {#if detailRes.loading && !detailRes.data}
          <div class="muted">Loading…</div>
        {:else if detailRes.error}
          <EmptyState icon="file-text" title="Couldn’t load primitive" error={true} onRetry={detailRes.reload} />
        {:else if detail}
          {@const headCue = dirtyCue(primitives.find((p) => p.kind === detail.kind && p.name === detail.name)?.dirty ?? false)}
          <header>
            <div>
              <div class="doc-title">
                <Icon name="file-text" size={18} />
                <h2>{detail.name}</h2>
                <Badge tone={kindTone(detail.kind)}>{KIND_LABELS[detail.kind]}</Badge>
              </div>
              {#if detail.metadata.display_name}
                <p>{detail.metadata.display_name}</p>
              {/if}
            </div>
            <Badge tone={headCue.tone}>{headCue.glyph} {headCue.label}</Badge>
          </header>

          <div class="doc-tabs">
            <span class="active">Working copy</span>
            <span>Versions</span>
            <span>Targets</span>
          </div>

          <!-- The editor is keyed on the selected primitive so it REMOUNTS on
               selection change — the no-useEffect state reset (buffer/baseline/
               selection hydrate fresh at init, never via an effect). -->
          {#key detail.kind + "/" + detail.name}
            <WorkingFileEditor
              bind:this={editorRef}
              kind={detail.kind}
              name={detail.name}
              working={detail.working}
              onWrite={reloadAfterWorkingWrite}
            />
          {/key}

          <div class="versions">
            <div class="versions-head">
              <h4>Versions</h4>
              <button type="button" class="act" disabled={versionBusy} onclick={() => (publishOpen = !publishOpen)}>
                {publishOpen ? "Cancel" : "Publish version"}
              </button>
            </div>

            {#if publishOpen}
              <div class="publish-form">
                <label>
                  <span>Version label</span>
                  <input
                    class="mono"
                    type="text"
                    placeholder="v1"
                    bind:value={publishLabel}
                    disabled={versionBusy}
                  />
                </label>
                <label>
                  <span>Release notes <em>(optional)</em></span>
                  <textarea rows="2" bind:value={publishNotes} disabled={versionBusy}></textarea>
                </label>
                <div class="publish-actions">
                  <button type="button" class="act primary" disabled={versionBusy} onclick={doPublish}>
                    {versionBusy ? "Publishing…" : "Publish"}
                  </button>
                  <small class="muted-line">Snapshots the saved working copy, then commits.</small>
                </div>
              </div>
            {/if}

            {#if publishResult}
              {@const pc = publishStateCue(publishResult.committed, publishResult.commit_error)}
              <div class="publish-result" class:warn={pc.tone === "amber"} role="status">
                <Badge tone={pc.tone}>{pc.glyph} {pc.label}</Badge>
                {#if publishResult.commit_error}
                  <p class="commit-error">
                    The version was published, but the git commit failed — set <code>user.email</code> in
                    the library repo, then it commits on the next publish.
                  </p>
                  <pre class="commit-error-detail">{publishResult.commit_error}</pre>
                {/if}
              </div>
            {/if}

            {#if detail.versions.length}
              <div class="version-strip">
                {#each detail.versions as v (v)}
                  {@const vc = currentVersionCue(v, detail.current_version)}
                  <button
                    type="button"
                    class="version-chip"
                    class:current={v === detail.current_version}
                    class:active={v === inspectLabel}
                    title={vc.label}
                    onclick={() => (inspectLabel = inspectLabel === v ? null : v)}
                  >
                    <span class="mono">{v}</span>
                    {#if v === detail.current_version}<span class="chip-glyph">{vc.glyph}</span>{/if}
                  </button>
                {/each}
              </div>
            {:else}
              <p class="muted-line">No published versions yet — working copy only.</p>
            {/if}

            {#if versionNotice}
              <div class="route-notice" class:warn={versionNotice.tone === "amber"} role="status">
                {versionNotice.text}
              </div>
            {/if}

            {#if inspectLabel}
              {@const ic = currentVersionCue(inspectLabel, detail.current_version)}
              <div class="version-inspector">
                <div class="inspector-head">
                  <span class="mono">{inspectLabel}</span>
                  <Badge tone={ic.tone}>{ic.glyph} {ic.label}</Badge>
                  <button type="button" class="link-btn" onclick={() => (inspectLabel = null)}>Close</button>
                </div>
                {#if inspectRes.loading && !inspectView}
                  <div class="muted">Loading…</div>
                {:else if inspectRes.error}
                  <EmptyState icon="file-text" title="Couldn’t read this version" error={true} onRetry={inspectRes.reload} />
                {:else if inspectView}
                  <div class="inspector-meta">
                    <span>Created {inspectView.metadata.created_at.slice(0, 10)}</span>
                    {#if inspectView.metadata.notes}<span class="notes">“{inspectView.metadata.notes}”</span>{/if}
                  </div>
                  <pre class="frozen mono">{versionDisplayText(inspectView.working)}</pre>
                  <div class="inspector-actions">
                    {#if inspectLabel !== detail.current_version}
                      <button type="button" class="act" disabled={versionBusy} onclick={() => doSetCurrent(inspectLabel!)}>
                        Set as current
                      </button>
                    {/if}
                    <button type="button" class="act danger" disabled={versionBusy} onclick={() => askRevert(inspectLabel!)}>
                      Restore working copy
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Per-target install rows: compose allowed_targets × installs × drift.
               Install/Update with force:false; a colliding/drifted response opens
               the two-phase confirm. -->
          <div class="targets-section">
            <h4>Install targets</h4>
            {#if !detail.metadata.allowed_targets.length}
              <p class="muted-line">No allowed targets set for this primitive.</p>
            {:else if !detail.current_version}
              <p class="muted-line">No published version to install — snapshot a version first.</p>
            {:else}
              <div class="target-rows">
                {#each targetRows as row (row.target)}
                  {@const cue = stateCue(row.state)}
                  {@const busy = isPending(detail.kind, detail.name, row.target)}
                  <div class="target-row" data-target={row.target}>
                    <span class="target-name mono">{row.target}</span>
                    <Badge tone={cue.tone}>{cue.glyph} {cue.label}</Badge>
                    <span class="target-ver">{row.installed ? `v${row.installed.installed_version}` : ""}</span>
                    <div class="row-actions">
                      {#if row.state === "not_installed"}
                        <button type="button" class="act" disabled={busy} onclick={() => doInstall(detail.kind, detail.name, row.target)}>Install</button>
                      {:else}
                        <button type="button" class="act" disabled={busy} onclick={() => doInstall(detail.kind, detail.name, row.target)}>Update</button>
                        {#if row.state === "modified"}
                          <button type="button" class="act" disabled={busy} onclick={() => doAcknowledge(detail.kind, detail.name, row.target)}>Acknowledge</button>
                        {/if}
                        <button type="button" class="act danger" disabled={busy} onclick={() => doUninstall(detail.kind, detail.name, row.target)}>Uninstall</button>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            {#if notice}
              <div class="route-notice" class:warn={notice.tone === "amber"} role="status">{notice.text}</div>
            {/if}
            {#if failures.length}
              <ul class="failure-list">
                {#each failures as f (f.target)}
                  <li>{f.text}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else}
          <EmptyState icon="file-text" title="Select a primitive" message="Choose a primitive from the explorer to view its working copy." />
        {/if}
      </main>

      <!-- Right: read-only status rail -->
      <aside class="rail panel">
        <h3>Read-only status</h3>
        {#if detail}
          <div class="rail-stack">
            <div>
              <span>Allowed targets</span>
              <strong>{detail.metadata.allowed_targets.length ? detail.metadata.allowed_targets.join(" / ") : "none set"}</strong>
            </div>
            <div>
              <span>Current version</span>
              <strong>{detail.current_version ?? "—"}</strong>
            </div>
            <div>
              <span>Author</span>
              <strong>{detail.metadata.author ?? "—"}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{detail.metadata.created_at.slice(0, 10)}</strong>
            </div>
            {#if detail.metadata.source_url}
              <div>
                <span>Source</span>
                <strong class="truncate">{detail.metadata.source_url}</strong>
              </div>
            {/if}
          </div>
        {/if}
        <div class="rail-git">
          <span><Icon name="git-branch" size={13} /> Git</span>
          <strong>{gitSummary(status.data)}</strong>
        </div>
        {#if targetInfo.data}
          <p class="rail-foot">Targets: {targetInfo.data.targets.map((t) => t.target).join(" / ")}</p>
        {/if}
      </aside>
    </section>
  {/if}

  <!-- Two-phase confirm. Renders the CAPTURED snapshot (name/target/conflicts),
       so what the user sees is exactly what `force:true` will overwrite (D2). -->
  {#if dialog}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div class="dialog">
        <h3 id="conflict-title">
          {dialog.action === "install" ? "Overwrite drifted files?" : "Remove drifted install?"}
        </h3>
        <p>
          {dialog.action === "install" ? "Installing" : "Uninstalling"}
          <strong>{dialog.name}</strong> → <strong class="mono">{dialog.target}</strong>
          {dialog.action === "install"
            ? "would overwrite on-disk files that differ from this primitive:"
            : "would delete on-disk files that differ from the recorded install:"}
        </p>
        <ul class="conflict-list">
          {#each dialog.conflicts as path (path)}
            <li class="mono">{path}</li>
          {/each}
        </ul>
        <p class="dialog-warn">This replaces the current on-disk contents. There is no backup.</p>
        <div class="dialog-actions">
          <button type="button" class="act" onclick={cancelConflict}>Cancel</button>
          <button type="button" class="act danger" onclick={confirmConflict}>
            {dialog.action === "install" ? "Overwrite" : "Remove anyway"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Restore-working-copy confirm. Captured-intent {kind,name,label} (D2). The
       rewind discards uncommitted working edits, so it's two-phase. -->
  {#if revertDialog}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="revert-title">
      <div class="dialog">
        <h3 id="revert-title">Restore working copy?</h3>
        <p>
          This overwrites the working copy of <strong>{revertDialog.name}</strong> with the contents of
          <strong class="mono">{revertDialog.label}</strong>, deleting any files added since that version.
        </p>
        <p class="dialog-warn">Uncommitted edits in the working copy are discarded. There is no backup.</p>
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (revertDialog = null)}>Cancel</button>
          <button type="button" class="act danger" disabled={versionBusy} onclick={confirmRevert}>
            Restore from {revertDialog.label}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .library {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .muted {
    color: var(--text-dim);
    font-size: 12.5px;
    padding: 12px 2px;
  }
  .muted-line {
    margin: 8px 0 0;
    color: var(--text-subtle);
    font-size: 12px;
  }
  .retry-row {
    margin-top: 12px;
  }
  .retry-btn {
    padding: 5px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
  }
  .retry-btn:hover {
    border-color: var(--border-glow);
  }
  .panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  .pad {
    padding: 16px;
  }
  .state-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-2) 74%, transparent);
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .state-strip span {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 0 8px;
    border-right: 1px solid var(--border);
  }
  .state-strip span:last-child {
    border-right: none;
  }
  .explorer-detail {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr) 230px;
    gap: 14px;
    align-items: start;
  }
  .explorer,
  .document,
  .rail {
    padding: 16px;
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .panel-head h3,
  .rail h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-subtle);
  }
  .search input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
  }
  .kind-groups {
    display: grid;
    gap: 6px;
    margin-top: 16px;
  }
  .versions h4 {
    margin: 0 0 7px;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  /* Collapsible Kind section header — click to expand/collapse. */
  .group-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 6px;
    border-radius: 7px;
    color: var(--text-subtle);
    text-align: left;
  }
  .group-head:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .group-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .group-count {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .group-items {
    display: grid;
    gap: 2px;
    margin: 2px 0 4px;
  }
  .group-items .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    padding-left: 19px;
    border-radius: 7px;
    color: var(--text-dim);
    text-align: left;
  }
  .group-items .item:hover,
  .group-items .item.selected {
    background: var(--surface-2);
    color: var(--text);
  }
  .item-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cue {
    color: var(--amber);
    font-family: var(--font-mono);
    font-size: 10px;
    white-space: nowrap;
  }
  .document header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .document h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
  }
  .document p {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }
  .doc-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .doc-tabs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .doc-tabs span {
    padding: 8px 9px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .doc-tabs .active {
    color: var(--accent-from);
    border-bottom: 1px solid var(--accent-from);
  }
  /* The working-copy view is now the WorkingFileEditor component (owns its own
     .file-frame styles); the read-only <pre> + its file-head styles were removed. */
  .versions {
    margin-top: 14px;
  }
  .versions-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .version-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .version-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
  }
  .version-chip:hover {
    border-color: var(--text-subtle);
  }
  /* "current" uses cyan + a weight bump, not green (CVD). */
  .version-chip.current {
    color: var(--cyan, var(--accent-from));
    font-weight: 650;
    border-color: color-mix(in srgb, var(--accent-from) 40%, var(--border));
  }
  .version-chip.active {
    background: color-mix(in srgb, var(--accent-from) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-from) 45%, var(--border));
  }
  .version-chip .chip-glyph {
    font-size: 10px;
  }
  .publish-form {
    display: grid;
    gap: 8px;
    margin: 10px 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .publish-form label {
    display: grid;
    gap: 4px;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .publish-form label em {
    color: var(--text-dim);
    font-style: normal;
  }
  .publish-form input,
  .publish-form textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-inset, transparent);
    color: var(--text);
    font-size: 12px;
  }
  .publish-form textarea {
    resize: vertical;
    font-family: inherit;
  }
  .publish-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .publish-result {
    display: grid;
    gap: 6px;
    margin: 10px 0;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .publish-result.warn {
    border-color: color-mix(in srgb, var(--amber, #d08b00) 50%, var(--border));
    background: color-mix(in srgb, var(--amber, #d08b00) 8%, transparent);
  }
  .commit-error {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .commit-error-detail {
    margin: 0;
    padding: 7px 9px;
    border-radius: 6px;
    background: var(--bg-inset, rgba(0, 0, 0, 0.18));
    color: var(--text-dim);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-x: auto;
  }
  .version-inspector {
    margin-top: 12px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .inspector-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .inspector-head .link-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 11.5px;
    cursor: pointer;
    text-decoration: underline;
  }
  .inspector-meta {
    display: flex;
    gap: 12px;
    margin: 8px 0;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .inspector-meta .notes {
    color: var(--text-dim);
    font-style: italic;
  }
  .frozen {
    max-height: 220px;
    overflow: auto;
    margin: 0 0 10px;
    padding: 9px 11px;
    border-radius: 6px;
    background: var(--bg-inset, rgba(0, 0, 0, 0.18));
    color: var(--text-dim);
    font-size: 11.5px;
    white-space: pre-wrap;
  }
  .inspector-actions {
    display: flex;
    gap: 8px;
  }
  .act.primary {
    border-color: color-mix(in srgb, var(--accent-from) 55%, var(--border));
    color: var(--accent-from);
  }
  .rail-stack {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }
  .rail-stack div,
  .rail-git {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }
  .rail-stack span,
  .rail-git span {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .rail-stack strong,
  .rail-git strong {
    color: var(--text);
    font-size: 12px;
    text-align: right;
  }
  .rail-git {
    margin-top: 10px;
  }
  .truncate {
    min-width: 0;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail-foot {
    margin: 12px 0 0;
    color: var(--text-subtle);
    font-size: 11px;
  }
  /* drift dot in the explorer — cyan/amber, never green (CVD) */
  .cue.drift {
    color: var(--amber);
  }
  .import-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 11px;
  }
  .import-btn:hover:not(:disabled) {
    border-color: var(--border-glow);
  }
  .import-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* state-strip's last-child border rule would clip the button — opt out */
  .state-strip .import-btn {
    border-right: 1px solid var(--border);
  }
  .route-notice {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--cyan, var(--accent-from));
    border-radius: 6px;
    background: color-mix(in srgb, var(--surface-2) 70%, transparent);
    color: var(--text);
    font-size: 12px;
  }
  .route-notice.warn {
    border-left-color: var(--amber);
  }
  .targets-section {
    margin-top: 16px;
    display: grid;
    gap: 8px;
  }
  .targets-section h4 {
    margin: 0 0 2px;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .target-rows {
    display: grid;
    gap: 6px;
  }
  .target-row {
    display: grid;
    grid-template-columns: 64px auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 80%, transparent);
  }
  .target-name {
    font-size: 12px;
    color: var(--text);
  }
  .target-ver {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .row-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .act {
    padding: 4px 11px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 11.5px;
  }
  .act:hover:not(:disabled) {
    border-color: var(--border-glow);
  }
  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* "danger" is amber-bordered, NOT red (Scott is red/green colorblind). */
  .act.danger {
    border-color: color-mix(in srgb, var(--amber) 55%, var(--border));
    color: var(--amber);
  }
  .failure-list {
    margin: 4px 0 0;
    padding-left: 18px;
    color: var(--amber);
    font-size: 11.5px;
  }
  .dialog-scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }
  .dialog {
    width: min(460px, 100%);
    padding: 18px;
    border: 1px solid var(--border-glow, var(--border));
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  .dialog h3 {
    margin: 0 0 10px;
    font-size: 15px;
    font-weight: 650;
  }
  .dialog p {
    margin: 0 0 10px;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .conflict-list {
    margin: 0 0 10px;
    padding: 8px 10px 8px 26px;
    max-height: 160px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .dialog-warn {
    color: var(--amber);
    font-size: 12px;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  @media (max-width: 1120px) {
    .explorer-detail {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
  }
</style>
