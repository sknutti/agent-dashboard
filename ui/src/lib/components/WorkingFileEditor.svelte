<script lang="ts">
  // Working-copy editor (working-copy slice). Replaces the read-only <pre> in the
  // Library detail pane: a working-files tree (primary pinned first, refs
  // alphabetical — core already sorts) + a textarea-first file pane that edits the
  // primary and ref files, plus create / rename / delete ref-file actions.
  //
  // Keyed on (kind/name) by the parent so it REMOUNTS per primitive — that is the
  // no-useEffect state reset (the buffer/baseline/selection hydrate fresh at init,
  // never via a $effect reading resource data).
  //
  // W5 (risk-b — lost edits across the 30s poll): the open buffer is PLAIN $state,
  // hydrated only by event handlers (file-select / save). `filesRes` rides the
  // poll and refetches the TREE in the background, but it never touches `buffer`,
  // so an in-progress edit survives a poll tick. isDirty is $derived.
  // W6 (risk-c): after any successful write we reload the tree here AND call
  // onWrite() so the parent re-reads detail.working + the primitive `dirty` badge.
  // W7: ref-file actions take a per-file pending lock; delete uses a lightweight
  // inline confirm (idempotent + git-recoverable + single file).
  import { untrack } from "svelte";
  import Icon from "./ui/Icon.svelte";
  import { Badge, Button, IconButton, Input, Callout, EmptyState } from "./ui";
  import { resource } from "../resource.svelte";
  import {
    getWorkingFiles,
    readWorkingFile,
    saveWorking,
    createWorkingFile,
    saveWorkingFile,
    renameWorkingFile,
    deleteWorkingFile,
    LibraryApiError,
    type LibraryKind,
    type WorkingContent,
    type WorkingFileBytes,
  } from "../api";
  import { editorDirtyCue } from "../library";

  let {
    kind,
    name,
    working,
    onWrite,
  }: {
    kind: LibraryKind;
    name: string;
    working: WorkingContent;
    /** Parent reload after a successful write — re-reads detail.working + the
     *  primitive `dirty` badge (W6). The tree reload is owned here. */
    onWrite: () => void;
  } = $props();

  /** The whole primary blob, ALWAYS fenced for md — unlike the display-only <pre>,
   *  which drops the fences when frontmatter is empty. The editor must round-trip
   *  through save_working's MdPrimitive::parse, which REQUIRES the opening fence,
   *  so `---\n---\nbody` (empty frontmatter) must keep its fences. */
  function primaryToText(w: WorkingContent): string {
    return w.kind === "md" ? `---\n${w.frontmatter}---\n${w.body}` : w.text;
  }

  // The working-files tree, keyed per primitive (stable within this mount). Rides
  // the 30s poll via resource()'s own dataEpoch effect — background tree refresh.
  // The key is a getter (kind/name don't change within a mount — the component is
  // keyed/remounted per primitive — but the getter keeps it out of a captured-init).
  const filesRes = resource(
    () => `wf:${kind}/${name}`,
    () => getWorkingFiles(kind, name),
  );
  const files = $derived(filesRes.data ?? []);
  const primaryPath = $derived(files.find((f) => f.role === "primary")?.path ?? null);

  // selectedFile === null ⟺ the PRIMARY is open (its content comes from the
  // `working` prop, no fetch). A non-null value is a ref file's path.
  let selectedFile = $state<string | null>(null);
  // The open buffer + its last-saved baseline — plain $state (W5). Seeded from the
  // primary ONCE at init via untrack (deliberately capturing the initial value —
  // the buffer must NOT reactively track `working`, or a background poll/refetch
  // would clobber an in-progress edit). Re-seeded only by event handlers.
  let buffer = $state(untrack(() => primaryToText(working)));
  let baseline = $state(untrack(() => primaryToText(working)));
  // The loaded ref-file bytes (for binary detection); null while the primary is
  // open. A stale-read nonce guards against a slow read clobbering a newer select.
  let loadedContent = $state<WorkingFileBytes | null>(null);
  let loadingFile = $state(false);
  let loadNonce = 0;

  let saving = $state(false);
  let editorError = $state<string | null>(null);

  // Per-file action lock (W7): disable a row's rename/delete while its write is in
  // flight; cleared in finally so a rejected write never strands a row disabled.
  let filePending = $state<Set<string>>(new Set());
  function setFilePending(path: string, on: boolean): void {
    const next = new Set(filePending);
    on ? next.add(path) : next.delete(path);
    filePending = next;
  }

  // Inline ref-file affordances (create / rename / delete-confirm) — route-local,
  // never the shell.
  let creating = $state(false);
  let newPath = $state("");
  let renaming = $state<string | null>(null);
  let renameTo = $state("");
  let confirmingDelete = $state<string | null>(null);

  const isPrimaryOpen = $derived(selectedFile === null);
  const isBinary = $derived(loadedContent?.kind === "binary");
  const canEdit = $derived(isPrimaryOpen || loadedContent?.kind === "text");
  const isDirty = $derived(canEdit && buffer !== baseline);
  const dirtyCueV = $derived(editorDirtyCue(isDirty));

  function isActive(path: string, role: string): boolean {
    return role === "primary" ? selectedFile === null : selectedFile === path;
  }

  /** Map a route-local LibraryApiError to friendly inline copy (detail is withheld
   *  server-side — we only ever see code + safe message). */
  function editorMessage(e: unknown, fallback: string): string {
    if (!(e instanceof LibraryApiError)) return fallback;
    switch (e.code) {
      case "library_parse_error":
        return "This file doesn’t parse — fix it before saving. Nothing was written.";
      case "working_file_exists":
        return "A file with that name already exists — use Save, or pick another name.";
      case "working_file_not_found":
        return "That file no longer exists — it may have been deleted.";
      case "working_file_refuse_primary":
        return "The primary file can’t be renamed or deleted here — rename the primitive instead.";
      case "library_invalid_working_path":
        return "Invalid file name (no “..”, absolute, or hidden paths).";
      case "working_file_too_many":
        return "This bundle is at its file cap.";
      default:
        return e.message;
    }
  }

  // Pull-based surface for the parent (Library.svelte version pane) — lets it act
  // on the editor's SAVED state WITHOUT an effect-driven prop sync (no useEffect):
  //  - hasUnsavedEdits(): publish snapshots the on-disk working copy, so the
  //    version pane refuses to publish while the open buffer is dirty.
  //  - applyWorking(w): after "Restore working copy" rewrites working/ on disk,
  //    the parent hands the freshly-fetched primary back so the open buffer
  //    reflects the revert (the buffer never tracks the `working` prop — W5 — so
  //    a reseed must be pushed explicitly).
  export function hasUnsavedEdits(): boolean {
    return isDirty;
  }
  export function applyWorking(w: WorkingContent): void {
    loadNonce++; // cancel any in-flight ref read
    selectedFile = null;
    loadedContent = null;
    buffer = primaryToText(w);
    baseline = buffer;
    editorError = null;
  }

  /** Open the primary (no fetch — its content is the `working` prop). Cancels any
   *  in-flight ref read via the nonce. */
  function openPrimary(): void {
    loadNonce++;
    selectedFile = null;
    loadedContent = null;
    buffer = primaryToText(working);
    baseline = buffer;
    editorError = null;
  }

  /** Select a tree entry. The primary routes to openPrimary; a ref is lazily read.
   *  A stale-read guard (nonce) keeps a slow read from clobbering a newer click. */
  async function selectFile(path: string): Promise<void> {
    if (primaryPath !== null && path === primaryPath) {
      openPrimary();
      return;
    }
    editorError = null;
    confirmingDelete = null;
    const my = ++loadNonce;
    selectedFile = path;
    loadedContent = null;
    loadingFile = true;
    try {
      const content = await readWorkingFile(kind, name, path);
      if (my !== loadNonce) return; // a newer selection superseded this read
      loadedContent = content;
      if (content.kind === "text") {
        buffer = content.text;
        baseline = content.text;
      } else {
        buffer = "";
        baseline = "";
      }
    } catch (e) {
      if (my !== loadNonce) return;
      editorError = editorMessage(e, "couldn’t read this file");
    } finally {
      if (my === loadNonce) loadingFile = false;
    }
  }

  async function save(): Promise<void> {
    if (saving || !isDirty) return;
    // Snapshot the open file + the exact bytes we POST + the selection nonce. If
    // the user switches files DURING the save (selectFile/openPrimary bump
    // loadNonce), we must NOT write the new file's baseline — that would mark a
    // different, unsaved file "clean" (a lying dirty cue). We also set `baseline`
    // to what was SENT, not the live buffer: if the user keeps typing into the
    // same file mid-save, those newer keystrokes stay correctly dirty.
    const myNonce = loadNonce;
    const target = selectedFile;
    const sent = buffer;
    saving = true;
    editorError = null;
    try {
      if (target === null) {
        await saveWorking(kind, name, sent);
      } else {
        await saveWorkingFile(kind, name, target, sent);
      }
      if (loadNonce === myNonce) {
        baseline = sent; // dirty clears (relative to what we actually saved)
        onWrite(); // parent: detailRes + primitivesRes reload (W6)
        filesRes.reload(); // size_bytes changed
      }
    } catch (e) {
      if (loadNonce === myNonce) editorError = editorMessage(e, "save failed");
    } finally {
      saving = false; // always — this save is done regardless of a switch
    }
  }

  async function createFile(): Promise<void> {
    const path = newPath.trim();
    if (!path || saving) return;
    editorError = null;
    saving = true;
    try {
      await createWorkingFile(kind, name, path, "");
      creating = false;
      newPath = "";
      onWrite();
      filesRes.reload();
    } catch (e) {
      editorError = editorMessage(e, "couldn’t create the file");
      return; // a read-back failure below must not masquerade as a create failure
    } finally {
      saving = false;
    }
    // Create succeeded and the lock is released — open the new (empty) file. Its
    // own nonce guard handles the user clicking elsewhere mid read-back.
    void selectFile(path);
  }

  async function renameFile(from: string): Promise<void> {
    const to = renameTo.trim();
    if (!to || filePending.has(from)) return;
    setFilePending(from, true);
    editorError = null;
    try {
      await renameWorkingFile(kind, name, from, to);
      renaming = null;
      renameTo = "";
      if (selectedFile === from) selectedFile = to; // follow the rename (bytes unchanged)
      onWrite();
      filesRes.reload();
    } catch (e) {
      editorError = editorMessage(e, "couldn’t rename the file");
    } finally {
      setFilePending(from, false);
    }
  }

  async function deleteFile(path: string): Promise<void> {
    if (filePending.has(path)) return;
    setFilePending(path, true);
    editorError = null;
    try {
      await deleteWorkingFile(kind, name, path);
      confirmingDelete = null;
      if (selectedFile === path) openPrimary(); // fall back to the primary
      onWrite();
      filesRes.reload();
    } catch (e) {
      editorError = editorMessage(e, "couldn’t delete the file");
    } finally {
      setFilePending(path, false);
    }
  }

  function startRename(path: string): void {
    renaming = path;
    renameTo = path;
    confirmingDelete = null;
  }
</script>

<div class="file-frame">
  <div class="editor-grid">
    <!-- Working-files tree: primary pinned first, refs alphabetical (core sorts). -->
    <div class="tree">
      <div class="tree-head">
        <span><Icon name="folder" size={13} /> files</span>
        <Button
          size="sm"
          icon="plus"
          ariaLabel="Add a new ref file"
          onclick={() => {
            creating = !creating;
            editorError = null;
          }}
        >
          New
        </Button>
      </div>

      {#if creating}
        <div class="tree-form">
          <Input
            bind:value={newPath}
            placeholder="notes.md"
            ariaLabel="new file path"
            onkeydown={(e) => e.key === "Enter" && createFile()}
          />
          <div class="tree-form-actions">
            <Button size="sm" disabled={!newPath.trim() || saving} onclick={createFile}>Create</Button>
            <Button size="sm" variant="ghost" onclick={() => { creating = false; newPath = ""; }}>Cancel</Button>
          </div>
        </div>
      {/if}

      {#if filesRes.loading && !filesRes.data}
        <div class="tree-muted">Loading…</div>
      {:else if filesRes.error}
        <EmptyState icon="alert" title="Couldn’t list files" error={true} onRetry={filesRes.reload} />
      {:else}
        <ul class="tree-list">
          {#each files as f (f.path)}
            <li class="tree-row" class:active={isActive(f.path, f.role)} data-path={f.path}>
              {#if renaming === f.path}
                <Input
                  class="rename-input"
                  bind:value={renameTo}
                  ariaLabel="rename to"
                  onkeydown={(e) => e.key === "Enter" && renameFile(f.path)}
                />
                <Button size="sm" disabled={!renameTo.trim() || filePending.has(f.path)} onclick={() => renameFile(f.path)}>Save</Button>
                <Button size="sm" variant="ghost" onclick={() => { renaming = null; renameTo = ""; }}>Cancel</Button>
              {:else if confirmingDelete === f.path}
                <span class="confirm-label">Delete {f.path}?</span>
                <Button size="sm" variant="danger" disabled={filePending.has(f.path)} onclick={() => deleteFile(f.path)}>Delete</Button>
                <Button size="sm" variant="ghost" onclick={() => (confirmingDelete = null)}>Cancel</Button>
              {:else}
                <!-- ds-allow-native: clickable file-tree row (whole-row selector), not a form-control button -->
                <button type="button" class="tree-name" onclick={() => selectFile(f.path)} title={f.path}>
                  {#if f.role === "primary"}<Icon name="star" size={11} />{/if}
                  <span class="tree-name-text">{f.path}</span>
                  {#if !f.is_text}<small class="bin-tag">bin</small>{/if}
                </button>
                {#if f.role === "ref"}
                  <span class="row-tools">
                    <IconButton icon="edit" size={22} iconSize={12} label="Rename" variant="ghost" disabled={filePending.has(f.path)} onclick={() => startRename(f.path)} />
                    <IconButton icon="trash" size={22} iconSize={12} label="Delete" variant="ghost" disabled={filePending.has(f.path)} onclick={() => (confirmingDelete = f.path)} />
                  </span>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- File pane: textarea for text (primary + text refs); placeholder for binary. -->
    <div class="pane">
      <div class="pane-head">
        <span class="mono pane-path">{selectedFile ?? primaryPath ?? working.kind}</span>
        <span class="pane-cues">
          {#if isPrimaryOpen}<Badge tone="default">primary</Badge>{/if}
          {#if canEdit}
            <Badge tone={dirtyCueV.tone}>{dirtyCueV.glyph} {dirtyCueV.label}</Badge>
            <Button size="sm" disabled={!isDirty || saving} onclick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          {/if}
        </span>
      </div>

      {#if loadingFile}
        <div class="pane-muted">Loading…</div>
      {:else if isBinary}
        <div class="pane-binary">
          <Icon name="file" size={18} />
          <p>Binary file — {loadedContent?.kind === "binary" ? loadedContent.size : 0} bytes. No text preview.</p>
        </div>
      {:else}
        <!-- ds-allow-native: full-pane code editor (borderless, transparent, flex-fill) — not a form-field Textarea; needs aria-label + spellcheck the primitive doesn't expose -->
        <textarea
          class="editor-area mono"
          bind:value={buffer}
          spellcheck="false"
          aria-label="file contents"
        ></textarea>
      {/if}

      {#if editorError}
        <div class="pane-notice">
          <Callout tone="warn" role="alert">{editorError}</Callout>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .file-frame {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    overflow: hidden;
  }
  .editor-grid {
    display: grid;
    grid-template-columns: minmax(140px, 200px) minmax(0, 1fr);
    min-height: 260px;
  }
  /* Tree ---------------------------------------------------------------- */
  .tree {
    border-right: 1px solid var(--border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .tree-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-dim);
    font-size: 11px;
    text-transform: lowercase;
  }
  .tree-head span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .tree-form {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* The rename Input shares its flex row with Save/Cancel — let it shrink.
     `:global` because the class lands on the child Input's inner field. */
  :global(.rename-input) {
    flex: 1;
    min-width: 0;
  }
  .tree-form-actions {
    display: flex;
    gap: 4px;
  }
  .tree-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow: auto;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
    padding: 1px 2px;
  }
  .tree-row.active {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .tree-name {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tree-name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-name:hover {
    color: var(--text-bright, var(--text));
  }
  .bin-tag {
    color: var(--text-subtle);
    font-size: 9.5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 3px;
  }
  .row-tools {
    display: inline-flex;
    gap: 1px;
    opacity: 0.65;
  }
  .tree-row:hover .row-tools {
    opacity: 1;
  }
  .confirm-label {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-muted {
    color: var(--text-dim);
    font-size: 12px;
    padding: 6px;
  }
  /* Pane ---------------------------------------------------------------- */
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
  }
  .pane-path {
    font-size: 11.5px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-cues {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }
  .editor-area {
    flex: 1;
    min-height: 220px;
    width: 100%;
    resize: vertical;
    border: none;
    padding: 10px;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.5;
    tab-size: 2;
  }
  .editor-area:focus {
    outline: none;
  }
  .pane-binary {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 32px 16px;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
  }
  .pane-muted {
    padding: 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
  /* The route-local error Callout sits flush under the pane, separated by a rule. */
  .pane-notice {
    padding: 7px 10px;
    border-top: 1px solid var(--border);
  }
</style>
