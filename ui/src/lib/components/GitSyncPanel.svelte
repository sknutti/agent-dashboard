<script lang="ts">
  // Git remote sync panel (Slice 8) — the ONLY surface in the dashboard that
  // egresses. Configure a remote + PAT, see the unpushed count, push (gated by a
  // secret scan the user must review — D4), and pull (which may drop into the
  // conflict resolver). Rendered as a modal the Library route mounts.
  //
  // Secret discipline (D6): the PAT input is write-only — type=password, never
  // bound to a displayed value, submitted then cleared. The panel only ever shows
  // `pat_redacted` from the status read; the raw token never round-trips back.
  //
  // No useEffect: status + unpushed-count are resource() reads (mount-load + a
  // poll refresh); every push/pull/save is an event handler that reloads the
  // relevant resource after it lands. The URL/PAT inputs are NOT pre-filled from
  // the async status (which would fight the poll) — the current values render as
  // labels; the inputs are for *changing* them.
  import { Icon, IconButton, Button, Input, Badge } from "./ui";
  import ConflictResolver from "./ConflictResolver.svelte";
  import { resource } from "../resource.svelte";
  import {
    getGitStatus,
    getUnpushedCount,
    configureRemote,
    setRemotePat,
    deleteRemotePat,
    scanBeforePush,
    gitPush,
    gitPull,
    LibraryApiError,
    type LibraryScanFinding,
  } from "../api";
  import { pushGateCue, syncStateCue } from "../library";

  let {
    libraryPath,
    onClose,
    onChanged,
  }: {
    libraryPath: string | null;
    onClose: () => void;
    /** Reload the rail's git summary after a push/pull/config change. */
    onChanged: () => void;
  } = $props();

  const status = resource("git:status", getGitStatus);
  const unpushed = resource("git:unpushed", getUnpushedCount);

  const remoteConfigured = $derived(!!status.data?.remote_url);
  const patStored = $derived(!!status.data?.pat_redacted);
  const unpushedCount = $derived(unpushed.data?.count ?? 0);

  let urlInput = $state("");
  let patInput = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let urlError = $state<string | null>(null);
  // null = no scan run; [] = scanned clean; [...] = findings awaiting confirm.
  let findings = $state<LibraryScanFinding[] | null>(null);
  let conflictMode = $state(false);

  const syncCue = $derived(syncStateCue(unpushedCount, conflictMode));

  function reloadAll() {
    status.reload();
    unpushed.reload();
    onChanged();
  }

  async function saveRemote() {
    if (busy || !urlInput.trim()) return;
    busy = true;
    error = null;
    urlError = null;
    try {
      await configureRemote(urlInput.trim());
      urlInput = "";
      reloadAll();
    } catch (e) {
      if (e instanceof LibraryApiError && e.code === "invalid_remote_url") urlError = e.message;
      else error = e instanceof LibraryApiError ? e.message : "could not configure the remote";
    } finally {
      busy = false;
    }
  }

  async function savePat() {
    if (busy || !patInput) return;
    busy = true;
    error = null;
    try {
      await setRemotePat(patInput);
      patInput = ""; // never keep the raw token around
      status.reload();
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not store the token";
    } finally {
      busy = false;
    }
  }

  async function removePat() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await deleteRemotePat();
      status.reload();
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not remove the token";
    } finally {
      busy = false;
    }
  }

  // Push is two-step: scan first (the gate), surface findings, push only after an
  // explicit confirm (D4). A clean scan pushes straight through.
  async function startPush() {
    if (busy) return;
    busy = true;
    error = null;
    findings = null;
    try {
      const found = await scanBeforePush();
      if (found.length > 0) {
        findings = found; // hold for the confirm step — do NOT push
      } else {
        await doPush();
      }
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not scan before pushing";
    } finally {
      busy = false;
    }
  }

  async function doPush() {
    busy = true;
    error = null;
    try {
      await gitPush();
      findings = null;
      reloadAll();
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "push failed";
    } finally {
      busy = false;
    }
  }

  async function startPull() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const r = await gitPull();
      if (r.outcome === "conflict") {
        conflictMode = true;
      } else {
        reloadAll();
      }
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "pull failed";
    } finally {
      busy = false;
    }
  }

  function exitConflict() {
    conflictMode = false;
    reloadAll();
  }
</script>

<div class="scrim" role="dialog" aria-modal="true" aria-labelledby="git-sync-title">
  <div class="panel">
    <header class="panel-head">
      <h3 id="git-sync-title"><Icon name="git-branch" size={15} /> Git sync</h3>
      <IconButton icon="x" label="Close" variant="ghost" onclick={onClose} />
    </header>

    {#if conflictMode}
      <ConflictResolver {libraryPath} onResolved={exitConflict} onAborted={exitConflict} />
    {:else}
      <!-- Remote -->
      <section class="block">
        <h4>Remote</h4>
        {#if status.loading}
          <p class="u-muted">loading…</p>
        {:else}
          <p class="current" data-testid="current-remote">
            {#if status.data?.remote_url}
              <span class="mono">{status.data.remote_url}</span>
            {:else}
              <span class="u-muted">no remote configured</span>
            {/if}
          </p>
          <div class="field">
            <Input
              type="url"
              placeholder="https://github.com/owner/repo"
              bind:value={urlInput}
              ariaLabel="Remote URL"
              class="grow"
              data-testid="remote-url-input"
            />
            <Button disabled={busy || !urlInput.trim()} onclick={saveRemote}>
              {remoteConfigured ? "Change" : "Set remote"}
            </Button>
          </div>
          {#if urlError}
            <p class="field-err" role="alert" data-testid="url-error">{urlError}</p>
          {/if}
        {/if}
      </section>

      <!-- PAT (write-only) -->
      <section class="block">
        <h4>Access token</h4>
        <p class="current">
          {#if patStored}
            <span class="mono" data-testid="pat-redacted">{status.data?.pat_redacted}</span>
          {:else}
            <span class="u-muted">no token stored</span>
          {/if}
        </p>
        <div class="field">
          <Input
            type="password"
            placeholder="ghp_… (stored securely, never shown)"
            bind:value={patInput}
            ariaLabel="Personal access token"
            class="grow"
            autocomplete="off"
            data-testid="pat-input"
          />
          <Button disabled={busy || !patInput} onclick={savePat}>
            {patStored ? "Replace" : "Store"}
          </Button>
          {#if patStored}
            <Button variant="ghost" disabled={busy} onclick={removePat}>Remove</Button>
          {/if}
        </div>
      </section>

      <!-- Sync -->
      <section class="block">
        <div class="sync-head">
          <h4>Sync</h4>
          <span class="cue" class:amber={syncCue.tone === "amber"} class:cyan={syncCue.tone === "cyan"}>
            {syncCue.glyph} {syncCue.label}
          </span>
        </div>
        {#if !remoteConfigured}
          <p class="u-muted">Configure a remote above to push or pull.</p>
        {:else}
          <div class="sync-actions">
            <Button disabled={busy} onclick={startPush} data-testid="push-btn">
              Push{#if unpushedCount > 0}<Badge tone="accent">{unpushedCount}</Badge>{/if}
            </Button>
            <Button disabled={busy} onclick={startPull} data-testid="pull-btn">Pull</Button>
          </div>

          {#if findings && findings.length > 0}
            <!-- D4: the gate blocked. Show every finding verbatim; require an
                 explicit confirm before pushing. -->
            <div class="gate" data-testid="push-gate">
              <p class="cue amber">{pushGateCue(findings.length).glyph} {pushGateCue(findings.length).label}</p>
              <ul class="findings">
                {#each findings as f (f.path + ":" + f.line)}
                  <li>
                    <span class="mono">{f.path}:{f.line}</span>
                    <span class="kind">{f.kind}</span>
                    <code class="matched mono">{f.matched}</code>
                  </li>
                {/each}
              </ul>
              <div class="gate-actions">
                <Button variant="ghost" disabled={busy} onclick={() => (findings = null)}>Cancel</Button>
                <Button variant="danger" disabled={busy} onclick={doPush} data-testid="push-anyway">
                  Push despite {findings.length} finding{findings.length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          {/if}
        {/if}
      </section>
    {/if}

    {#if error}
      <p class="err" role="alert" data-testid="git-error">{error}</p>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 50;
  }
  .panel {
    width: min(640px, 92vw);
    max-height: 88vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.1rem;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .panel-head h3 {
    margin: 0;
  }
  .block {
    border-top: 1px solid var(--border);
    padding: 0.7rem 0;
  }
  .block h4 {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }
  .current {
    margin: 0 0 0.4rem;
    font-size: 0.82rem;
  }
  .field {
    display: flex;
    gap: 0.4rem;
  }
  /* Let the primitive Input flex to fill the row beside its button. */
  .field :global(.input.grow) {
    flex: 1;
  }
  .field-err {
    color: var(--amber);
    font-size: 0.78rem;
    margin: 0.3rem 0 0;
  }
  .sync-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .sync-actions {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .gate {
    border: 1px solid var(--amber);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
  }
  .findings {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0;
    font-size: 0.78rem;
  }
  .findings li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.15rem 0;
  }
  .matched {
    color: var(--amber);
    word-break: break-all;
  }
  .kind {
    color: var(--text-subtle);
    font-size: 0.72rem;
  }
  .gate-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .cue.amber {
    color: var(--amber);
  }
  .cue.cyan {
    color: var(--cyan);
  }
  .err {
    color: var(--amber);
    font-size: 0.82rem;
    margin-top: 0.5rem;
  }
</style>
