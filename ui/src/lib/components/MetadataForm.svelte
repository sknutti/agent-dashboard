<script lang="ts">
  // Metadata editor (metadata-editing slice). Edits the THREE editable fields —
  // allowed_targets / display_name / author — through update_metadata. created_at
  // and source_url are read-only (set-once at create time), so they're not here.
  //
  // Keyed on (kind/name) by the parent so it REMOUNTS per primitive — the
  // no-useEffect state reset. The edit buffers are PLAIN $state seeded once at
  // mount (untrack), so a background detail poll can't clobber an in-progress
  // edit (the W5 pattern from the base editor). After our own save we reseed the
  // buffers + baselines from the authoritative returned metadata.
  //
  // Two load-bearing validation outcomes shape the UI:
  //  - Target checkboxes are constrained to the KIND's matrix (Decision 4), so a
  //    kind-illegal target is never offered — library_target_not_allowed_for_kind
  //    becomes a disabled/absent checkbox, not an error round-trip.
  //  - Dropping a target that still has overlay files is a two-phase confirm
  //    (Decision 3): the first save (discard_orphan_overlays:false) → 409; the UI
  //    names the orphaned paths (derived from the already-loaded list_overlays
  //    data — O1, never the error payload) and re-issues with the flag set.
  import { untrack } from "svelte";
  import { Badge, Button, Input, Checkbox, Callout } from "./ui";
  import { resource } from "../resource.svelte";
  import {
    updateMetadata,
    listOverlays,
    LibraryApiError,
    type LibraryKind,
    type LibraryTarget,
    type LibraryPrimitiveMetadata,
  } from "../api";
  import { editorDirtyCue, metadataSaveCue, type Cue } from "../library";

  let {
    kind,
    name,
    metadata,
    kindAllowedTargets,
    onSaved,
  }: {
    kind: LibraryKind;
    name: string;
    /** The current metadata — seeds the form ONCE at mount (the component is
     *  keyed/remounted per primitive, so this is stable within a mount). */
    metadata: LibraryPrimitiveMetadata;
    /** The KIND's legal target matrix (kind_info.allowed_targets) — the checkbox
     *  set, NOT the full {Claude,Pi,Codex} enum (Decision 4). */
    kindAllowedTargets: LibraryTarget[];
    /** Notify the parent after a successful save so it reloads the detail
     *  resource — re-driving the overlay tab strip + rail from the new
     *  allowed_targets (the Slice 5 forward coupling), no useEffect. */
    onSaved: () => void;
  } = $props();

  // Which targets carry an overlay — used ONLY to name the orphaned paths in the
  // drop-confirm (O1: derive client-side; the error payload stays server-side).
  // resource() reloads after our writes; it never feeds an edit buffer.
  const overlaysRes = resource(
    () => `meta-ov:${kind}/${name}`,
    () => listOverlays(kind, name),
  );

  // Edit buffers — PLAIN $state seeded once at mount via untrack (W5). Never
  // bound to the reactive `metadata` prop, so a poll can't clobber an edit.
  let selectedTargets = $state<Set<LibraryTarget>>(
    new Set(untrack(() => metadata.allowed_targets)),
  );
  let displayName = $state(untrack(() => metadata.display_name ?? ""));
  let author = $state(untrack(() => metadata.author ?? ""));

  // Baselines for the dirty check — $state so a successful save can reset them.
  let baseTargets = $state(untrack(() => [...metadata.allowed_targets].sort().join(",")));
  let baseDisplay = $state(untrack(() => metadata.display_name ?? ""));
  let baseAuthor = $state(untrack(() => metadata.author ?? ""));

  let saving = $state(false);
  let error = $state<string | null>(null);
  let saveCue = $state<Cue | null>(null);
  let commitError = $state<string | null>(null);
  // The drop-confirm: non-null = the first save 409'd; holds the targets being
  // dropped that still carry overlay files (named in the confirm copy).
  let confirmDrop = $state<{ target: LibraryTarget; paths: string[] }[] | null>(null);

  const targetsKey = $derived([...selectedTargets].sort().join(","));
  const isDirty = $derived(
    targetsKey !== baseTargets || displayName !== baseDisplay || author !== baseAuthor,
  );
  const dirtyCue = $derived(editorDirtyCue(isDirty));

  function toggleTarget(t: LibraryTarget): void {
    const next = new Set(selectedTargets);
    next.has(t) ? next.delete(t) : next.add(t);
    selectedTargets = next;
    saveCue = null; // a fresh edit supersedes the last save's cue
    confirmDrop = null;
  }

  /** Map a route-local LibraryApiError to friendly inline copy (detail withheld
   *  server-side — we only see code + safe message). */
  function metadataMessage(e: unknown): string {
    if (!(e instanceof LibraryApiError)) return "Save failed.";
    switch (e.code) {
      case "library_target_not_allowed_for_kind":
        return "That target isn’t available for this kind.";
      case "library_invalid_target":
        return "Unknown target.";
      default:
        return e.message;
    }
  }

  /** The targets being dropped (in the baseline but unchecked now) that still
   *  carry overlay files — derived from the already-loaded list_overlays data
   *  (O1), so the confirm names the exact paths without the error payload. */
  function droppedWithOverlays(): { target: LibraryTarget; paths: string[] }[] {
    return (overlaysRes.data ?? []).filter((o) => !selectedTargets.has(o.target));
  }

  async function save(discardOrphans = false): Promise<void> {
    if (saving || !isDirty) return; // pending-lock: a double-click can't double-submit
    saving = true;
    error = null;
    try {
      // Empty/whitespace → null (drop the field); the bridge also collapses ""→None.
      const result = await updateMetadata(kind, name, {
        allowed_targets: [...selectedTargets],
        display_name: displayName.trim() === "" ? null : displayName,
        author: author.trim() === "" ? null : author,
        discard_orphan_overlays: discardOrphans,
      });
      // Reseed buffers + baselines from the authoritative returned metadata so
      // the form is clean and reflects exactly what landed.
      selectedTargets = new Set(result.metadata.allowed_targets);
      displayName = result.metadata.display_name ?? "";
      author = result.metadata.author ?? "";
      baseTargets = [...result.metadata.allowed_targets].sort().join(",");
      baseDisplay = result.metadata.display_name ?? "";
      baseAuthor = result.metadata.author ?? "";
      saveCue = metadataSaveCue(result.committed, result.commit_error);
      commitError = result.commit_error;
      confirmDrop = null;
      overlaysRes.reload(); // a dropped target's overlay was deleted
      onSaved(); // parent: reload detail → re-drive the overlay tab strip + rail
    } catch (e) {
      if (e instanceof LibraryApiError && e.code === "library_target_removed_with_overlays") {
        // The two-phase confirm: name the orphaned paths (O1), then re-issue.
        confirmDrop = droppedWithOverlays();
      } else {
        error = metadataMessage(e);
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="meta-form">
  <div class="meta-row">
    <label class="meta-field">
      <span class="u-label">Display name</span>
      <Input
        placeholder="(none)"
        bind:value={displayName}
        disabled={saving}
        oninput={() => {
          saveCue = null;
          confirmDrop = null;
        }}
      />
    </label>
    <label class="meta-field">
      <span class="u-label">Author</span>
      <Input
        placeholder="(none)"
        bind:value={author}
        disabled={saving}
        oninput={() => {
          saveCue = null;
          confirmDrop = null;
        }}
      />
    </label>
  </div>

  <fieldset class="meta-targets">
    <legend>Allowed targets</legend>
    <p class="meta-hint">Only targets this kind can ship to are offered.</p>
    <div class="target-checks">
      {#each kindAllowedTargets as t (t)}
        <Checkbox checked={selectedTargets.has(t)} disabled={saving} onchange={() => toggleTarget(t)}>
          <span class="mono">{t}</span>
        </Checkbox>
      {/each}
    </div>
  </fieldset>

  {#if confirmDrop}
    <Callout tone="warn" role="alertdialog">
      <div class="confirm-bar">
        <div class="confirm-text">
          {#if confirmDrop.length}
            <strong>Dropping these targets will delete their overlay file(s):</strong>
            <ul>
              {#each confirmDrop as d (d.target)}
                <li><span class="mono">{d.target}</span> — {d.paths.join(", ")}</li>
              {/each}
            </ul>
          {:else}
            <strong>Dropping a target will delete its overlay file(s).</strong>
          {/if}
        </div>
        <span class="confirm-actions">
          <Button variant="danger" size="sm" disabled={saving} onclick={() => save(true)}>
            {saving ? "Discarding…" : "Discard overlay(s) and save"}
          </Button>
          <Button variant="ghost" size="sm" disabled={saving} onclick={() => (confirmDrop = null)}>
            Cancel
          </Button>
        </span>
      </div>
    </Callout>
  {/if}

  <div class="meta-actions">
    <Badge tone={dirtyCue.tone}>{dirtyCue.glyph} {dirtyCue.label}</Badge>
    <Button variant="primary" size="sm" disabled={!isDirty || saving} onclick={() => save(false)}>
      {saving ? "Saving…" : "Save metadata"}
    </Button>
    {#if saveCue}
      <span class="save-cue tone-{saveCue.tone}" role="status">
        {saveCue.glyph} {saveCue.label}{#if commitError && saveCue.tone === "amber"} — {commitError.split("\n")[0]}{/if}
      </span>
    {/if}
  </div>

  {#if error}
    <Callout tone="warn" role="alert">{error}</Callout>
  {/if}
</div>

<style>
  .meta-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
  }
  .meta-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .meta-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 160px;
  }
  .meta-targets {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px 10px;
    margin: 0;
  }
  .meta-targets legend {
    font-size: 11px;
    color: var(--text-dim);
    padding: 0 4px;
  }
  .meta-hint {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--text-subtle);
  }
  .target-checks {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .confirm-bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    width: 100%;
  }
  .confirm-text ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .confirm-text li {
    margin: 2px 0;
  }
  .confirm-actions {
    display: inline-flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .meta-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .save-cue {
    font-size: 12px;
  }
  /* CVD-safe tones — cyan/amber/default only, never a bare red/green (Scott is
     red/green colorblind). The glyph + label carry the meaning; hue reinforces. */
  .tone-amber {
    color: var(--amber);
  }
  .tone-default {
    color: var(--text-subtle);
  }
</style>
