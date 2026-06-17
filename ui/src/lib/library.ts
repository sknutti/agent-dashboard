// Pure derivation helpers for the Library route — grouping, filtering, selection
// keys, and colorblind-safe status cues. No runes here; the reactive data layer
// (resource() calls) lives in Library.svelte. Keeping these pure makes the
// list/filter/cue logic unit-testable without rendering a component.

import type {
  LibraryKind,
  LibraryTarget,
  LibraryPrimitiveSummary,
  LibraryStatus,
  LibraryDriftReport,
  LibraryDriftStatus,
  LibraryInstalledTarget,
  LibraryTargetOutcome,
  LibraryUninstallOutcome,
  LibraryReimportResult,
  LibraryFlattenResult,
  LibraryImportFromPathResult,
  LibraryBootstrapClassification,
} from "./api";

/** All four Kinds, shown equally (ADR-0007 — no Kind is privileged). */
export const KIND_ORDER: LibraryKind[] = ["skill", "agent", "command", "codex_agent"];

export const KIND_LABELS: Record<LibraryKind, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  codex_agent: "Codex Agents",
};

export interface KindGroup {
  kind: LibraryKind;
  label: string;
  items: LibraryPrimitiveSummary[];
}

/** Case-insensitive substring filter on the primitive name. Empty/blank query
 *  returns everything. */
export function filterPrimitives(
  items: LibraryPrimitiveSummary[],
  query: string,
): LibraryPrimitiveSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((p) => p.name.toLowerCase().includes(q));
}

/** Group primitives by Kind in canonical order, dropping empty groups so the
 *  explorer never renders a blank Kind header. */
export function groupByKind(items: LibraryPrimitiveSummary[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: items.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** Stable selection key. Names can't contain "/" (PrimitiveName rejects it), so
 *  splitting on the first "/" round-trips safely. */
export function selectionKey(kind: LibraryKind, name: string): string {
  return `${kind}/${name}`;
}

export function parseSelection(key: string): { kind: LibraryKind; name: string } | null {
  const i = key.indexOf("/");
  if (i < 0) return null;
  const kind = key.slice(0, i) as LibraryKind;
  const name = key.slice(i + 1);
  if (!KIND_ORDER.includes(kind) || !name) return null;
  return { kind, name };
}

/** A status cue that never relies on color alone (Scott is red/green
 *  colorblind): every state pairs a text label + glyph, and tones avoid a bare
 *  red/green contrast. */
export interface Cue {
  label: string;
  tone: "amber" | "cyan" | "default";
  glyph: string;
}

/** The `dirty` flag = working copy differs from the pinned version. */
export function dirtyCue(dirty: boolean): Cue {
  return dirty
    ? { label: "modified", tone: "amber", glyph: "●" }
    : { label: "pinned", tone: "default", glyph: "○" };
}

/** Editor buffer cue — DISTINCT copy from the primitive-level dirtyCue: this is
 *  "the open file has unsaved edits", not "the working copy differs from the
 *  pinned version". Colorblind-safe (label + glyph, never bare red/green). */
export function editorDirtyCue(isDirty: boolean): Cue {
  return isDirty
    ? { label: "unsaved", tone: "amber", glyph: "●" }
    : { label: "saved", tone: "default", glyph: "○" };
}

/** Post-publish / set-current commit state. The version mutation ALWAYS
 *  succeeded by the time this renders (Decision 1+3) — this cue describes only
 *  the advisory git commit. Three distinct, colorblind-safe states (label +
 *  glyph, never bare red/green): committed, published-but-the-commit-failed
 *  (amber — the git message is shown alongside), and published-with-no-commit
 *  (a non-git library or a no-op — NOT a failure). */
export function publishStateCue(committed: boolean, commitError: string | null): Cue {
  if (committed) return { label: "committed locally", tone: "default", glyph: "✓" };
  if (commitError) return { label: "published · not committed", tone: "amber", glyph: "●" };
  return { label: "published", tone: "default", glyph: "✓" };
}

/** Post-metadata-save commit state. The metadata atomic-write ALWAYS succeeded
 *  by the time this renders — `metadata.yaml` is git-tracked, so the write
 *  commits (Slice 4's posture), and this cue describes ONLY the advisory git
 *  step. A commit failure (no git identity) is NOT an error — the edit landed —
 *  so it reads as an amber warning ("saved · not committed", git's message
 *  shown alongside), distinct from a 4xx error toast. Colorblind-safe (label +
 *  glyph, never bare red/green — Scott is red/green CVD). */
export function metadataSaveCue(committed: boolean, commitError: string | null): Cue {
  if (committed) return { label: "saved · committed", tone: "default", glyph: "✓" };
  if (commitError) return { label: "saved · not committed", tone: "amber", glyph: "●" };
  return { label: "saved", tone: "default", glyph: "✓" };
}

/** Distinguish a per-target OVERLAY (a target-specific delta that shadows the
 *  base primary at install time) from a plain base passthrough. Colorblind-safe:
 *  label + glyph + a CVD-safe cyan for the overlay, never a bare red/green. The
 *  label makes "this is a delta, not the full base file" unmistakable. */
export function overlayCue(hasOverlay: boolean): Cue {
  return hasOverlay
    ? { label: "overlay", tone: "cyan", glyph: "◆" }
    : { label: "base (no overlay)", tone: "default", glyph: "○" };
}

/** Distinguish the current pinned version from a past one in the inspector —
 *  by label + glyph + a CVD-safe cyan (never a bare red/green); "current" is the
 *  pointer a future install reads. */
export function currentVersionCue(label: string, current: string | null): Cue {
  return label === current
    ? { label: "current", tone: "cyan", glyph: "◆" }
    : { label: "past version", tone: "default", glyph: "○" };
}

/** A words-only git summary for the status rail (no color-coded dots). Nulls are
 *  indeterminate — never asserted as "clean"/"all pushed". */
export function gitSummary(s: LibraryStatus): string {
  if (!s.is_git_repo) return "not a git repo";
  const parts: string[] = [s.branch ?? "(detached)"];
  if (s.dirty === true) parts.push("uncommitted changes");
  else if (s.dirty === false) parts.push("clean");
  if (s.unpushed === true) parts.push("unpushed commits");
  return parts.join(" · ");
}

// ── install / drift derivation (write-flow slice) ───────────────────────────

/** Per-target install state for the detail rows — folds the install records and
 *  the (per-primitive) drift report into one discriminant. */
export type TargetInstallState = "not_installed" | "clean" | "modified" | "missing";

/** Fold a DriftReport[] into a per-target `status` lookup scoped to one
 *  primitive. The batch carries every primitive; the detail wants one. */
export function driftByTarget(
  reports: LibraryDriftReport[],
  kind: LibraryKind,
  name: string,
): Map<LibraryTarget, LibraryDriftStatus> {
  const map = new Map<LibraryTarget, LibraryDriftStatus>();
  for (const r of reports) {
    if (r.kind === kind && r.name === name) map.set(r.target, r.status);
  }
  return map;
}

/** The install state of one target = (is there a record?) × (drift status). A
 *  recorded target with no drift entry defaults to clean (defensive — every
 *  record should have one). */
export function installStateFor(
  target: LibraryTarget,
  installed: LibraryInstalledTarget[],
  drift: Map<LibraryTarget, LibraryDriftStatus>,
): TargetInstallState {
  if (!installed.some((t) => t.target === target)) return "not_installed";
  const status = drift.get(target);
  if (status?.kind === "modified") return "modified";
  if (status?.kind === "missing") return "missing";
  return "clean";
}

/** Row badge for a target's install state. Colorblind-safe: distinct label +
 *  glyph, Okabe-Ito-safe tones, never a bare red/green (Scott is red/green CVD). */
export function stateCue(state: TargetInstallState): Cue {
  switch (state) {
    case "clean":
      return { label: "installed", tone: "default", glyph: "✓" };
    case "modified":
      return { label: "drifted", tone: "amber", glyph: "●" };
    case "missing":
      return { label: "missing externally", tone: "cyan", glyph: "⊘" };
    case "not_installed":
      return { label: "not installed", tone: "default", glyph: "○" };
  }
}

/** Post-install per-target feedback. Every outcome — including the `no_op_identical`
 *  no-op — gets a VISIBLE cue so a button press is never a silent dead-end. */
export function outcomeCue(outcome: LibraryTargetOutcome): Cue {
  switch (outcome.kind) {
    case "installed":
      return { label: "installed", tone: "default", glyph: "✓" };
    case "no_op_identical":
      return { label: "already up to date", tone: "default", glyph: "✓" };
    case "colliding_content":
      return { label: "needs overwrite", tone: "amber", glyph: "●" };
  }
}

/** Post-uninstall per-target feedback (the `not_installed` no-op is visible too). */
export function uninstallCue(outcome: LibraryUninstallOutcome): Cue {
  switch (outcome.kind) {
    case "removed":
      return { label: "uninstalled", tone: "default", glyph: "✓" };
    case "not_installed":
      return { label: "was not installed", tone: "default", glyph: "○" };
    case "drifted":
      return { label: "drifted — needs force", tone: "amber", glyph: "●" };
  }
}

/** Post-reimport feedback. Reimport pulls a drifted install's on-disk bytes back
 *  into the library as a new version (the INVERSE of install). Every variant gets
 *  a VISIBLE, DISTINCT-by-label cue so a button press is never a silent dead-end;
 *  the two interactive results (`working_copy_dirty`, `broken_source`) hand off to
 *  a dialog/fix-sheet, but their cue still names the reason. The `reimported`
 *  commit nuance mirrors `publishStateCue` (the snapshot always landed; the cue
 *  describes only the advisory git commit). Colorblind-safe (label + glyph,
 *  Okabe-Ito-safe tones, never a bare red/green — Scott is red/green CVD). */
export function reimportResultCue(result: LibraryReimportResult): Cue {
  switch (result.kind) {
    case "reimported":
      if (result.committed) return { label: "reimported · committed", tone: "default", glyph: "✓" };
      if (result.commit_error) return { label: "reimported · not committed", tone: "amber", glyph: "●" };
      return { label: "reimported", tone: "default", glyph: "✓" };
    case "working_copy_dirty":
      return { label: "working copy has unpublished edits", tone: "amber", glyph: "●" };
    case "broken_source":
      return { label: "on-disk file won't parse — fix & retry", tone: "amber", glyph: "✎" };
    case "not_installed":
      return { label: "not installed", tone: "default", glyph: "○" };
    case "install_missing":
      return { label: "install path is gone", tone: "cyan", glyph: "⊘" };
  }
}

/** Colorblind-safe cue for a flatten outcome (ADR-0009). Never red/green — tone
 *  + glyph + label carry the signal (Okabe-Ito amber/cyan + neutral default). */
export function flattenResultCue(result: LibraryFlattenResult): Cue {
  switch (result.kind) {
    case "flattened":
      if (result.committed) return { label: "flattened · committed", tone: "default", glyph: "✓" };
      if (result.commit_error) return { label: "flattened · not committed", tone: "amber", glyph: "●" };
      return { label: "flattened", tone: "default", glyph: "✓" };
    case "working_copy_dirty":
      return { label: "working copy has unpublished edits", tone: "amber", glyph: "●" };
    case "converging_conflicts":
      return { label: "installed copies edited — confirm overwrite", tone: "amber", glyph: "●" };
    case "not_an_overlay_target":
      return { label: "no overlay to promote", tone: "default", glyph: "○" };
    case "no_current_version":
      return { label: "nothing published yet", tone: "default", glyph: "○" };
  }
}

/** Explorer badge predicate: does ANY recorded target of `(kind,name)` drift
 *  (modified or missing)? Drives a per-primitive drift dot in the explorer. */
export function anyDrift(reports: LibraryDriftReport[], kind: LibraryKind, name: string): boolean {
  return reports.some(
    (r) => r.kind === kind && r.name === name && r.status.kind !== "clean",
  );
}

// ── lifecycle derivation (lifecycle slice) ──────────────────────────────────

/** Post-lifecycle-op commit state (create / rename / duplicate). The library
 *  write ALWAYS landed by the time this renders; the cue describes ONLY the
 *  advisory git commit, mirroring publishStateCue. Colorblind-safe (label +
 *  glyph, never bare red/green — Scott is red/green CVD). */
export function lifecycleCommitCue(committed: boolean, commitError: string | null): Cue {
  if (committed) return { label: "committed locally", tone: "default", glyph: "✓" };
  if (commitError) return { label: "saved · not committed", tone: "amber", glyph: "●" };
  return { label: "saved", tone: "default", glyph: "✓" };
}

/** The rename caveat: installed copies keep the OLD name on disk until the user
 *  reinstalls (the library record was migrated, but the deployed files weren't
 *  renamed). Returns null when nothing is installed (no caveat to show). */
export function renameInstallCaveat(recordsUpdated: number): string | null {
  if (recordsUpdated <= 0) return null;
  const noun = recordsUpdated === 1 ? "installed copy keeps" : "installed copies keep";
  return `${recordsUpdated} ${noun} the old name on disk until reinstalled.`;
}

/** Post-delete feedback. Delete is the most destructive non-git action in the
 *  whole consolidation; the cue must NEVER read as a flat success when the
 *  force-uninstall bailed (a target the uninstall couldn't reach → the library
 *  dir survives). Three distinct, colorblind-safe states (label + glyph,
 *  Okabe-Ito-safe tones, never bare red/green): removed+committed, removed but
 *  the commit failed (amber), and BAILED (amber — the library was NOT deleted,
 *  the failures are surfaced). */
export function deleteResultCue(libraryDirRemoved: boolean, commitError: string | null): Cue {
  if (!libraryDirRemoved) return { label: "not deleted — a target could not be reached", tone: "amber", glyph: "●" };
  if (commitError) return { label: "deleted · not committed", tone: "amber", glyph: "●" };
  return { label: "deleted", tone: "default", glyph: "✓" };
}

/** Post-import-from-path feedback. Every variant gets a VISIBLE, DISTINCT-by-label
 *  cue so a button press is never a silent dead-end; `not_classifiable` points the
 *  user at the bootstrap wizard rather than reading as an error. The `imported`
 *  commit nuance mirrors reimportResultCue. Colorblind-safe. */
export function importResultCue(result: LibraryImportFromPathResult): Cue {
  switch (result.kind) {
    case "imported":
      if (result.committed) return { label: "imported · committed", tone: "default", glyph: "✓" };
      if (result.commit_error) return { label: "imported · not committed", tone: "amber", glyph: "●" };
      return { label: "imported", tone: "default", glyph: "✓" };
    case "already_exists":
      return { label: "already in the library", tone: "default", glyph: "○" };
    case "not_classifiable":
      return { label: "not auto-importable — use bootstrap", tone: "cyan", glyph: "⊘" };
  }
}

// ── bootstrap derivation (bootstrap slice) ──────────────────────────────────

/** A scan candidate's classification cue for the review step. Four distinct
 *  states, each a label + glyph + Okabe-Ito-safe tone — NEVER bare red/green
 *  (Scott is red/green CVD), and distinguishable with color stripped. `new` and
 *  `drifted` are the importable ones (create / reimport); `already_imported` and
 *  `needs_review` are read-only informational rows. */
export function classificationCue(c: LibraryBootstrapClassification | "needs_review"): Cue {
  switch (c) {
    case "new":
      return { label: "new", tone: "cyan", glyph: "✦" };
    case "drifted":
      return { label: "drifted", tone: "amber", glyph: "●" };
    case "already_imported":
      return { label: "already imported", tone: "default", glyph: "✓" };
    case "needs_review":
      return { label: "needs review", tone: "default", glyph: "⚑" };
  }
}

/** Why a bootstrap item was skipped — distinct, label-first remedies (working
 *  copy vs install path are DIFFERENT fixes, distinguishable without color).
 *  Mirrors the reimport cue vocabulary (a bootstrap reimport routes through the
 *  same core path). Colorblind-safe. */
export function bootstrapSkipReasonCue(reason: "WorkingCopyDirty" | "InstallMissing"): Cue {
  switch (reason) {
    case "WorkingCopyDirty":
      return { label: "working copy has unpublished edits — resolve, then Resume", tone: "amber", glyph: "●" };
    case "InstallMissing":
      return { label: "install path is gone — rescan", tone: "cyan", glyph: "⊘" };
  }
}

/** Post-execute commit state for the bootstrap result banner. The version trees
 *  ALWAYS landed by the time this renders; the cue describes only the advisory
 *  git commit, gated to runs that wrote something (`committed` is null on a
 *  scan-only / all-skipped run). Mirrors lifecycleCommitCue. Colorblind-safe. */
export function bootstrapCommitCue(committed: boolean | null, commitError: string | null): Cue {
  if (committed) return { label: "committed locally", tone: "default", glyph: "✓" };
  if (commitError) return { label: "imported · not committed", tone: "amber", glyph: "●" };
  return { label: "imported", tone: "default", glyph: "✓" };
}

// ── reconcile derivation (bootstrap slice — the forget home) ─────────────────

/** An install record whose `(kind, name)` has no corresponding library primitive
 *  — the inverse of a healthy install. The Reconcile view lists these so the
 *  dead ledger rows can be forgotten. */
export interface OrphanInstall {
  kind: LibraryKind;
  name: string;
  targets: LibraryTarget[];
}

/** Derive orphaned install records: every `(kind, name)` that appears in the
 *  drift batch (which enumerates every `installs.json` record, library-
 *  independent) but has NO matching library primitive. Pure — drives the
 *  Reconcile view from reads the Library route already holds (driftBatch +
 *  primitives), so no dedicated bridge read is needed. */
export function orphanInstalls(
  reports: LibraryDriftReport[],
  primitives: LibraryPrimitiveSummary[],
): OrphanInstall[] {
  const known = new Set(primitives.map((p) => selectionKey(p.kind, p.name)));
  const byPrimitive = new Map<string, OrphanInstall>();
  for (const r of reports) {
    const key = selectionKey(r.kind, r.name);
    if (known.has(key)) continue; // a live primitive — not an orphan
    let o = byPrimitive.get(key);
    if (!o) {
      o = { kind: r.kind, name: r.name, targets: [] };
      byPrimitive.set(key, o);
    }
    if (!o.targets.includes(r.target)) o.targets.push(r.target);
  }
  return [...byPrimitive.values()];
}

/** The orphan row cue — a CVD-safe "this install has no library primitive"
 *  marker (label + glyph + cyan, never bare red/green). */
export function orphanCue(): Cue {
  return { label: "no library primitive", tone: "cyan", glyph: "⊘" };
}

// --- Git remote sync cues (Slice 8) ----------------------------------------
// All CVD-safe: label + glyph + Okabe-Ito tone (amber/cyan), never bare
// red/green (Scott is red/green colorblind). The push-gate "blocked" state is
// amber ▲ — NOT red — so it reads as "stop and review", not a hard error.

/** The secret-scan push gate. A finding BLOCKS push pending review (D4). */
export function pushGateCue(findingCount: number): Cue {
  return findingCount > 0
    ? { label: `${findingCount} secret${findingCount === 1 ? "" : "s"} found — review before pushing`, tone: "amber", glyph: "▲" }
    : { label: "no secrets found", tone: "default", glyph: "✓" };
}

/** Overall sync state for the panel header. Paused (mid-rebase) outranks
 *  ahead-count; both are distinguishable from synced by label + glyph, not tone. */
export function syncStateCue(unpushed: number, paused: boolean): Cue {
  if (paused) return { label: "pull paused — resolve conflicts", tone: "amber", glyph: "⚠" };
  if (unpushed > 0) return { label: `${unpushed} to push`, tone: "cyan", glyph: "↑" };
  return { label: "up to date", tone: "default", glyph: "✓" };
}

/** A conflict-row renderer hint: side-by-side value-pickers for the structured
 *  files, a copy-path escape hatch for the rest (Slice 10c — no native reveal). */
export function conflictResolvable(kind: import("./api").LibraryConflictKind): boolean {
  return kind === "current_txt" || kind === "metadata_yaml";
}
