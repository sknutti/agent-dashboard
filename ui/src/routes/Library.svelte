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
  import TargetOverlayPane from "../lib/components/TargetOverlayPane.svelte";
  import MetadataForm from "../lib/components/MetadataForm.svelte";
  import BootstrapWizard from "../lib/components/BootstrapWizard.svelte";
  import GitSyncPanel from "../lib/components/GitSyncPanel.svelte";
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
    reimportInstall,
    flattenPrimitive,
    listOverlays,
    importInstalls,
    publishVersion,
    setCurrentVersion,
    revertToVersion,
    readPrimitiveVersion,
    searchLibrary,
    createPrimitive,
    fetchPrimitiveFromUrl,
    deletePrimitive,
    renamePrimitive,
    duplicatePrimitive,
    importFromPath,
    LibraryApiError,
    type LibraryKind,
    type LibraryFetchedPrimitive,
    type LibraryTarget,
    type LibraryInstallSummary,
    type LibraryUninstallSummary,
    type LibraryPublishResult,
    type LibraryReimportResult,
    type LibraryFlattenResult,
    type LibraryTargetConflict,
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
    reimportResultCue,
    flattenResultCue,
    anyDrift,
    publishStateCue,
    currentVersionCue,
    lifecycleCommitCue,
    renameInstallCaveat,
    deleteResultCue,
    importResultCue,
    orphanInstalls,
    KIND_LABELS,
    KIND_ORDER,
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

  // ── content search (search slice) ─────────────────────────────────────────
  // DISTINCT from the `query` name-filter above: this searches each primitive's
  // working-copy PRIMARY file CONTENT via the Rust `find_in_library` bridge. The
  // typed term updates immediately (input value); a DEBOUNCED copy drives the
  // resource key so we spawn at most one bridge process per ~250ms pause, not
  // per keystroke. No useEffect — the debounce is a timer cleared in the input
  // handler; the refetch is resource()-key-driven.
  const SEARCH_PREFIX = "library:search:";
  const SEARCH_IDLE = `${SEARCH_PREFIX}idle`;
  const SEARCH_DEBOUNCE_MS = 250;
  let searchTerm = $state("");
  let debouncedTerm = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function onSearchInput(value: string): void {
    searchTerm = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      debouncedTerm = searchTerm;
    }, SEARCH_DEBOUNCE_MS);
  }
  function clearSearch(): void {
    clearTimeout(searchTimer);
    searchTerm = "";
    debouncedTerm = "";
  }

  // An empty (or unconfigured) term short-circuits to the idle key → no bridge
  // call. The trimmed needle is encoded into the key so the fetcher reads it
  // back from `k` (never from reactive state inside run() — see resource.svelte).
  const searchKey = $derived.by(() => {
    const q = debouncedTerm.trim();
    return valid && q !== "" ? `${SEARCH_PREFIX}${q}` : SEARCH_IDLE;
  });
  const searchRes = resource(
    () => searchKey,
    (k) => (k === SEARCH_IDLE ? Promise.resolve([]) : searchLibrary(k.slice(SEARCH_PREFIX.length))),
  );
  const searching = $derived(debouncedTerm.trim() !== "");
  const searchHits = $derived(searchRes.data ?? []);

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

  // After a metadata save: reload the detail (re-drives the overlay tab strip +
  // the rail from the new allowed_targets — the Slice 5 forward coupling) and the
  // primitive list (the author column may have changed). The drift read too: a
  // narrowed allowed_targets can orphan an install. Event-handler driven, no effect.
  function onMetadataSaved(): void {
    detailRes.reload();
    primitivesRes.reload();
    driftDetailRes.reload();
    driftBatchRes.reload();
  }

  // Decision 3 — an overlay edit changes what a FUTURE install deploys; it does
  // NOT re-install, so an already-installed target reads as drifted on the next
  // scan. We don't re-implement drift (the existing scan detects it); we just
  // EXPLAIN it: track which targets had an overlay edited this session and, if
  // such a target carries an install record, show an inline reinstall note next
  // to its install row. Reset when the selection changes (the set is keyed to the
  // open primitive). Event-handler driven (no effect): set on the pane's callback.
  let overlayEditedTargets = $state<Set<LibraryTarget>>(new Set());
  function onOverlayWrite(target: LibraryTarget): void {
    overlayEditedTargets = new Set(overlayEditedTargets).add(target);
    // The on-disk install now differs from the edited merged source — refresh the
    // drift read so the row's state cue catches up alongside the explanation.
    driftDetailRes.reload();
    driftBatchRes.reload();
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
    overlayEditedTargets = new Set(); // the reinstall note is scoped to the open primitive
    // Reimport surfaces are scoped to the open primitive too — never leak a form,
    // a pending confirm/fix sheet, or a notice across a selection change.
    reimportForm = null;
    reimportDirty = null;
    reimportBroken = null;
    reimportNotice = null;
    // Flatten surfaces are scoped to the open primitive too.
    flattenForm = null;
    flattenConflicts = null;
    flattenNotice = null;
    flattenLabel = "";
    flattenNotes = "";
    // Lifecycle surfaces are scoped to the open primitive too — never leak a
    // rename/duplicate/delete confirm or a success banner across a selection.
    renameDialog = null;
    duplicateDialog = null;
    deleteDialog = null;
    lifecycleNotice = null;
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

  // ── reimport-from-drift (reimport slice) ──────────────────────────────────
  // Reimport is the THIRD drift-row action (beside Acknowledge + Reinstall): it
  // pulls the on-disk drifted bytes back into the library as a new version — the
  // INVERSE of Reinstall. Reinstall overwrites the disk with the library;
  // Reimport-with-discard overwrites the working copy with the disk. Both name
  // their direction in the confirm copy so the two destructive actions can't be
  // confused (CVD-safe: distinguished by label + glyph + words, never color).
  interface ReimportIntent {
    kind: LibraryKind;
    name: string;
    target: LibraryTarget;
    label: string;
    notes: string;
  }
  // The open reimport form (which target it captures). Null = closed. A small
  // form like publish — reimport IS a publish of foreign bytes, so it needs a
  // version label.
  let reimportForm = $state<{ kind: LibraryKind; name: string; target: LibraryTarget } | null>(null);
  let reimportLabel = $state("");
  let reimportNotes = $state("");
  // The discard-working confirm (captured intent, D2): working/ has unpublished
  // edits; confirming retries with discard_working:true.
  let reimportDirty = $state<ReimportIntent | null>(null);
  // The broken-source fix sheet: a LOCAL editable buffer seeded from the on-disk
  // bytes (never resource-bound — the Slice 3 editor-buffer lesson). `discard` is
  // threaded so a dirty→discard→broken chain retries with discard still set.
  let reimportBroken = $state<{
    intent: ReimportIntent;
    discard: boolean;
    primaryPath: string;
    parseError: string;
    text: string;
  } | null>(null);
  let reimportNotice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);

  /** Lossy UTF-8 decode of the on-disk primary bytes for the fix buffer. A
   *  non-UTF-8 byte shows as the replacement char; the retry re-encodes and core
   *  re-validates (Open Q2). */
  function decodeBytes(bytes: number[]): string {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /** Open the reimport form for one drifted target. */
  function openReimport(target: LibraryTarget): void {
    if (!detail) return;
    reimportForm = { kind: detail.kind, name: detail.name, target };
    reimportLabel = "";
    reimportNotes = "";
    reimportNotice = null;
  }
  function closeReimport(): void {
    reimportForm = null;
    reimportLabel = "";
    reimportNotes = "";
  }

  /** Validate the label client-side (the publish-form `^v\d` hint), capture the
   *  intent, and dispatch the first attempt. */
  async function submitReimport(): Promise<void> {
    if (!reimportForm) return;
    const label = reimportLabel.trim();
    if (!/^v\d/.test(label)) {
      reimportNotice = {
        tone: "amber",
        text: "A version label looks like v1, v2, or v1.0 — start with “v” and a number.",
      };
      return;
    }
    await doReimport({ ...reimportForm, label, notes: reimportNotes.trim() });
  }

  /** Issue a reimport and route on the result. `discard` confirms blowing away
   *  unpublished working edits; `fixedText` is the broken-source retry payload.
   *  Keyed pending-write lock (D2) so a row's reimport can't double-fire. */
  async function doReimport(
    intent: ReimportIntent,
    discard = false,
    fixedText: string | null = null,
  ): Promise<void> {
    const key = writeKey(intent.kind, intent.name, intent.target);
    if (pending.has(key)) return;
    setPending(key, true);
    reimportNotice = null;
    try {
      const result = await reimportInstall(intent.kind, intent.name, {
        source_target: intent.target,
        version_label: intent.label,
        notes: intent.notes || undefined,
        discard_working: discard,
        fixed_primary_text: fixedText ?? undefined,
      });
      applyReimportResult(intent, result, discard);
    } catch (e) {
      reimportNotice = { tone: "amber", text: noticeFor(e, "Couldn’t reimport these edits.") };
    } finally {
      setPending(key, false);
      reloadInstallState();
    }
  }

  function applyReimportResult(
    intent: ReimportIntent,
    result: LibraryReimportResult,
    discard: boolean,
  ): void {
    const cue = reimportResultCue(result);
    switch (result.kind) {
      case "reimported":
        // The drifted edits are now a library version. Clear every reimport
        // surface and reload the detail (versions grew + current advanced + the
        // dirty badge) and the list.
        reimportForm = null;
        reimportDirty = null;
        reimportBroken = null;
        reimportNotice = { tone: cue.tone, text: `${intent.target}: ${cue.label} as ${result.new_version}` };
        detailRes.reload();
        primitivesRes.reload();
        break;
      case "working_copy_dirty":
        // Hand off to the discard confirm (captured intent).
        reimportDirty = intent;
        break;
      case "broken_source":
        // Hand off to the fix sheet with a LOCAL buffer; preserve `discard` so a
        // dirty→discard→broken chain retries with discard still set.
        reimportBroken = {
          intent,
          discard,
          primaryPath: result.primary_path,
          parseError: result.parse_error,
          text: decodeBytes(result.raw_bytes),
        };
        break;
      case "not_installed":
      case "install_missing":
        // Shouldn't reach a Modified row, but a stale UI mustn't dead-end.
        reimportForm = null;
        reimportNotice = { tone: cue.tone, text: `${intent.target}: ${cue.label}` };
        break;
    }
  }

  function confirmReimportDiscard(): void {
    const intent = reimportDirty;
    if (!intent) return;
    reimportDirty = null;
    void doReimport(intent, true);
  }

  function saveReimportFix(): void {
    const sheet = reimportBroken;
    if (!sheet) return;
    const text = sheet.text;
    const { intent, discard } = sheet;
    reimportBroken = null;
    void doReimport(intent, discard, text);
  }

  // ── flatten: promote an overlay into the base (ADR-0009) ──────────────────
  // Flatten is offered ONLY for overlay-bearing targets (base-followers have
  // nothing to promote). It snapshots a new version, converges base-follower
  // installs on disk, and clears drift. The converging targets are surfaced
  // BEFORE confirm; a hand-edited converging install routes to a force confirm.
  const flattenOverlaysRes = resource(
    () => selected ?? "library:none",
    (k) => {
      const sel = parseSelection(k);
      return sel ? listOverlays(sel.kind, sel.name) : Promise.resolve([]);
    },
  );
  // Targets that carry an overlay → the only ones eligible to flatten.
  const flattenEligibleTargets = $derived(
    new Set((flattenOverlaysRes.data ?? []).map((o) => o.target)),
  );

  interface FlattenIntent {
    kind: LibraryKind;
    name: string;
    source_target: LibraryTarget;
    label: string;
    notes: string;
  }
  let flattenForm = $state<{ kind: LibraryKind; name: string; source_target: LibraryTarget } | null>(
    null,
  );
  let flattenLabel = $state("");
  let flattenNotes = $state("");
  // The converging-conflict confirm: captured intent + the blocking targets. A
  // force retry overwrites the hand-edited installs (D4 two-phase confirm).
  let flattenConflicts = $state<{ intent: FlattenIntent; conflicts: LibraryTargetConflict[] } | null>(
    null,
  );
  let flattenNotice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);

  /** Base-follower targets a flatten of `source` would rewrite on disk: allowed,
   *  no overlay, not the source, and currently installed. Surfaced before confirm
   *  (ADR consequence: "must surface which targets will change"). */
  function convergingPreview(source: LibraryTarget): LibraryTarget[] {
    return targetRows
      .filter((r) => r.target !== source && !flattenEligibleTargets.has(r.target) && r.installed)
      .map((r) => r.target);
  }

  function openFlatten(source: LibraryTarget): void {
    if (!detail) return;
    flattenForm = { kind: detail.kind, name: detail.name, source_target: source };
    flattenLabel = "";
    flattenNotes = "";
    flattenNotice = null;
  }
  function closeFlatten(): void {
    flattenForm = null;
    flattenLabel = "";
    flattenNotes = "";
  }

  async function submitFlatten(): Promise<void> {
    if (!flattenForm) return;
    const label = flattenLabel.trim();
    if (!/^v\d/.test(label)) {
      flattenNotice = {
        tone: "amber",
        text: "A version label looks like v1, v2, or v1.0 — start with “v” and a number.",
      };
      return;
    }
    await doFlatten({ ...flattenForm, label, notes: flattenNotes.trim() }, false);
  }

  /** Issue a flatten and route on the result. `force` overwrites hand-edited
   *  converging installs. Keyed pending-write lock so a row can't double-fire. */
  async function doFlatten(intent: FlattenIntent, force: boolean): Promise<void> {
    const key = writeKey(intent.kind, intent.name, intent.source_target);
    if (pending.has(key)) return;
    setPending(key, true);
    flattenNotice = null;
    try {
      const result = await flattenPrimitive(intent.kind, intent.name, {
        source_target: intent.source_target,
        version_label: intent.label,
        notes: intent.notes || undefined,
        force,
      });
      applyFlattenResult(intent, result);
    } catch (e) {
      flattenNotice = { tone: "amber", text: noticeFor(e, "Couldn’t flatten this overlay.") };
    } finally {
      setPending(key, false);
      reloadInstallState();
    }
  }

  function applyFlattenResult(intent: FlattenIntent, result: LibraryFlattenResult): void {
    const cue = flattenResultCue(result);
    switch (result.kind) {
      case "flattened":
        // The overlay is now the base + a new version; converging installs were
        // rewritten and drift cleared. Reset every flatten surface and reload.
        flattenForm = null;
        flattenConflicts = null;
        flattenNotice = {
          tone: cue.tone,
          text: `${intent.source_target}: ${cue.label} as ${result.new_version}`,
        };
        detailRes.reload();
        primitivesRes.reload();
        flattenOverlaysRes.reload();
        break;
      case "converging_conflicts":
        // Hand off to the force confirm (captured intent + the blocking targets).
        flattenConflicts = { intent, conflicts: result.conflicts };
        break;
      case "working_copy_dirty":
      case "not_an_overlay_target":
      case "no_current_version":
        flattenForm = null;
        flattenNotice = { tone: cue.tone, text: `${intent.source_target}: ${cue.label}` };
        break;
    }
  }

  function confirmFlattenForce(): void {
    const captured = flattenConflicts;
    if (!captured) return;
    flattenConflicts = null;
    void doFlatten(captured.intent, true);
  }
  function cancelFlattenForce(): void {
    flattenConflicts = null;
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

  // ── primitive lifecycle (lifecycle slice) ─────────────────────────────────
  // Structural CRUD: create / delete / rename / duplicate / import-from-path.
  // (forget is a reconcile action with no natural home in this surface until the
  // bootstrap wizard's Reconcile view — Slice 2 — so it is intentionally NOT
  // wired here; its bridge/route/fetcher ship ready for that slice.)
  //
  // Every op is event-handler-driven (.reload() after the write, never an
  // effect) and routes a route-local LibraryApiError to an INLINE notice (never
  // the shell). Delete is the headline: a two-phase confirm that lists the blast
  // radius (installed targets + version count) from already-loaded data, fires
  // nothing before the second confirm, locks the confirm button in-flight, and
  // surfaces a bailed force-uninstall instead of reporting false success.
  let lifecycleBusy = $state(false);
  // A transient, colorblind-safe success banner shown after a create / rename /
  // duplicate / import (the affected primitive is reloaded + selected).
  let lifecycleNotice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);

  // Bootstrap discovery wizard (bootstrap slice) — the first-run scan→import flow
  // + the Reconcile/forget tab. Orphaned install records (a ledger row with no
  // library primitive) are derived from the reads this route already holds
  // (driftBatch + primitives), so the Reconcile tab needs no new fetch.
  let bootstrapOpen = $state(false);
  const orphans = $derived(orphanInstalls(driftBatch, primitives));

  // Git remote sync panel (Slice 8) — library-wide push/pull, opened from the
  // explorer header like the bootstrap wizard. onChanged reloads the status read
  // so the rail's git summary (branch · unpushed) reflects a push/pull.
  let gitSyncOpen = $state(false);

  function onBootstrapImported(): void {
    primitivesRes.reload();
    driftBatchRes.reload();
  }

  // Create form (collection-level): kind select + name input; an inline error on
  // a collision/invalid-name, never a shell toast.
  let createOpen = $state(false);
  let createKind = $state<LibraryKind>("skill");
  let createName = $state("");
  let createNotice = $state<{ tone: "amber"; text: string } | null>(null);
  // URL import (Slice 10b): the fetched preview, stashed so `doCreate` can
  // forward it as the `imported` seed. It is INVALIDATED whenever the URL input
  // changes (`onUrlInput`) — so a fetch of URL A followed by editing to B never
  // creates A's content (stale-fetch guard; event-driven, no effect).
  let createUrl = $state("");
  let createFetched = $state<LibraryFetchedPrimitive | null>(null);
  let createFetching = $state(false);

  function openCreate(): void {
    createOpen = true;
    createKind = "skill";
    createName = "";
    createNotice = null;
    createUrl = "";
    createFetched = null;
  }

  /** Editing the URL invalidates a prior fetch — the stash only ever holds the
   *  preview for the CURRENT URL, so `doCreate` can forward it safely. */
  function onUrlInput(): void {
    createFetched = null;
  }

  async function doFetch(): Promise<void> {
    if (createFetching) return;
    const url = createUrl.trim();
    if (!url) {
      createNotice = { tone: "amber", text: "Paste a GitHub file or SKILL.md URL to fetch." };
      return;
    }
    createFetching = true;
    createNotice = null;
    try {
      const fetched = await fetchPrimitiveFromUrl(url);
      createFetched = fetched;
      // Pre-fill the name from the URL's stem (editable); never clobber a name
      // the user already typed.
      if (!createName.trim() && fetched.suggested_name) createName = fetched.suggested_name;
    } catch (e) {
      createFetched = null;
      createNotice = { tone: "amber", text: noticeFor(e, "Couldn’t fetch from that URL.") };
    } finally {
      createFetching = false;
    }
  }

  async function doCreate(): Promise<void> {
    if (lifecycleBusy) return;
    const name = createName.trim();
    if (!name) {
      createNotice = { tone: "amber", text: "Enter a name for the new primitive." };
      return;
    }
    lifecycleBusy = true;
    createNotice = null;
    try {
      // `createFetched` is non-null ONLY when it matches the current URL (cleared
      // on every URL edit) — so a stale fetch can never seed the create (D5/D1).
      // Pass the seed arg ONLY when present, so the empty-create call stays the
      // unchanged 2-arg form.
      const res = createFetched
        ? await createPrimitive(createKind, name, createFetched)
        : await createPrimitive(createKind, name);
      createOpen = false;
      primitivesRes.reload();
      selectPrimitive(selectionKey(createKind, name));
      const cue = lifecycleCommitCue(res.committed, res.commit_error);
      const how = createFetched ? `Imported ${name}` : `Created ${name}`;
      lifecycleNotice = { tone: cue.tone, text: `${how} · ${cue.label}` };
    } catch (e) {
      createNotice = { tone: "amber", text: noticeFor(e, "Couldn’t create the primitive.") };
    } finally {
      lifecycleBusy = false;
    }
  }

  // Import-from-path: a TYPED path (the 10a web redesign — no native picker). The
  // tagged result routes the UI; only `imported` reloads+selects.
  let importPathOpen = $state(false);
  let importPathValue = $state("");
  let importPathNotice = $state<{ tone: "default" | "amber" | "cyan"; text: string } | null>(null);

  function openImportPath(): void {
    importPathOpen = true;
    importPathValue = "";
    importPathNotice = null;
  }

  async function doImportFromPath(): Promise<void> {
    if (lifecycleBusy) return;
    const path = importPathValue.trim();
    if (!path) {
      importPathNotice = { tone: "amber", text: "Enter the path to import." };
      return;
    }
    lifecycleBusy = true;
    importPathNotice = null;
    try {
      const res = await importFromPath(path);
      const cue = importResultCue(res);
      if (res.kind === "imported") {
        importPathOpen = false;
        primitivesRes.reload();
        selectPrimitive(selectionKey(res.primitive_kind, res.name));
        lifecycleNotice = { tone: cue.tone, text: `Imported ${res.name} · ${cue.label}` };
      } else if (res.kind === "already_exists") {
        importPathOpen = false;
        primitivesRes.reload();
        selectPrimitive(selectionKey(res.primitive_kind, res.name));
        lifecycleNotice = { tone: cue.tone, text: `${res.name} is already in the library` };
      } else {
        // not_classifiable — keep the dialog open with guidance toward bootstrap.
        importPathNotice = { tone: cue.tone, text: `${cue.label}. (${res.reason})` };
      }
    } catch (e) {
      importPathNotice = { tone: "amber", text: noticeFor(e, "Couldn’t import from that path.") };
    } finally {
      lifecycleBusy = false;
    }
  }

  // Rename / duplicate share a captured-intent dialog shape ({kind,name,newName},
  // D2): the confirm re-issues against the SNAPSHOT, so a selection change across
  // the await can't redirect the write.
  let renameDialog = $state<{ kind: LibraryKind; name: string; newName: string } | null>(null);
  let renameNotice = $state<{ tone: "amber"; text: string } | null>(null);

  function askRename(): void {
    if (!detail) return;
    renameDialog = { kind: detail.kind, name: detail.name, newName: detail.name };
    renameNotice = null;
  }

  async function confirmRename(): Promise<void> {
    const intent = renameDialog;
    if (!intent || lifecycleBusy) return;
    const newName = intent.newName.trim();
    if (!newName || newName === intent.name) {
      renameNotice = { tone: "amber", text: "Enter a different name." };
      return;
    }
    lifecycleBusy = true;
    renameNotice = null;
    try {
      const res = await renamePrimitive(intent.kind, intent.name, newName);
      renameDialog = null;
      primitivesRes.reload();
      reloadInstallState(); // records were migrated to the new name
      selectPrimitive(selectionKey(intent.kind, newName));
      const cue = lifecycleCommitCue(res.committed, res.commit_error);
      const caveat = renameInstallCaveat(res.install_records_updated);
      lifecycleNotice = {
        tone: caveat ? "amber" : cue.tone,
        text: `Renamed to ${newName} · ${cue.label}${caveat ? ` — ${caveat}` : ""}`,
      };
    } catch (e) {
      renameNotice = { tone: "amber", text: noticeFor(e, "Couldn’t rename the primitive.") };
    } finally {
      lifecycleBusy = false;
    }
  }

  let duplicateDialog = $state<{ kind: LibraryKind; name: string; newName: string } | null>(null);
  let duplicateNotice = $state<{ tone: "amber"; text: string } | null>(null);

  function askDuplicate(): void {
    if (!detail) return;
    duplicateDialog = { kind: detail.kind, name: detail.name, newName: `${detail.name}-copy` };
    duplicateNotice = null;
  }

  async function confirmDuplicate(): Promise<void> {
    const intent = duplicateDialog;
    if (!intent || lifecycleBusy) return;
    const newName = intent.newName.trim();
    if (!newName || newName === intent.name) {
      duplicateNotice = { tone: "amber", text: "Enter a name for the copy." };
      return;
    }
    lifecycleBusy = true;
    duplicateNotice = null;
    try {
      const res = await duplicatePrimitive(intent.kind, intent.name, newName);
      duplicateDialog = null;
      primitivesRes.reload();
      selectPrimitive(selectionKey(intent.kind, res.new_name));
      const cue = lifecycleCommitCue(res.committed, res.commit_error);
      lifecycleNotice = { tone: cue.tone, text: `Duplicated to ${res.new_name} · ${cue.label}` };
    } catch (e) {
      duplicateNotice = { tone: "amber", text: noticeFor(e, "Couldn’t duplicate the primitive.") };
    } finally {
      lifecycleBusy = false;
    }
  }

  // Delete — the headline two-phase, captured-intent confirm. Snapshots the blast
  // radius (installed targets + version count) at OPEN time from already-loaded
  // data (D2/A4), so the confirm shows exactly what gets wiped and a selection
  // change across the await can't redirect the delete. The confirm button is
  // locked in-flight (lifecycleBusy). No request fires before the second confirm.
  let deleteDialog = $state<{
    kind: LibraryKind;
    name: string;
    installedTargets: LibraryTarget[];
    versionCount: number;
  } | null>(null);
  let deleteNotice = $state<{ tone: "amber"; text: string } | null>(null);

  function askDelete(): void {
    if (!detail) return;
    deleteDialog = {
      kind: detail.kind,
      name: detail.name,
      installedTargets: installs.map((i) => i.target),
      versionCount: detail.versions.length,
    };
    deleteNotice = null;
  }

  async function confirmDelete(): Promise<void> {
    const intent = deleteDialog;
    if (!intent || lifecycleBusy) return;
    lifecycleBusy = true;
    deleteNotice = null;
    try {
      const res = await deletePrimitive(intent.kind, intent.name);
      if (!res.library_dir_removed) {
        // A bailed force-uninstall: the library was NOT deleted. Surface the
        // unreachable targets in the dialog instead of reporting false success.
        const targets = res.uninstall.failures.map((f) => f.target).join(", ");
        deleteNotice = {
          tone: "amber",
          text: `Not deleted — couldn’t uninstall from ${targets || "a target"}. Resolve on disk and retry.`,
        };
        reloadInstallState();
        return;
      }
      deleteDialog = null;
      selected = null; // the selection no longer resolves — clear it
      primitivesRes.reload();
      driftBatchRes.reload();
      const cue = deleteResultCue(res.library_dir_removed, res.commit_error);
      lifecycleNotice = { tone: cue.tone, text: `Deleted ${intent.name} · ${cue.label}` };
    } catch (e) {
      deleteNotice = { tone: "amber", text: noticeFor(e, "Couldn’t delete the primitive.") };
    } finally {
      lifecycleBusy = false;
    }
  }
</script>

<div class="library">
  <!-- Bootstrap discovery wizard (bootstrap slice): the first-run scan→review→
       execute flow + the Reconcile/forget tab. Rendered at the TOP of the
       library column (`.library` is a flex-column) so it's visible just above
       the panels when opened — not pushed off-screen at the bottom. Reloads the
       primitives + drift reads after an import or a forget. -->
  {#if bootstrapOpen}
    <BootstrapWizard
      {orphans}
      onClose={() => (bootstrapOpen = false)}
      onImported={onBootstrapImported}
      onForgotten={() => driftBatchRes.reload()}
    />
  {/if}

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
          <div class="head-actions">
            <Badge>{filtered.length} items</Badge>
            <button type="button" class="head-btn" title="Create a new primitive" onclick={openCreate}>
              <Icon name="plus" size={13} /> New
            </button>
            <button
              type="button"
              class="head-btn"
              title="Import a primitive from a local install path"
              onclick={openImportPath}
            >
              <Icon name="folder" size={13} /> Import
            </button>
            <button
              type="button"
              class="head-btn"
              title="Scan your machine for existing primitives to import"
              onclick={() => (bootstrapOpen = true)}
            >
              <Icon name="search" size={13} /> Bootstrap
              {#if orphans.length}<span class="head-badge" title="orphaned install records to reconcile">{orphans.length}</span>{/if}
            </button>
            <button
              type="button"
              class="head-btn"
              title="Push, pull, and configure the git remote"
              onclick={() => (gitSyncOpen = true)}
            >
              <Icon name="git-branch" size={13} /> Sync
            </button>
          </div>
        </div>
        {#if lifecycleNotice}
          <div
            class="route-notice"
            class:warn={lifecycleNotice.tone === "amber"}
            class:info={lifecycleNotice.tone === "cyan"}
            role="status"
          >
            {lifecycleNotice.text}
          </div>
        {/if}
        <label class="search">
          <Icon name="search" size={14} />
          <input type="text" bind:value={query} placeholder="Filter primitives" />
        </label>
        <!-- Content search (search slice): distinct from the name filter above —
             searches each primitive's working-copy primary file via the bridge. -->
        <label class="search content-search">
          <Icon name="file-text" size={14} />
          <input
            type="text"
            value={searchTerm}
            oninput={(e) => onSearchInput(e.currentTarget.value)}
            placeholder="Search file contents"
            aria-label="Search primitive file contents"
          />
          {#if searchTerm}
            <button type="button" class="search-clear" title="Clear search" onclick={clearSearch}>
              <Icon name="x" size={13} />
            </button>
          {/if}
        </label>

        {#if searching}
          <section class="search-results" aria-label="Content search results">
            {#if searchRes.loading && !searchRes.data}
              <div class="muted">Searching…</div>
            {:else if searchRes.error}
              <EmptyState icon="alert" title="Search failed" error={true} onRetry={searchRes.reload} />
            {:else if !searchHits.length}
              <EmptyState icon="search" title="No content matches" message={`Nothing in any primitive matches “${debouncedTerm.trim()}”.`} />
            {:else}
              <div class="search-head">
                <span class="group-label">Content matches</span>
                <span class="group-count">{searchHits.length}</span>
              </div>
              <div class="hit-list">
                {#each searchHits as hit, i (hit.kind + "/" + hit.name + ":" + hit.line_number + ":" + i)}
                  {@const hitKey = selectionKey(hit.kind, hit.name)}
                  <button
                    type="button"
                    class="hit"
                    class:selected={selected === hitKey}
                    onclick={() => selectPrimitive(hitKey)}
                  >
                    <span class="hit-head">
                      <span class="hit-name">{hit.name}</span>
                      <Badge tone={kindTone(hit.kind)}>{KIND_LABELS[hit.kind]}</Badge>
                      <small class="hit-line">L{hit.line_number}</small>
                    </span>
                    <code class="hit-text">{hit.line_text}</code>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

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
            <div class="head-right">
              <Badge tone={headCue.tone}>{headCue.glyph} {headCue.label}</Badge>
              <div class="doc-actions">
                <button type="button" class="head-btn" title="Rename this primitive" onclick={askRename}>
                  <Icon name="edit" size={13} /> Rename
                </button>
                <button type="button" class="head-btn" title="Duplicate this primitive" onclick={askDuplicate}>
                  <Icon name="layers" size={13} /> Duplicate
                </button>
                <button
                  type="button"
                  class="head-btn danger-btn"
                  title="Delete this primitive from the library"
                  onclick={askDelete}
                >
                  <Icon name="trash" size={13} /> Delete
                </button>
              </div>
            </div>
          </header>

          <!-- Editable metadata (display_name / author / allowed_targets) — keyed
               on the primitive so it REMOUNTS on selection change (no-useEffect
               buffer reset). Target checkboxes are constrained to the kind's
               matrix (Decision 4). Editing allowed_targets re-drives the overlay
               tab strip below after the post-save detail reload. -->
          <section class="metadata-section">
            <h4>Metadata</h4>
            {#key detail.kind + "/" + detail.name}
              <MetadataForm
                kind={detail.kind}
                name={detail.name}
                metadata={detail.metadata}
                kindAllowedTargets={kindInfo.data?.[detail.kind]?.allowed_targets ?? []}
                onSaved={onMetadataSaved}
              />
            {/key}
          </section>

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

          <!-- Per-target overlays: edit the target-specific primary delta that
               shadows the base primary at install. Tabs are driven by
               allowed_targets (a disallowed target 422s in-core). Keyed on the
               primitive so it remounts on selection change (no-useEffect reset). -->
          {#if detail.metadata.allowed_targets.length}
            <section class="overlays-section">
              <h4>Target overlays</h4>
              <p class="muted-line">
                Craft a target-specific version of the primary file. An overlay shadows the base primary
                for just that target at install — leave a target without one to install the base.
              </p>
              {#key detail.kind + "/" + detail.name}
                <TargetOverlayPane
                  kind={detail.kind}
                  name={detail.name}
                  allowedTargets={detail.metadata.allowed_targets}
                  {onOverlayWrite}
                />
              {/key}
            </section>
          {/if}

          <!-- Flatten (ADR-0009): promote one target's overlay into the base.
               Offered ONLY for overlay-bearing targets; surfaces which
               base-follower installs will be rewritten before confirm. -->
          {#if flattenEligibleTargets.size}
            <section class="flatten-section">
              <h4>Flatten an overlay into the base</h4>
              <p class="muted-line">
                Promote a target's overlay so it becomes the shared base. Base-follower targets
                converge to it; other overlay targets keep their own. Snapshots a new version and
                clears drift.
              </p>
              <ul class="flatten-list">
                {#each targetRows.filter((r) => flattenEligibleTargets.has(r.target)) as row (row.target)}
                  <li class="flatten-row">
                    <span class="mono">{row.target}</span> overlay
                    <button
                      type="button"
                      class="ghost"
                      onclick={() => openFlatten(row.target)}
                      disabled={isPending(detail.kind, detail.name, row.target)}
                    >
                      Flatten into base…
                    </button>
                  </li>
                {/each}
              </ul>

              {#if flattenForm}
                {@const converging = convergingPreview(flattenForm.source_target)}
                <div class="flatten-form" role="group" aria-label="Flatten overlay into base">
                  <p>
                    Promote the <span class="mono">{flattenForm.source_target}</span> overlay into the base.
                  </p>
                  {#if converging.length}
                    <p class="muted-line">
                      Rewritten on disk to match the new base: {converging.join(", ")}.
                    </p>
                  {:else}
                    <p class="muted-line">No installed base-follower targets to rewrite.</p>
                  {/if}
                  <label>
                    New version
                    <input type="text" bind:value={flattenLabel} placeholder="v2" />
                  </label>
                  <label>
                    Notes (optional)
                    <input type="text" bind:value={flattenNotes} />
                  </label>
                  <div class="flatten-actions">
                    <button type="button" onclick={submitFlatten}>Flatten</button>
                    <button type="button" class="ghost" onclick={closeFlatten}>Cancel</button>
                  </div>
                </div>
              {/if}

              {#if flattenConflicts}
                <div class="flatten-conflicts" role="alert">
                  <p>
                    These installed copies were edited and will be overwritten:
                    <span class="mono">{flattenConflicts.conflicts.map((c) => c.target).join(", ")}</span>.
                  </p>
                  <div class="flatten-actions">
                    <button type="button" onclick={confirmFlattenForce}>Flatten anyway (overwrite)</button>
                    <button type="button" class="ghost" onclick={cancelFlattenForce}>Cancel</button>
                  </div>
                </div>
              {/if}

              {#if flattenNotice}
                <div class="route-notice" class:warn={flattenNotice.tone === "amber"} role="status">
                  {flattenNotice.text}
                </div>
              {/if}
            </section>
          {/if}

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
                  {@const overlayStale = overlayEditedTargets.has(row.target) && row.installed !== null}
                  <div class="target-row" data-target={row.target}>
                    <span class="target-name mono">{row.target}</span>
                    <Badge tone={cue.tone}>{cue.glyph} {cue.label}</Badge>
                    <span class="target-ver">{row.installed ? row.installed.installed_version : ""}</span>
                    <div class="row-actions">
                      {#if row.state === "not_installed"}
                        <button type="button" class="act" disabled={busy} onclick={() => doInstall(detail.kind, detail.name, row.target)}>Install</button>
                      {:else if row.state === "modified"}
                        <!-- Three drift actions, distinguishable by LABEL (not color — Scott is
                             red/green CVD). Two are destructive in OPPOSITE directions, named in
                             each tooltip + confirm copy: Reinstall → disk, Reimport(+discard) →
                             working copy. Acknowledge is non-destructive. -->
                        <button
                          type="button"
                          class="act"
                          disabled={busy}
                          title="Overwrite the installed copy on disk with the library’s current version (discards the on-disk edits)"
                          onclick={() => doInstall(detail.kind, detail.name, row.target)}
                        >Reinstall</button>
                        <button
                          type="button"
                          class="act"
                          disabled={busy}
                          title="Adopt the current on-disk contents as the install baseline; the library is unchanged"
                          onclick={() => doAcknowledge(detail.kind, detail.name, row.target)}
                        >Acknowledge</button>
                        <button
                          type="button"
                          class="act"
                          disabled={busy}
                          title="Pull the on-disk edits back into the library as a new version (the inverse of Reinstall)"
                          onclick={() => openReimport(row.target)}
                        >Reimport</button>
                        <button type="button" class="act danger" disabled={busy} onclick={() => doUninstall(detail.kind, detail.name, row.target)}>Uninstall</button>
                      {:else}
                        <button type="button" class="act" disabled={busy} onclick={() => doInstall(detail.kind, detail.name, row.target)}>Update</button>
                        <button type="button" class="act danger" disabled={busy} onclick={() => doUninstall(detail.kind, detail.name, row.target)}>Uninstall</button>
                      {/if}
                    </div>
                    {#if row.state === "modified"}
                      <!-- The drift actions are directional and easy to confuse, so spell the
                           choice out in-place (the tooltips alone aren't discoverable). Text-only,
                           no color reliance — Scott is red/green CVD. -->
                      <p class="drift-help" role="note">
                        <Icon name="alert" size={12} />
                        <span>
                          <strong class="mono">{row.target}</strong> was edited outside the app, so its files no longer
                          match the library. Pick a direction:
                          <strong>Reimport</strong> pulls these on-disk edits <em>into the library</em> as a new version
                          (keeps your changes — this is how you preserve edits made directly in the install location);
                          <strong>Reinstall</strong> overwrites the on-disk copy with the library version (discards your
                          changes); <strong>Acknowledge</strong> stops flagging it but leaves the edits on disk only —
                          they won’t reach the library.
                        </span>
                      </p>
                    {/if}
                    {#if overlayStale}
                      <!-- Decision 3: an overlay edit doesn't re-install; explain the
                           resulting drift + point at the existing Update/reinstall action. -->
                      <p class="overlay-stale-note" role="status">
                        <Icon name="alert" size={12} />
                        The <span class="mono">{row.target}</span> overlay changed — this won’t reach the installed
                        copy until you <strong>Update</strong> it, and it’ll read as drifted until then.
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
            {#if notice}
              <div class="route-notice" class:warn={notice.tone === "amber"} role="status">{notice.text}</div>
            {/if}
            {#if reimportNotice}
              <div class="route-notice" class:warn={reimportNotice.tone === "amber"} role="status">{reimportNotice.text}</div>
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

  <!-- Reimport form: reimport IS a publish of foreign (drifted) bytes, so it
       needs a version label + optional notes (mirrors the publish form). Captured
       target via reimportForm; the intent is snapshotted at submit. -->
  {#if reimportForm}
    {@const busy = isPending(reimportForm.kind, reimportForm.name, reimportForm.target)}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="reimport-title">
      <div class="dialog">
        <h3 id="reimport-title">Reimport on-disk edits</h3>
        <p>
          Capture the on-disk edits of <strong>{reimportForm.name}</strong> →
          <strong class="mono">{reimportForm.target}</strong> as a new library version. This pulls the
          installed copy <em>into</em> the library — it doesn’t change anything on disk.
        </p>
        <label class="dialog-field">
          <span>Version label</span>
          <input class="mono" type="text" placeholder="v1" bind:value={reimportLabel} disabled={busy} />
        </label>
        <label class="dialog-field">
          <span>Notes <em>(optional)</em></span>
          <textarea rows="2" bind:value={reimportNotes} disabled={busy}></textarea>
        </label>
        {#if reimportNotice}
          <div class="route-notice" class:warn={reimportNotice.tone === "amber"} role="status">{reimportNotice.text}</div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={closeReimport}>Cancel</button>
          <button type="button" class="act primary" disabled={busy} onclick={submitReimport}>
            {busy ? "Reimporting…" : "Reimport"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- working_copy_dirty confirm: the working copy has unpublished edits reimport
       would discard. Names the direction explicitly (DISCARD the working copy),
       the opposite of Reinstall's "overwrite the disk". Captured intent (D2). -->
  {#if reimportDirty}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="reimport-dirty-title">
      <div class="dialog">
        <h3 id="reimport-dirty-title">Discard working-copy edits?</h3>
        <p>
          The working copy of <strong>{reimportDirty.name}</strong> has unpublished edits. Reimporting the
          <strong class="mono">{reimportDirty.target}</strong> on-disk copy as
          <strong class="mono">{reimportDirty.label}</strong> will <strong>discard</strong> those edits and
          capture the installed bytes instead.
        </p>
        <p class="dialog-warn">The unpublished working-copy edits are discarded. There is no backup.</p>
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (reimportDirty = null)}>Cancel</button>
          <button type="button" class="act danger" onclick={confirmReimportDiscard}>
            Discard &amp; reimport as {reimportDirty.label}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- broken_source fix sheet: the on-disk primary file won't parse. The textarea
       is a LOCAL buffer seeded from the raw bytes (never resource-bound). Save
       retries with fixed_primary_text; core re-validates. -->
  {#if reimportBroken}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="reimport-broken-title">
      <div class="dialog dialog-wide">
        <h3 id="reimport-broken-title">Fix the on-disk file to reimport</h3>
        <p>
          The installed <strong class="mono">{reimportBroken.primaryPath}</strong> for
          <strong>{reimportBroken.intent.name}</strong> → <strong class="mono">{reimportBroken.intent.target}</strong>
          doesn’t parse, so it can’t be captured as-is. Fix the frontmatter below and retry.
        </p>
        <pre class="commit-error-detail">{reimportBroken.parseError}</pre>
        <textarea class="mono fix-buffer" rows="14" bind:value={reimportBroken.text}></textarea>
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (reimportBroken = null)}>Cancel</button>
          <button type="button" class="act primary" onclick={saveReimportFix}>
            Fix &amp; reimport as {reimportBroken.intent.label}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create a new (blank) primitive: kind select + name input. A collision /
       invalid-name surfaces INLINE (createNotice), never as a shell toast. -->
  {#if createOpen}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div class="dialog">
        <h3 id="create-title">New primitive</h3>
        <p>Scaffold an empty primitive, or seed it from a GitHub URL. You can edit its working copy and publish a version next.</p>
        <label class="dialog-field">
          <span>Kind</span>
          <select bind:value={createKind} disabled={lifecycleBusy}>
            {#each KIND_ORDER as k (k)}
              <option value={k}>{KIND_LABELS[k]}</option>
            {/each}
          </select>
        </label>
        <!-- URL import (Slice 10b): optional. Fetch previews the content; the
             actual write happens on Create with the stashed preview as the seed.
             Only github.com / raw.githubusercontent.com URLs are accepted (the
             SSRF allowlist lives in-core). -->
        <label class="dialog-field">
          <span>From URL <span class="field-hint">(optional)</span></span>
          <div class="url-row">
            <input
              class="mono"
              type="url"
              placeholder="https://github.com/owner/repo/blob/main/skills/x/SKILL.md"
              bind:value={createUrl}
              oninput={onUrlInput}
              disabled={lifecycleBusy || createFetching}
              data-testid="create-url-input"
            />
            <button
              type="button"
              class="act"
              disabled={lifecycleBusy || createFetching || !createUrl.trim()}
              onclick={doFetch}
              data-testid="create-fetch-btn"
            >
              {createFetching ? "Fetching…" : "Fetch"}
            </button>
          </div>
        </label>
        {#if createFetched}
          <div class="fetch-preview" data-testid="fetch-preview">
            <span class="cue cyan">◆ fetched</span>
            <dl>
              {#if createFetched.author}<dt>Author</dt><dd>{createFetched.author}</dd>{/if}
              <dt>Source</dt>
              <dd class="mono trunc">{createFetched.source_url}</dd>
              {#if createFetched.ref_files.length > 0}
                <dt>Supporting files</dt>
                <dd>+ {createFetched.ref_files.length} file{createFetched.ref_files.length === 1 ? "" : "s"}</dd>
              {/if}
            </dl>
            <pre class="excerpt">{createFetched.content.slice(0, 400)}{createFetched.content.length > 400 ? "…" : ""}</pre>
          </div>
        {/if}
        <label class="dialog-field">
          <span>Name</span>
          <input
            class="mono"
            type="text"
            placeholder="my-primitive"
            bind:value={createName}
            disabled={lifecycleBusy}
          />
        </label>
        {#if createNotice}
          <div class="route-notice warn" role="status">{createNotice.text}</div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (createOpen = false)}>Cancel</button>
          <button type="button" class="act primary" disabled={lifecycleBusy} onclick={doCreate}>
            {lifecycleBusy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Import-from-path: a TYPED path (the 10a web redesign — no native picker).
       Only a path already under a recognized install root auto-imports; anything
       else returns not_classifiable with a pointer toward the bootstrap wizard. -->
  {#if importPathOpen}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="import-path-title">
      <div class="dialog">
        <h3 id="import-path-title">Import from a path</h3>
        <p>
          Enter the path to a primitive already installed under a recognized root (e.g.
          <span class="mono">~/.claude/skills/my-skill</span>). It’s copied <em>into</em> the library as a new
          version — nothing on disk changes.
        </p>
        <label class="dialog-field">
          <span>Source path</span>
          <input
            class="mono"
            type="text"
            placeholder="/Users/you/.claude/skills/my-skill"
            bind:value={importPathValue}
            disabled={lifecycleBusy}
          />
        </label>
        {#if importPathNotice}
          <div
            class="route-notice"
            class:warn={importPathNotice.tone === "amber"}
            class:info={importPathNotice.tone === "cyan"}
            role="status"
          >
            {importPathNotice.text}
          </div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (importPathOpen = false)}>Cancel</button>
          <button type="button" class="act primary" disabled={lifecycleBusy} onclick={doImportFromPath}>
            {lifecycleBusy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  {/if}


  <!-- Git remote sync (Slice 8): library-wide push/pull + remote/PAT config +
       the conflict resolver. Self-contained modal; onChanged reloads the status
       read so the rail git summary reflects a push/pull. -->
  {#if gitSyncOpen}
    <GitSyncPanel
      libraryPath={null}
      onClose={() => (gitSyncOpen = false)}
      onChanged={() => status.reload()}
    />
  {/if}

  <!-- Rename: captured-intent {kind,name,newName} (D2). Surfaces the install
       caveat AFTER the write (records migrate; on-disk copies keep the old name). -->
  {#if renameDialog}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="rename-title">
      <div class="dialog">
        <h3 id="rename-title">Rename primitive</h3>
        <p>
          Rename <strong>{renameDialog.name}</strong> in the library. Any installed copies keep the old name on
          disk until you reinstall.
        </p>
        <label class="dialog-field">
          <span>New name</span>
          <input class="mono" type="text" bind:value={renameDialog.newName} disabled={lifecycleBusy} />
        </label>
        {#if renameNotice}
          <div class="route-notice warn" role="status">{renameNotice.text}</div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (renameDialog = null)}>Cancel</button>
          <button type="button" class="act primary" disabled={lifecycleBusy} onclick={confirmRename}>
            {lifecycleBusy ? "Renaming…" : "Rename"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Duplicate: captured-intent {kind,name,newName} (D2). Copies the working
       copy only — versions and install records are not carried. -->
  {#if duplicateDialog}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
      <div class="dialog">
        <h3 id="duplicate-title">Duplicate primitive</h3>
        <p>
          Copy <strong>{duplicateDialog.name}</strong>’s working copy to a new primitive. The copy starts with no
          published version and is not installed anywhere.
        </p>
        <label class="dialog-field">
          <span>New name</span>
          <input class="mono" type="text" bind:value={duplicateDialog.newName} disabled={lifecycleBusy} />
        </label>
        {#if duplicateNotice}
          <div class="route-notice warn" role="status">{duplicateNotice.text}</div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (duplicateDialog = null)}>Cancel</button>
          <button type="button" class="act primary" disabled={lifecycleBusy} onclick={confirmDuplicate}>
            {lifecycleBusy ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Delete — the headline two-phase confirm. Lists the blast radius (installed
       targets + version count) captured at OPEN time (D2/A4), fires nothing
       before this second confirm, and locks the button in-flight. The danger cue
       is label+glyph+amber tone (never bare red — Scott is red/green CVD). -->
  {#if deleteDialog}
    <div class="dialog-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <div class="dialog">
        <h3 id="delete-title">Delete {deleteDialog.name}?</h3>
        <p>
          This permanently removes <strong>{deleteDialog.name}</strong> from the library — its working copy and
          <strong>{deleteDialog.versionCount}</strong>
          {deleteDialog.versionCount === 1 ? "version" : "versions"}.
        </p>
        {#if deleteDialog.installedTargets.length}
          <p>It is currently installed to, and will be force-uninstalled from:</p>
          <ul class="conflict-list">
            {#each deleteDialog.installedTargets as t (t)}
              <li class="mono">{t}</li>
            {/each}
          </ul>
        {:else}
          <p class="muted-line">It is not installed to any target.</p>
        {/if}
        <p class="dialog-warn">⚠ This deletes the library files and the on-disk installs. There is no backup.</p>
        {#if deleteNotice}
          <div class="route-notice warn" role="status">{deleteNotice.text}</div>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="act" onclick={() => (deleteDialog = null)}>Cancel</button>
          <button type="button" class="act danger" disabled={lifecycleBusy} onclick={confirmDelete}>
            {lifecycleBusy ? "Deleting…" : "Delete permanently"}
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
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 8px 12px;
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
  /* Content search box — sits just below the name filter, visually distinct. */
  .content-search {
    margin-top: 6px;
  }
  .search-clear {
    display: flex;
    align-items: center;
    color: var(--text-subtle);
    border-radius: 5px;
    padding: 1px;
  }
  .search-clear:hover {
    color: var(--text);
  }
  /* Content-search results — a flat, line-oriented list (NOT the kind tree). */
  .search-results {
    margin-top: 12px;
    display: grid;
    gap: 6px;
  }
  .search-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 0 6px;
  }
  .hit-list {
    display: grid;
    gap: 3px;
  }
  .hit {
    display: grid;
    gap: 4px;
    width: 100%;
    /* Same grid-item clamp as .group-items .item — keeps a long hit name or code
       line truncating instead of widening the explorer. */
    min-width: 0;
    padding: 8px;
    border-radius: 7px;
    color: var(--text-dim);
    text-align: left;
  }
  .hit:hover,
  .hit.selected {
    background: var(--surface-2);
    color: var(--text);
  }
  .hit-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .hit-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .hit-line {
    margin-left: auto;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .hit-text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
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
    /* min-width:0 lets the grid item shrink below its content's max-content so a
       long primitive name truncates via .item-name's overflow:hidden instead of
       blowing the grid track (and the fixed-width explorer) wider. */
    min-width: 0;
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
  .route-notice.info {
    border-left-color: var(--cyan, var(--accent-from));
  }
  /* Explorer + detail header action buttons (lifecycle slice). Chrome matches
     .import-btn; the delete variant is amber-bordered, NEVER red (Scott is
     red/green colorblind — the trash glyph + label carry the destructive cue). */
  .head-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
  }
  .head-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .doc-actions {
    display: flex;
    gap: 6px;
  }
  .head-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 11px;
  }
  .head-btn:hover:not(:disabled) {
    border-color: var(--border-glow);
  }
  .head-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .head-btn.danger-btn {
    border-color: color-mix(in srgb, var(--amber) 55%, var(--border));
    color: var(--amber);
  }
  .head-badge {
    margin-left: 3px;
    background: var(--cyan, #56b4e9);
    color: #06121b;
    border-radius: 999px;
    padding: 0 5px;
    font-size: 10px;
    font-weight: 700;
  }
  .targets-section,
  .overlays-section,
  .flatten-section {
    margin-top: 16px;
    display: grid;
    gap: 8px;
  }
  .flatten-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .flatten-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .flatten-form,
  .flatten-conflicts {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border, #333);
    border-radius: 6px;
  }
  .flatten-actions {
    display: flex;
    gap: 8px;
  }
  .metadata-section {
    margin-top: 14px;
    display: grid;
    gap: 8px;
  }
  .targets-section h4,
  .metadata-section h4,
  .overlays-section h4 {
    margin: 0 0 2px;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .overlays-section .muted-line {
    margin: 0 0 4px;
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
  /* Decision 3 — the post-overlay-edit reinstall note spans the whole row.
     Amber tone + an alert glyph + the explanatory text carry the meaning; never
     bare red/green (Scott is red/green colorblind). */
  .overlay-stale-note {
    grid-column: 1 / -1;
    margin: 2px 0 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--amber, #d08b1d) 12%, transparent);
    color: var(--text);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .drift-help {
    grid-column: 1 / -1;
    margin: 2px 0 0;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--amber, #d08b1d) 10%, transparent);
    color: var(--text);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .drift-help :global(svg) {
    flex: none;
    margin-top: 1px;
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
  /* Wider dialog for the broken-source fix sheet (it holds a full file editor). */
  .dialog-wide {
    width: min(680px, 100%);
  }
  /* Reimport-form fields — same chrome as the publish form, scoped to the dialog. */
  .dialog-field {
    display: grid;
    gap: 4px;
    margin: 0 0 10px;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .dialog-field em {
    color: var(--text-dim);
    font-style: normal;
  }
  .dialog-field input,
  .dialog-field select,
  .dialog-field textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-inset, transparent);
    color: var(--text);
    font-size: 12px;
  }
  .dialog-field textarea {
    resize: vertical;
    font-family: inherit;
  }
  /* URL import (Slice 10b) */
  .field-hint {
    color: var(--text-dim);
    font-weight: 400;
  }
  .url-row {
    display: flex;
    gap: 6px;
  }
  .url-row input {
    flex: 1;
    min-width: 0;
  }
  .fetch-preview {
    margin: 0 0 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-inset, transparent);
    font-size: 11.5px;
  }
  .fetch-preview dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 6px 0;
  }
  .fetch-preview dt {
    color: var(--text-dim);
  }
  .fetch-preview dd {
    margin: 0;
    color: var(--text-subtle);
  }
  .fetch-preview .trunc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fetch-preview .excerpt {
    max-height: 7rem;
    overflow: auto;
    margin: 6px 0 0;
    padding: 6px;
    border-radius: 4px;
    background: var(--bg, #111);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .fix-buffer {
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
    resize: vertical;
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
