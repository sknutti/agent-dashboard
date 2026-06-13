<script lang="ts">
  // The pull-conflict resolver (Slice 8). A `git pull --rebase` that stops on a
  // conflict leaves the resolver here; the user picks a side per file, then
  // Continue replays. If the next replayed commit collides afresh
  // (still_conflicted), the list reloads and the loop repeats. Cancel aborts the
  // whole rebase back to the pre-pull state.
  //
  // The rebase state lives in `.git` (not in any process), so each action is an
  // independent request against the same on-disk rebase — the resolver just
  // sequences them. No useEffect: the conflict list is a resource() (mount-load +
  // explicit reload after a still_conflicted continue); every button is an event
  // handler.
  import ConflictRow from "./ConflictRow.svelte";
  import { resource } from "../resource.svelte";
  import {
    listPullConflicts,
    resolveConflict,
    continuePull,
    abortPull,
    LibraryApiError,
    type LibraryConflictSide,
  } from "../api";

  let {
    libraryPath,
    onResolved,
    onAborted,
  }: {
    libraryPath: string | null;
    /** The rebase finished cleanly — the parent reloads status + exits. */
    onResolved: () => void;
    /** The rebase was aborted — the parent reloads status + exits. */
    onAborted: () => void;
  } = $props();

  const conflicts = resource("git:conflicts", listPullConflicts);
  let resolvedPaths = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const allResolved = $derived(
    !!conflicts.data && conflicts.data.length > 0 && conflicts.data.every((c) => resolvedPaths.includes(c.path)),
  );

  async function resolve(path: string, side: LibraryConflictSide) {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await resolveConflict(path, side);
      if (!resolvedPaths.includes(path)) resolvedPaths = [...resolvedPaths, path];
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not stage that side";
    } finally {
      busy = false;
    }
  }

  async function doContinue() {
    if (busy || !allResolved) return;
    busy = true;
    error = null;
    try {
      const r = await continuePull();
      if (r.outcome === "done") {
        onResolved();
      } else {
        // A fresh batch of conflicts — reset and reload the list for round two.
        resolvedPaths = [];
        conflicts.reload();
      }
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not continue the rebase";
    } finally {
      busy = false;
    }
  }

  async function doAbort() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await abortPull();
      onAborted();
    } catch (e) {
      error = e instanceof LibraryApiError ? e.message : "could not abort the rebase";
    } finally {
      busy = false;
    }
  }
</script>

<section class="resolver" data-testid="conflict-resolver">
  <header>
    <h4>⚠ Resolve pull conflicts</h4>
    <p class="muted">
      Pick a side for each file. Local is your change; Remote is the incoming change. Continue replays
      the rebase once every file is resolved.
    </p>
  </header>

  {#if conflicts.loading}
    <p class="muted">loading conflicts…</p>
  {:else if conflicts.error}
    <p class="err" role="alert">Could not load the conflict list.</p>
  {:else if conflicts.data && conflicts.data.length > 0}
    {#each conflicts.data as c (c.path)}
      <ConflictRow
        conflict={c}
        {libraryPath}
        resolved={resolvedPaths.includes(c.path)}
        onResolve={(side) => resolve(c.path, side)}
      />
    {/each}
  {:else}
    <p class="muted">No conflicts remain.</p>
  {/if}

  {#if error}
    <p class="err" role="alert">{error}</p>
  {/if}

  <div class="actions">
    <button type="button" class="act" disabled={busy} onclick={doAbort} data-testid="abort-pull">
      Cancel (abort rebase)
    </button>
    <button
      type="button"
      class="act primary"
      disabled={busy || !allResolved}
      onclick={doContinue}
      data-testid="continue-pull"
    >
      Continue
    </button>
  </div>
</section>

<style>
  .resolver {
    border: 1px solid var(--amber, #c79a3a);
    border-radius: 6px;
    padding: 0.75rem;
  }
  header h4 {
    margin: 0 0 0.2rem;
  }
  .muted {
    color: var(--muted, #888);
    font-size: 0.8rem;
  }
  .err {
    color: var(--amber, #c79a3a);
    font-size: 0.8rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .act {
    padding: 0.35rem 0.8rem;
    border-radius: 4px;
    border: 1px solid var(--border, #2a2a2a);
    background: var(--surface, #1d1d1d);
    cursor: pointer;
  }
  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .act.primary {
    border-color: var(--accent, #4a7);
  }
</style>
