<script lang="ts">
  // One conflicted path inside the pull-conflict resolver (Slice 8). The
  // structured kinds (current.txt / metadata.yaml) render LOCAL vs REMOTE
  // side-by-side with value-pickers; version_file / other can't be safely
  // auto-merged, so they fall back to a copy-absolute-path escape hatch (Slice
  // 10c — no native Finder reveal on a localhost web app).
  //
  // No useEffect: the two blob sides load via resource() (the repo's mount-load
  // primitive, keyed by path+side); picking a side is an event handler. The row
  // owns no rebase state — it reports the chosen side up; the parent drives
  // continue/abort. "Local" = the user's change, "Remote" = the incoming change
  // (the bridge hides the rebase --ours/--theirs swap).
  import { Button } from "./ui";
  import { resource } from "../resource.svelte";
  import { readConflictBlob, LibraryApiError, type LibraryConflictEntry, type LibraryConflictSide } from "../api";
  import { conflictResolvable } from "../library";

  let {
    conflict,
    libraryPath,
    resolved,
    onResolve,
  }: {
    conflict: LibraryConflictEntry;
    /** Absolute path to the conflict file, for the copy-path escape hatch. */
    libraryPath: string | null;
    /** Whether this row has already been staged (drives the ✓ + disabled state). */
    resolved: boolean;
    /** Stage the chosen side; the parent calls resolveConflict + flips `resolved`. */
    onResolve: (side: LibraryConflictSide) => void;
  } = $props();

  const resolvable = $derived(conflictResolvable(conflict.kind));

  // Only the structured kinds load their two sides; the escape-hatch kinds don't.
  const local = resource(
    () => `conflict:${conflict.path}:local`,
    () => (resolvable ? readConflictBlob(conflict.path, "local") : Promise.resolve({ content: null })),
  );
  const remote = resource(
    () => `conflict:${conflict.path}:remote`,
    () => (resolvable ? readConflictBlob(conflict.path, "remote") : Promise.resolve({ content: null })),
  );

  const absPath = $derived(libraryPath ? `${libraryPath}/${conflict.path}` : conflict.path);
  let copied = $state(false);
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(absPath);
      copied = true;
    } catch {
      copied = false;
    }
  }

  const KIND_LABEL: Record<string, string> = {
    current_txt: "version pointer",
    metadata_yaml: "metadata",
    version_file: "version file",
    other: "file",
  };
</script>

<div class="conflict-row" class:resolved data-testid="conflict-row" data-path={conflict.path}>
  <div class="row-head">
    <span class="mono path">{conflict.path}</span>
    <span class="kind">{KIND_LABEL[conflict.kind] ?? conflict.kind}</span>
    {#if resolved}
      <span class="cue" data-testid="row-resolved">✓ resolved</span>
    {/if}
  </div>

  {#if resolvable}
    <div class="sides">
      <div class="side">
        <h5>Local <span class="hint">your change</span></h5>
        {#if local.loading}
          <p class="u-muted">loading…</p>
        {:else if local.error}
          <p class="u-muted">could not read</p>
        {:else}
          <pre class="blob">{local.data?.content ?? "(file removed on this side)"}</pre>
        {/if}
        <Button size="sm" disabled={resolved} onclick={() => onResolve("local")}>Use Local</Button>
      </div>
      <div class="side">
        <h5>Remote <span class="hint">incoming change</span></h5>
        {#if remote.loading}
          <p class="u-muted">loading…</p>
        {:else if remote.error}
          <p class="u-muted">could not read</p>
        {:else}
          <pre class="blob">{remote.data?.content ?? "(file removed on this side)"}</pre>
        {/if}
        <Button size="sm" disabled={resolved} onclick={() => onResolve("remote")}>Use Remote</Button>
      </div>
    </div>
  {:else}
    <!-- version_file / other: can't render a safe value-picker. Offer the path +
         pick-a-side (resolve still works; the user inspects the file out of band). -->
    <div class="escape">
      <p class="u-muted">
        This {KIND_LABEL[conflict.kind] ?? "file"} can't be previewed here — open it to inspect, then pick a side.
      </p>
      <div class="escape-actions">
        <Button variant="ghost" size="sm" icon="copy" iconSize={12} onclick={copyPath}>
          {copied ? "copied path" : "Copy path"}
        </Button>
        <Button size="sm" disabled={resolved} onclick={() => onResolve("local")}>Use Local</Button>
        <Button size="sm" disabled={resolved} onclick={() => onResolve("remote")}>Use Remote</Button>
      </div>
      <code class="mono abs">{absPath}</code>
    </div>
  {/if}
</div>

<style>
  .conflict-row {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    margin-bottom: 0.6rem;
  }
  .conflict-row.resolved {
    opacity: 0.7;
  }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }
  .path {
    font-weight: 600;
  }
  .kind {
    font-size: 0.72rem;
    color: var(--text-subtle);
  }
  .cue {
    margin-left: auto;
    font-size: 0.72rem;
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .side h5 {
    margin: 0 0 0.3rem;
    font-size: 0.78rem;
  }
  /* Keep the picker button off the blob preview above it. */
  .side :global(.btn) {
    margin-top: 0.3rem;
  }
  .hint {
    color: var(--text-subtle);
    font-weight: 400;
  }
  .blob {
    max-height: 9rem;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem;
    font-size: 0.74rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .escape-actions {
    display: flex;
    gap: 0.4rem;
    margin: 0.3rem 0;
  }
  .abs {
    font-size: 0.72rem;
    color: var(--text-subtle);
    word-break: break-all;
  }
</style>
