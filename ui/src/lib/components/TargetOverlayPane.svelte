<script lang="ts">
  // Target-overlay editor (target-overlays slice). A sibling to WorkingFileEditor:
  // that one edits the BASE working copy; this one edits the per-target PRIMARY
  // overlay — the target-specific delta that shadows the base primary at install
  // time. A tab strip driven by the primitive's allowed_targets (NEVER the full
  // {Claude,Pi,Codex} enum — a disallowed target 422s in-core, so we never offer
  // it). For the primary file the overlay shadows base entirely, so the textarea
  // shows the EFFECTIVE installed bytes (the merged primary == the overlay bytes).
  //
  // Keyed on (kind/name) by the parent so it REMOUNTS per primitive — the
  // no-useEffect state reset. The per-target view is fetched imperatively (init +
  // tab-click handlers), and the edit buffer is PLAIN $state seeded only by those
  // handlers, so nothing reactive can clobber an in-progress edit (the W5 pattern
  // from the base editor). A stale-read nonce guards a slow fetch from a newer tab.
  import { untrack } from "svelte";
  import Icon from "./ui/Icon.svelte";
  import Badge from "./ui/Badge.svelte";
  import { resource } from "../resource.svelte";
  import {
    readPrimitiveTarget,
    writeOverlay,
    removeOverlay,
    listOverlays,
    LibraryApiError,
    type LibraryKind,
    type LibraryTarget,
    type LibraryTargetView,
    type WorkingContent,
  } from "../api";
  import { overlayCue, editorDirtyCue } from "../library";

  let {
    kind,
    name,
    allowedTargets,
    onOverlayWrite,
  }: {
    kind: LibraryKind;
    name: string;
    allowedTargets: LibraryTarget[];
    /** Notify the parent after a successful overlay write/remove on `target` so it
     *  can reload drift + surface the "won't reach the install until you reinstall"
     *  note next to that target's install row (Decision 3). */
    onOverlayWrite: (target: LibraryTarget) => void;
  } = $props();

  /** The whole primary blob, ALWAYS fenced for md (round-trips through core's
   *  MdPrimitive::parse, which requires the opening fence). Mirrors the base
   *  editor's primaryToText. */
  function primaryToText(w: WorkingContent): string {
    return w.kind === "md" ? `---\n${w.frontmatter}---\n${w.body}` : w.text;
  }

  // Which targets carry an overlay — drives the per-tab cue. resource() reloads
  // after our own writes; it never feeds the edit buffer, so the poll is harmless.
  const overlaysRes = resource(
    () => `ov:${kind}/${name}`,
    () => listOverlays(kind, name),
  );
  const overlayTargets = $derived(new Set((overlaysRes.data ?? []).map((o) => o.target)));

  // Deliberately captures the INITIAL first allowed target (the component is
  // keyed/remounted per primitive, so allowed_targets is stable within a mount —
  // untrack makes the one-time capture explicit, mirroring the base editor).
  let activeTarget = $state<LibraryTarget | null>(untrack(() => allowedTargets[0] ?? null));
  let view = $state<LibraryTargetView | null>(null);
  // The open buffer + last-saved baseline — plain $state (W5), seeded only by
  // loadTarget / save. Never bound to a reactive source.
  let buffer = $state("");
  let baseline = $state("");
  // "Add overlay" editing mode when the active target has no overlay yet (the
  // buffer is seeded from the base bytes, so the author edits a delta — not blank).
  let adding = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let removing = $state(false);
  let confirmingRemove = $state(false);
  let error = $state<string | null>(null);
  let loadNonce = 0;

  const hasOverlay = $derived(view?.has_overlay ?? false);
  const editable = $derived(hasOverlay || adding);
  const isDirty = $derived(editable && buffer !== baseline);
  const dirtyCueV = $derived(editorDirtyCue(isDirty));

  /** Map a route-local LibraryApiError to friendly inline copy (detail withheld
   *  server-side — we only see code + safe message). */
  function overlayMessage(e: unknown, fallback: string): string {
    if (!(e instanceof LibraryApiError)) return fallback;
    switch (e.code) {
      case "library_parse_error":
        return "This doesn’t parse — fix it before saving. Nothing was written.";
      case "library_target_not_allowed":
        return "This target isn’t allowed for this primitive.";
      case "library_invalid_target":
        return "Unknown target.";
      default:
        return e.message;
    }
  }

  /** Fetch the merged view for a target and seed the buffer. A stale-read nonce
   *  keeps a slow fetch from clobbering a newer tab click. */
  async function loadTarget(target: LibraryTarget): Promise<void> {
    const my = ++loadNonce;
    activeTarget = target;
    adding = false;
    confirmingRemove = false;
    error = null;
    loading = true;
    view = null;
    try {
      const v = await readPrimitiveTarget(kind, name, target);
      if (my !== loadNonce) return; // a newer tab superseded this fetch
      view = v;
      buffer = primaryToText(v.working);
      baseline = buffer;
    } catch (e) {
      if (my !== loadNonce) return;
      error = overlayMessage(e, "couldn’t read this target");
    } finally {
      if (my === loadNonce) loading = false;
    }
  }

  // Kick off the initial load at mount (init code — runs once per mount, NOT an
  // effect; the component is keyed/remounted per primitive). untrack marks the
  // one-time read of the initial activeTarget.
  untrack(() => {
    if (activeTarget) void loadTarget(activeTarget);
  });

  /** Enter editing mode for a target with no overlay yet — the buffer already
   *  holds the base bytes, so the author edits a delta seeded from base (risk-b). */
  function startAdd(): void {
    adding = true;
    error = null;
  }

  async function save(): Promise<void> {
    if (saving || !isDirty || !activeTarget) return;
    const my = loadNonce;
    const target = activeTarget;
    const sent = buffer;
    saving = true;
    error = null;
    try {
      await writeOverlay(kind, name, target, sent);
      if (loadNonce === my) {
        baseline = sent; // dirty clears (relative to what we actually saved)
        adding = false;
        if (view) view = { ...view, has_overlay: true }; // we just created it
        overlaysRes.reload(); // refresh the per-tab cues
        onOverlayWrite(target); // parent: reload drift + show the reinstall note
      }
    } catch (e) {
      if (loadNonce === my) error = overlayMessage(e, "save failed");
    } finally {
      saving = false;
    }
  }

  async function removeOverlayFile(): Promise<void> {
    if (removing || !activeTarget) return;
    const my = loadNonce;
    const target = activeTarget;
    removing = true;
    error = null;
    try {
      await removeOverlay(kind, name, target);
      confirmingRemove = false;
      overlaysRes.reload();
      onOverlayWrite(target);
      if (loadNonce === my) await loadTarget(target); // re-fetch → base passthrough
    } catch (e) {
      if (loadNonce === my) error = overlayMessage(e, "couldn’t remove the overlay");
    } finally {
      removing = false;
    }
  }
</script>

{#if !activeTarget}
  <p class="overlay-empty">No allowed targets — overlays are per-target, so there’s nothing to edit here.</p>
{:else}
  <div class="overlay-frame">
    <!-- Tab strip: one per allowed_target; the cue marks delta vs. base passthrough. -->
    <div class="overlay-tabs" role="tablist">
      {#each allowedTargets as t (t)}
        {@const tc = overlayCue(overlayTargets.has(t))}
        <button
          type="button"
          role="tab"
          class="overlay-tab"
          class:active={t === activeTarget}
          aria-selected={t === activeTarget}
          onclick={() => loadTarget(t)}
        >
          <span class="mono">{t}</span>
          <span class="tab-cue tone-{tc.tone}" title={tc.label}>{tc.glyph}</span>
        </button>
      {/each}
    </div>

    <div class="overlay-pane">
      <div class="pane-head">
        {#if view}
          {@const oc = overlayCue(hasOverlay)}
          <span class="head-state">
            <Badge tone={oc.tone}>{oc.glyph} {oc.label}</Badge>
            {#if hasOverlay}
              <small class="head-note">replaces the base primary for <span class="mono">{activeTarget}</span> at install</small>
            {:else}
              <small class="head-note">showing the base primary — no <span class="mono">{activeTarget}</span> overlay yet</small>
            {/if}
          </span>
        {/if}
        <span class="pane-cues">
          {#if editable}
            <Badge tone={dirtyCueV.tone}>{dirtyCueV.glyph} {dirtyCueV.label}</Badge>
            <button type="button" class="act" disabled={!isDirty || saving} onclick={save}>
              {saving ? "Saving…" : "Save overlay"}
            </button>
          {/if}
          {#if hasOverlay && !confirmingRemove}
            <button type="button" class="act danger" disabled={removing} onclick={() => (confirmingRemove = true)}>
              Remove overlay
            </button>
          {/if}
          {#if !hasOverlay && !adding}
            <button type="button" class="act" onclick={startAdd}>
              <Icon name="plus" size={12} /> Add overlay for {activeTarget}
            </button>
          {/if}
        </span>
      </div>

      {#if confirmingRemove}
        <div class="confirm-bar" role="alertdialog" aria-label="confirm remove overlay">
          <span>Remove the <span class="mono">{activeTarget}</span> overlay? The target falls back to the base primary.</span>
          <span class="confirm-actions">
            <button type="button" class="act danger" disabled={removing} onclick={removeOverlayFile}>
              {removing ? "Removing…" : "Remove"}
            </button>
            <button type="button" class="act ghost" disabled={removing} onclick={() => (confirmingRemove = false)}>Cancel</button>
          </span>
        </div>
      {/if}

      {#if loading}
        <div class="pane-muted">Loading…</div>
      {:else}
        <textarea
          class="overlay-area mono"
          bind:value={buffer}
          spellcheck="false"
          readonly={!editable}
          aria-label="{activeTarget} overlay contents"
        ></textarea>
      {/if}

      {#if error}
        <div class="overlay-error" role="alert">{error}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay-empty {
    color: var(--text-subtle);
    font-size: 12px;
    margin: 8px 0 0;
  }
  .overlay-frame {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    overflow: hidden;
  }
  .overlay-tabs {
    display: flex;
    gap: 2px;
    padding: 6px 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .overlay-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
  }
  .overlay-tab.active {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--text);
    border-color: var(--border-glow);
  }
  .tab-cue {
    font-size: 11px;
    line-height: 1;
  }
  /* Tones never rely on color alone — the glyph + tab label carry the meaning —
     but the hue reinforces it for those who see it. Cyan/amber only (CVD-safe);
     never a bare red/green (Scott is red/green colorblind). */
  .tone-cyan {
    color: var(--cyan, #56b4e9);
  }
  .tone-amber {
    color: var(--amber, #d08b1d);
  }
  .tone-default {
    color: var(--text-subtle);
  }
  .overlay-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
  }
  .head-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .head-note {
    color: var(--text-dim);
    font-size: 11px;
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
  .confirm-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--amber, #d08b1d) 12%, transparent);
    font-size: 12px;
    color: var(--text);
  }
  .confirm-actions {
    display: inline-flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .overlay-area {
    flex: 1;
    min-height: 200px;
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
  .overlay-area:focus {
    outline: none;
  }
  .overlay-area[readonly] {
    color: var(--text-dim);
    background: color-mix(in srgb, var(--surface-2) 30%, transparent);
  }
  .pane-muted {
    padding: 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .overlay-error {
    padding: 7px 10px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--amber, #d08b1d) 14%, transparent);
    color: var(--text);
    font-size: 12px;
  }
  .act {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 11.5px;
    padding: 3px 9px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .act:hover:not(:disabled) {
    border-color: var(--border-glow);
  }
  .act:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost {
    background: transparent;
  }
  .danger {
    border-color: color-mix(in srgb, var(--amber, #d08b1d) 55%, var(--border));
  }
</style>
