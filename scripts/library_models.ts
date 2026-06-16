// Hand-written TypeScript read models for the prompt-library bridge, derived
// from the REAL Rust serde structs/projections (captured in
// scripts/fixtures/bridge/*.json), NOT from the UI prototype's flattened
// `PrimitiveRow`. The prototype conflates list-summary + per-target install +
// drift from three different core calls; mirroring it would manufacture the
// contract drift this slice avoids (plan C2/M2).
//
// Each `parseX` is a lightweight runtime validator: it checks the load-bearing
// discriminants + required keys and returns the typed value, or throws a
// `BridgeShapeError`. The bridge wrapper turns that throw into a typed
// `bridge_bad_output` result, so a serde rename surfaces as a clear error at the
// process boundary rather than `undefined` deep in the UI. We do not pull in a
// schema library — the surface is small and the repo keeps deps minimal.

export type Kind = "skill" | "agent" | "command" | "codex_agent";
export type TargetName = "claude" | "pi" | "codex";

const KINDS: readonly Kind[] = ["skill", "agent", "command", "codex_agent"];

/** Per-Kind primary filename — a tagged union, NOT a bare string. */
export type PrimaryFilename =
  | { kind: "fixed"; value: string }
  | { kind: "templated"; extension: string };

export interface KindInfo {
  primary_filename: PrimaryFilename;
  allowed_targets: TargetName[];
  supports_ref_files: boolean;
}

/** Total table keyed by Kind — every Kind present, no optionality. */
export type KindInfoTable = Record<Kind, KindInfo>;

export interface TargetInfo {
  targets: { target: TargetName; dir_name: string }[];
}

export interface PrimitiveSummary {
  kind: Kind;
  name: string;
  dirty: boolean;
  author: string | null;
}

/** Working copy content — tagged on `kind` (md kinds vs codex_agent toml). */
export type WorkingContent =
  | { kind: "md"; frontmatter: string; body: string }
  | { kind: "toml"; text: string };

/** One content-search match — mirrors core's `find::FindHit` exactly. Each hit
 *  is one matching line in one primitive's working-copy PRIMARY file (ref files
 *  are excluded in-core). `line_number` is 1-based; `line_text` is truncated
 *  with `…` past 500 chars in-core. (search slice) */
export interface SearchResult {
  kind: Kind;
  name: string;
  line_number: number;
  line_text: string;
}

// ---------------------------------------------------------------------------
// Working-file (editor) wire models (working-copy slice)
//
// Mirror core's `working_files.rs` serde exactly: `WorkingFileEntry` (the bundle
// list) and the `WorkingFileBytes` tagged union (`#[serde(tag="kind")]`). Binary
// files carry their size ONLY — bytes are never streamed — so the editor must
// branch on `kind` and render a placeholder, not a textarea. `size_bytes`/`size`
// saturate at u32::MAX on the Rust side (specta legacy); they ride the JSON wire
// as plain numbers.
// ---------------------------------------------------------------------------

export type WorkingFileRole = "primary" | "ref";

/** One entry in a primitive's `working/base/` bundle list. */
export interface WorkingFileEntry {
  path: string;
  role: WorkingFileRole;
  is_text: boolean;
  size_bytes: number;
}

/** Bytes of one ref file — tagged on `kind`. Binary files carry size only. */
export type WorkingFileBytes =
  | { kind: "text"; text: string; ext: string | null }
  | { kind: "binary"; size: number };

export interface PrimitiveMetadata {
  allowed_targets: TargetName[];
  created_at: string;
  display_name?: string;
  author?: string;
  source_url?: string;
}

export interface PrimitiveDetail {
  kind: Kind;
  name: string;
  metadata: PrimitiveMetadata;
  working: WorkingContent;
  versions: string[];
  current_version: string | null;
}

// ---------------------------------------------------------------------------
// Versioning / publishing wire models (versioning slice)
//
// Mirror core's `version_store.rs::VersionMetadata` + `detail.rs::
// PrimitiveVersionView`, and the bridge's publish/set-current result envelope.
// `PublishResult` is the dashboard's non-fatal commit contract (Decision 3):
// the snapshot always succeeded by the time this returns; `committed`/
// `commit_error` describe ONLY the advisory git step. `commit_error` is git's
// own stderr (the legible "set user.email" remediation), null when the commit
// succeeded OR was a no-op (nothing staged / non-git library).
// ---------------------------------------------------------------------------

/** Per-version metadata (`version.yaml`). `notes` is skip_serializing_if=None. */
export interface VersionMetadata {
  created_at: string;
  notes?: string;
}

/** A frozen version's primary content + its metadata, for the inspector pane. */
export interface PrimitiveVersionView {
  working: WorkingContent;
  metadata: VersionMetadata;
}

/** The outcome of a publish / set-current: the version mutation already
 *  succeeded; this reports the advisory git commit only. */
export interface PublishResult {
  committed: boolean;
  commit_error: string | null;
}

// ---------------------------------------------------------------------------
// Metadata-editing wire models (metadata-editing slice)
//
// `update_metadata` returns the freshly-written metadata PLUS the same non-fatal
// commit contract as publish — `metadata.yaml` is git-tracked (not under the
// gitignored `working/`), so the write COMMITS (Slice 4's posture), unlike the
// overlay writes. By the time this returns the metadata atomic-write has already
// landed; `committed`/`commit_error` describe ONLY the advisory git step.
// ---------------------------------------------------------------------------

/** The editable subset sent to `update_metadata`. `display_name`/`author` send
 *  `null` to clear (the bridge collapses ""/null → drop the field); the
 *  optional `discard_orphan_overlays` confirms deleting overlay files orphaned
 *  by dropping a target (the 409 two-phase-confirm). */
export interface MetadataUpdateBody {
  allowed_targets: TargetName[];
  display_name: string | null;
  author: string | null;
  discard_orphan_overlays?: boolean;
}

/** The outcome of an `update_metadata`: the freshly-written metadata + the
 *  advisory git commit result (same non-fatal contract as `PublishResult`). */
export interface MetadataUpdateResult {
  metadata: PrimitiveMetadata;
  committed: boolean;
  commit_error: string | null;
}

// ---------------------------------------------------------------------------
// Target-overlay wire models (target-overlays slice)
//
// Mirror core's `detail.rs::TargetView` (the merged primary for a target + a
// `has_overlay` flag) and `detail.rs::OverlayList` (one per target that carries
// ≥1 overlay file). `TargetView.working` reuses the same `WorkingContent` union
// as the base editor — the merged primary decodes identically. `has_overlay` is
// the editor's signal: false ⇒ render the base read-only with an "Add overlay"
// affordance; true ⇒ the overlay file exists and the tab is editable.
// ---------------------------------------------------------------------------

/** The merged primary for a (primitive, target) pair + whether an overlay
 *  file shadows the base. */
export interface TargetView {
  working: WorkingContent;
  has_overlay: boolean;
}

/** One target's overlay surface — the relative paths under
 *  `working/targets/<target>/`. */
export interface OverlayList {
  target: TargetName;
  paths: string[];
}

export interface LibraryStatus {
  is_valid: boolean;
  marker_exists: boolean;
  is_git_repo: boolean;
  branch: string | null;
  dirty: boolean | null;
  unpushed: boolean | null;
}

// ---------------------------------------------------------------------------
// Install / uninstall / drift wire models (install-drift slice)
//
// Mirror the core serde structs exactly (installer.rs / drift.rs). Every
// per-target outcome is a tagged union on `kind` (core's
// `#[serde(tag="kind", rename_all="snake_case")]`). `CollidingContent` /
// `Drifted` are NOT failures — they are normal results the UI uses to prompt,
// then re-issues with `force:true`. `conflicts`/`missing` are install-relative
// path strings (cross the boundary as strings, not Utf8PathBuf).
// ---------------------------------------------------------------------------

/** What happened for one install target. Tagged on `kind`. */
export type TargetOutcome =
  | { kind: "installed"; version: string }
  | { kind: "no_op_identical"; version: string }
  | { kind: "colliding_content"; version: string; conflicts: string[] };

export interface TargetResult {
  target: TargetName;
  outcome: TargetOutcome;
}

/** A pre-flight abort for one target (never an overwrite). Tagged on `kind`. */
export type InstallFailureKind =
  | { kind: "occupied_by_unexpected_kind"; path: string; expected: string; actual: string }
  | { kind: "io"; path: string; message: string }
  | { kind: "other"; message: string };

export interface TargetFailure {
  target: TargetName;
  reason: InstallFailureKind;
}

export interface InstallSummary {
  successes: TargetResult[];
  failures: TargetFailure[];
}

/** What happened when removing one target's install. Tagged on `kind`. */
export type UninstallOutcome =
  | { kind: "removed" }
  | { kind: "not_installed" }
  | { kind: "drifted"; conflicts: string[] };

export interface TargetUninstallResult {
  target: TargetName;
  outcome: UninstallOutcome;
}

export interface UninstallSummary {
  successes: TargetUninstallResult[];
  failures: TargetFailure[];
}

/** Drift status for one `(kind, name, target)` install. Tagged on `kind`. */
export type DriftStatus =
  | { kind: "clean" }
  | { kind: "modified"; conflicts: string[] }
  | { kind: "missing"; missing: string[] };

export interface DriftReport {
  kind: Kind;
  name: string;
  target: TargetName;
  status: DriftStatus;
}

/** Compact per-target install projection (hashes/mtimes stay in core). */
export interface InstalledTarget {
  target: TargetName;
  installed_version: string;
  installed_at: string;
}

/** Result of the one-time standalone→dashboard installs.json migration. */
export interface ImportResult {
  imported: number;
}

// ---------------------------------------------------------------------------
// Reimport-from-drift wire model (reimport slice)
//
// `reimport_install` pulls an installed copy's on-disk (drifted) bytes back into
// the library as a new version. Like `DriftStatus`/`TargetOutcome`, every variant
// is a RESULT the UI routes on (it rides the bridge `ok` envelope as data, NOT an
// error). Only `reimported` carries the non-fatal commit contract (the new
// version tree is git-tracked, publish posture); the other variants wrote nothing
// git-tracked, so they have no commit fields. `broken_source.raw_bytes` is the
// on-disk primary file's bytes (a JSON number array) the UI decodes into its
// fix buffer.
// ---------------------------------------------------------------------------

/** Outcome of a `reimport_install`. Tagged on `kind`. */
export type ReimportResult =
  | { kind: "reimported"; new_version: string; committed: boolean; commit_error: string | null }
  | { kind: "working_copy_dirty" }
  | { kind: "broken_source"; primary_path: string; raw_bytes: number[]; parse_error: string }
  | { kind: "not_installed" }
  | { kind: "install_missing" };

// ---------------------------------------------------------------------------
// Primitive-lifecycle wire models (lifecycle slice)
//
// Structural CRUD over the library. create/delete/rename/duplicate/import edit
// the git-TRACKED library tree, so each carries the same non-fatal
// `{committed, commit_error}` contract as publish (the library write already
// landed by the time the result returns; the commit is advisory). `forget`
// touches only the dashboard-owned installs.json (gitignored), so it has NO
// commit fields. A `create` result is exactly a `PublishResult`
// (`{committed, commit_error}`) — it's parsed with `parsePublishResult`, no
// distinct type needed.
// ---------------------------------------------------------------------------

/** Outcome of a `delete_primitive`: the per-target force-uninstall summary the
 *  UI inspects, plus whether the library dir was removed and the advisory
 *  commit. A bail (uninstall `failures` non-empty) → `library_dir_removed:false`
 *  + `committed:false`; the library tree survives. */
export interface DeletePrimitiveResult {
  uninstall: UninstallSummary;
  library_dir_removed: boolean;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of a `rename_primitive`: how many installs.json records were
 *  rewritten to the new name (the "N installed copies keep the old name until
 *  reinstalled" UI caveat) + the advisory commit. */
export interface RenamePrimitiveResult {
  install_records_updated: number;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of a `duplicate_primitive`: the new primitive's name + the advisory
 *  commit. Versions and install records are NOT carried (the duplicate starts
 *  at "no published version, not installed"). */
export interface DuplicatePrimitiveResult {
  new_name: string;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of an `import_primitive_from_path` (the local-path classify flavor,
 *  NOT url import). Tagged on `kind`, every variant a 200 the UI routes on. Only
 *  `imported` wrote a git-tracked tree, so only it carries commit fields;
 *  `not_classifiable` points the user at the bootstrap wizard. */
export type ImportFromPathResult =
  | {
      kind: "imported";
      primitive_kind: Kind;
      name: string;
      committed: boolean;
      commit_error: string | null;
    }
  | { kind: "already_exists"; primitive_kind: Kind; name: string }
  | { kind: "not_classifiable"; reason: string };

/** Outcome of a `forget_primitive`: whether any installs.json record was
 *  dropped (idempotent — `false` when nothing matched). No commit (the ledger is
 *  not in the library repo). */
export interface ForgetResult {
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Bootstrap-discovery wire models (bootstrap slice)
//
// The first-run "scan your machine and import existing primitives" wizard. The
// scan returns BOTH the full classification (for the review UI's informational
// rows) and the derived executable `plan`; `derive_plan` ran server-side. The
// `plan` and a resumable `session` round-trip back to `bootstrap_execute`
// UNTOUCHED, so the action/session parsers keep the verbatim object (`raw`)
// alongside the lifted display fields — the wizard re-sends `raw`, never a
// re-serialization that could drop the base/overlay fields the bridge needs.
// Skip-reason rides the Rust variant name verbatim (no serde rename:
// `WorkingCopyDirty`/`InstallMissing`), unlike the snake_case `kind`.
// ---------------------------------------------------------------------------

/** A scan candidate's classification against the library. Externally-tagged in
 *  Rust (`"AlreadyImported"` | `{New:…}` | `{Drifted:…}`); flattened to a tag
 *  here — the review UI only needs the tag, not the per-candidate content. */
export type BootstrapClassification = "new" | "already_imported" | "drifted";

/** One classified `(kind, name)` group from the scan — display-only. */
export interface BootstrapGroup {
  kind: Kind;
  name: string;
  classification: BootstrapClassification;
}

/** The wizard's banner counts. core exposes this via a `summary()` method that
 *  the serialized `CrossReferenced` omits, so the parser recomputes it the same
 *  way (count groups by tag + `needs_manual_review.length`). */
export interface BootstrapSummary {
  new: number;
  already_imported: number;
  drifted: number;
  needs_manual_review: number;
}

/** The full scan classification, for the review UI's informational rows. The
 *  heavy per-candidate content is dropped — only the executable `plan` (kept
 *  verbatim, below) round-trips back to execute. `symlinked`/`unclassified` are
 *  surfaced as counts (the UI shows "N skipped, symlinked"). */
export interface CrossReferenced {
  groups: BootstrapGroup[];
  needs_manual_review: { kind: Kind; name: string }[];
  symlinked: number;
  unclassified: number;
  summary: BootstrapSummary;
}

/** One executable action (a New→create or Drifted→reimport). `kind`/`name` are
 *  lifted for display; `raw` is the verbatim action object the bridge
 *  re-deserializes — it carries the base/overlays the UI must NOT drop, so the
 *  wizard re-sends `raw` untouched (filtering = which `raw`s to include). */
export interface BootstrapAction {
  kind: Kind;
  name: string;
  raw: Record<string, unknown>;
}

/** The executable subset of a scan: New primitives to create + Drifted ones to
 *  reimport. Round-trips back to `bootstrap_execute` as the (frontend-filtered)
 *  plan. */
export interface BootstrapPlan {
  creates: BootstrapAction[];
  reimports: BootstrapAction[];
}

/** A `bootstrap_scan` result: the full classification (display) + the derived
 *  executable plan (`derive_plan` ran server-side, one envelope). */
export interface BootstrapScanResult {
  crossReferenced: CrossReferenced;
  plan: BootstrapPlan;
}

/** A resumable bootstrap session — the prior partial run's checkpoint. `raw` is
 *  re-sent to execute as `resume` untouched; `startedAt` drives the "Resume
 *  bootstrap from <when>?" prompt. */
export interface BootstrapSession {
  formatVersion: number;
  startedAt: string;
  raw: Record<string, unknown>;
}

/** An item bootstrap could not complete automatically. `reason` is the verbatim
 *  Rust variant name (no serde rename). */
export interface BootstrapSkippedItem {
  kind: Kind;
  name: string;
  source_target: TargetName;
  reason: "WorkingCopyDirty" | "InstallMissing";
}

/** A `bootstrap_execute` result. `committed`/`commit_error` are present ONLY
 *  when the run wrote something (`created + reimported > 0`) — the bridge gates
 *  the commit — so they're nullable here (absent → null). A partial run leaves
 *  `skipped_items` populated and the session on disk for Resume. */
export interface BootstrapExecuteSummary {
  backup_path: string | null;
  created: number;
  reimported: number;
  skipped: number;
  skipped_items: BootstrapSkippedItem[];
  /** Install records re-linked by case-only reconciliation this run (a manual
   *  disk rename like `Teach`→`teach` left the record at the old case). */
  reconciled: number;
  committed: boolean | null;
  commit_error: string | null;
}

// ---------------------------------------------------------------------------
// Runtime validators
// ---------------------------------------------------------------------------

/** Thrown when bridge output doesn't match the expected read-model shape. */
export class BridgeShapeError extends Error {}

function fail(what: string): never {
  throw new BridgeShapeError(`bridge output is not a valid ${what}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isKind(v: unknown): v is Kind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string") fail(what);
  return v;
}

function asBool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") fail(what);
  return v;
}

function asNullableString(v: unknown, what: string): string | null {
  if (v !== null && typeof v !== "string") fail(what);
  return (v as string) ?? null;
}

function asNullableBool(v: unknown, what: string): boolean | null {
  if (v !== null && typeof v !== "boolean") fail(what);
  return (v as boolean) ?? null;
}

function asStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(what);
  return v as string[];
}

/** A `Vec<u8>` on the wire (a JSON array of byte-valued numbers). Used for
 *  `broken_source.raw_bytes` — the on-disk primary file's bytes the UI decodes
 *  into its fix buffer. */
function asByteArray(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) fail(what);
  return v as number[];
}

function parsePrimaryFilename(v: unknown): PrimaryFilename {
  if (!isObject(v)) fail("primary_filename");
  if (v.kind === "fixed") return { kind: "fixed", value: asString(v.value, "primary_filename.value") };
  if (v.kind === "templated")
    return { kind: "templated", extension: asString(v.extension, "primary_filename.extension") };
  return fail("primary_filename");
}

function parseKindInfo(v: unknown): KindInfo {
  if (!isObject(v)) fail("KindInfo");
  return {
    primary_filename: parsePrimaryFilename(v.primary_filename),
    allowed_targets: asStringArray(v.allowed_targets, "KindInfo.allowed_targets") as TargetName[],
    supports_ref_files: asBool(v.supports_ref_files, "KindInfo.supports_ref_files"),
  };
}

export function parseKindInfoTable(v: unknown): KindInfoTable {
  if (!isObject(v)) fail("KindInfoTable");
  // Total: every Kind must be present.
  for (const k of KINDS) if (!isObject(v[k])) fail("KindInfoTable");
  return {
    skill: parseKindInfo(v.skill),
    agent: parseKindInfo(v.agent),
    command: parseKindInfo(v.command),
    codex_agent: parseKindInfo(v.codex_agent),
  };
}

export function parseTargetInfo(v: unknown): TargetInfo {
  if (!isObject(v) || !Array.isArray(v.targets)) fail("TargetInfo");
  const targets = v.targets.map((t) => {
    if (!isObject(t)) fail("TargetInfo.targets[]");
    return {
      target: asString(t.target, "TargetInfo.target") as TargetName,
      dir_name: asString(t.dir_name, "TargetInfo.dir_name"),
    };
  });
  return { targets };
}

function parsePrimitiveSummary(v: unknown): PrimitiveSummary {
  if (!isObject(v) || !isKind(v.kind)) fail("PrimitiveSummary");
  return {
    kind: v.kind,
    name: asString(v.name, "PrimitiveSummary.name"),
    dirty: asBool(v.dirty, "PrimitiveSummary.dirty"),
    author: asNullableString(v.author, "PrimitiveSummary.author"),
  };
}

export function parsePrimitiveSummaries(v: unknown): PrimitiveSummary[] {
  if (!Array.isArray(v)) fail("PrimitiveSummary[]");
  return v.map(parsePrimitiveSummary);
}

function parseSearchResult(v: unknown): SearchResult {
  if (!isObject(v) || !isKind(v.kind)) fail("SearchResult");
  return {
    kind: v.kind,
    name: asString(v.name, "SearchResult.name"),
    line_number: asNumber(v.line_number, "SearchResult.line_number"),
    line_text: asString(v.line_text, "SearchResult.line_text"),
  };
}

export function parseSearchResults(v: unknown): SearchResult[] {
  if (!Array.isArray(v)) fail("SearchResult[]");
  return v.map(parseSearchResult);
}

function parseWorkingContent(v: unknown): WorkingContent {
  if (!isObject(v)) fail("WorkingContent");
  if (v.kind === "md")
    return {
      kind: "md",
      frontmatter: asString(v.frontmatter, "WorkingContent.frontmatter"),
      body: asString(v.body, "WorkingContent.body"),
    };
  if (v.kind === "toml") return { kind: "toml", text: asString(v.text, "WorkingContent.text") };
  return fail("WorkingContent");
}

function parseMetadata(v: unknown): PrimitiveMetadata {
  if (!isObject(v)) fail("PrimitiveMetadata");
  const m: PrimitiveMetadata = {
    allowed_targets: asStringArray(v.allowed_targets, "PrimitiveMetadata.allowed_targets") as TargetName[],
    created_at: asString(v.created_at, "PrimitiveMetadata.created_at"),
  };
  // Optionals are skip_serializing_if=None on the Rust side — present-or-absent.
  if (v.display_name !== undefined) m.display_name = asString(v.display_name, "PrimitiveMetadata.display_name");
  if (v.author !== undefined) m.author = asString(v.author, "PrimitiveMetadata.author");
  if (v.source_url !== undefined) m.source_url = asString(v.source_url, "PrimitiveMetadata.source_url");
  return m;
}

export function parsePrimitiveDetail(v: unknown): PrimitiveDetail {
  if (!isObject(v) || !isKind(v.kind)) fail("PrimitiveDetail");
  return {
    kind: v.kind,
    name: asString(v.name, "PrimitiveDetail.name"),
    metadata: parseMetadata(v.metadata),
    working: parseWorkingContent(v.working),
    versions: asStringArray(v.versions, "PrimitiveDetail.versions"),
    current_version: asNullableString(v.current_version, "PrimitiveDetail.current_version"),
  };
}

function parseVersionMetadata(v: unknown): VersionMetadata {
  if (!isObject(v)) fail("VersionMetadata");
  const m: VersionMetadata = { created_at: asString(v.created_at, "VersionMetadata.created_at") };
  // `notes` is skip_serializing_if=None on the Rust side — present-or-absent.
  if (v.notes !== undefined && v.notes !== null) m.notes = asString(v.notes, "VersionMetadata.notes");
  return m;
}

export function parsePrimitiveVersionView(v: unknown): PrimitiveVersionView {
  if (!isObject(v)) fail("PrimitiveVersionView");
  return {
    working: parseWorkingContent(v.working),
    metadata: parseVersionMetadata(v.metadata),
  };
}

export function parsePublishResult(v: unknown): PublishResult {
  if (!isObject(v)) fail("PublishResult");
  return {
    committed: asBool(v.committed, "PublishResult.committed"),
    commit_error: asNullableString(v.commit_error, "PublishResult.commit_error"),
  };
}

export function parseMetadataUpdateResult(v: unknown): MetadataUpdateResult {
  if (!isObject(v)) fail("MetadataUpdateResult");
  return {
    metadata: parseMetadata(v.metadata),
    committed: asBool(v.committed, "MetadataUpdateResult.committed"),
    commit_error: asNullableString(v.commit_error, "MetadataUpdateResult.commit_error"),
  };
}

export function parseLibraryStatus(v: unknown): LibraryStatus {
  if (!isObject(v)) fail("LibraryStatus");
  return {
    is_valid: asBool(v.is_valid, "LibraryStatus.is_valid"),
    marker_exists: asBool(v.marker_exists, "LibraryStatus.marker_exists"),
    is_git_repo: asBool(v.is_git_repo, "LibraryStatus.is_git_repo"),
    branch: asNullableString(v.branch, "LibraryStatus.branch"),
    dirty: asNullableBool(v.dirty, "LibraryStatus.dirty"),
    unpushed: asNullableBool(v.unpushed, "LibraryStatus.unpushed"),
  };
}

// ---------------------------------------------------------------------------
// Install / uninstall / drift validators
//
// The discriminant (`kind`) is the load-bearing check: a core serde rename must
// throw a typed BridgeShapeError here, not surface as `undefined` in the
// conflict dialog. `target` is validated as a string and cast (the closed
// Target enum is already enforced on the Rust side; mirrors parseTargetInfo).
// ---------------------------------------------------------------------------

function asNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) fail(what);
  return v;
}

function asTarget(v: unknown, what: string): TargetName {
  return asString(v, what) as TargetName;
}

function parseTargetOutcome(v: unknown): TargetOutcome {
  if (!isObject(v)) fail("TargetOutcome");
  switch (v.kind) {
    case "installed":
      return { kind: "installed", version: asString(v.version, "TargetOutcome.version") };
    case "no_op_identical":
      return { kind: "no_op_identical", version: asString(v.version, "TargetOutcome.version") };
    case "colliding_content":
      return {
        kind: "colliding_content",
        version: asString(v.version, "TargetOutcome.version"),
        conflicts: asStringArray(v.conflicts, "TargetOutcome.conflicts"),
      };
    default:
      return fail("TargetOutcome (unknown kind)");
  }
}

function parseInstallFailureKind(v: unknown): InstallFailureKind {
  if (!isObject(v)) fail("InstallFailureKind");
  switch (v.kind) {
    case "occupied_by_unexpected_kind":
      return {
        kind: "occupied_by_unexpected_kind",
        path: asString(v.path, "InstallFailureKind.path"),
        expected: asString(v.expected, "InstallFailureKind.expected"),
        actual: asString(v.actual, "InstallFailureKind.actual"),
      };
    case "io":
      return {
        kind: "io",
        path: asString(v.path, "InstallFailureKind.path"),
        message: asString(v.message, "InstallFailureKind.message"),
      };
    case "other":
      return { kind: "other", message: asString(v.message, "InstallFailureKind.message") };
    default:
      return fail("InstallFailureKind (unknown kind)");
  }
}

function parseTargetFailure(v: unknown): TargetFailure {
  if (!isObject(v)) fail("TargetFailure");
  return {
    target: asTarget(v.target, "TargetFailure.target"),
    reason: parseInstallFailureKind(v.reason),
  };
}

export function parseInstallSummary(v: unknown): InstallSummary {
  if (!isObject(v) || !Array.isArray(v.successes) || !Array.isArray(v.failures))
    fail("InstallSummary");
  return {
    successes: v.successes.map((s) => {
      if (!isObject(s)) fail("TargetResult");
      return { target: asTarget(s.target, "TargetResult.target"), outcome: parseTargetOutcome(s.outcome) };
    }),
    failures: v.failures.map(parseTargetFailure),
  };
}

function parseUninstallOutcome(v: unknown): UninstallOutcome {
  if (!isObject(v)) fail("UninstallOutcome");
  switch (v.kind) {
    case "removed":
      return { kind: "removed" };
    case "not_installed":
      return { kind: "not_installed" };
    case "drifted":
      return { kind: "drifted", conflicts: asStringArray(v.conflicts, "UninstallOutcome.conflicts") };
    default:
      return fail("UninstallOutcome (unknown kind)");
  }
}

export function parseUninstallSummary(v: unknown): UninstallSummary {
  if (!isObject(v) || !Array.isArray(v.successes) || !Array.isArray(v.failures))
    fail("UninstallSummary");
  return {
    successes: v.successes.map((s) => {
      if (!isObject(s)) fail("TargetUninstallResult");
      return {
        target: asTarget(s.target, "TargetUninstallResult.target"),
        outcome: parseUninstallOutcome(s.outcome),
      };
    }),
    failures: v.failures.map(parseTargetFailure),
  };
}

function parseDriftStatus(v: unknown): DriftStatus {
  if (!isObject(v)) fail("DriftStatus");
  switch (v.kind) {
    case "clean":
      return { kind: "clean" };
    case "modified":
      return { kind: "modified", conflicts: asStringArray(v.conflicts, "DriftStatus.conflicts") };
    case "missing":
      return { kind: "missing", missing: asStringArray(v.missing, "DriftStatus.missing") };
    default:
      return fail("DriftStatus (unknown kind)");
  }
}

export function parseReimportResult(v: unknown): ReimportResult {
  if (!isObject(v)) fail("ReimportResult");
  switch (v.kind) {
    case "reimported":
      return {
        kind: "reimported",
        new_version: asString(v.new_version, "ReimportResult.new_version"),
        committed: asBool(v.committed, "ReimportResult.committed"),
        commit_error: asNullableString(v.commit_error, "ReimportResult.commit_error"),
      };
    case "working_copy_dirty":
      return { kind: "working_copy_dirty" };
    case "broken_source":
      return {
        kind: "broken_source",
        primary_path: asString(v.primary_path, "ReimportResult.primary_path"),
        raw_bytes: asByteArray(v.raw_bytes, "ReimportResult.raw_bytes"),
        parse_error: asString(v.parse_error, "ReimportResult.parse_error"),
      };
    case "not_installed":
      return { kind: "not_installed" };
    case "install_missing":
      return { kind: "install_missing" };
    default:
      return fail("ReimportResult (unknown kind)");
  }
}

export function parseDeletePrimitiveResult(v: unknown): DeletePrimitiveResult {
  if (!isObject(v)) fail("DeletePrimitiveResult");
  return {
    uninstall: parseUninstallSummary(v.uninstall),
    library_dir_removed: asBool(v.library_dir_removed, "DeletePrimitiveResult.library_dir_removed"),
    committed: asBool(v.committed, "DeletePrimitiveResult.committed"),
    commit_error: asNullableString(v.commit_error, "DeletePrimitiveResult.commit_error"),
  };
}

export function parseRenamePrimitiveResult(v: unknown): RenamePrimitiveResult {
  if (!isObject(v)) fail("RenamePrimitiveResult");
  return {
    install_records_updated: asNumber(
      v.install_records_updated,
      "RenamePrimitiveResult.install_records_updated",
    ),
    committed: asBool(v.committed, "RenamePrimitiveResult.committed"),
    commit_error: asNullableString(v.commit_error, "RenamePrimitiveResult.commit_error"),
  };
}

export function parseDuplicatePrimitiveResult(v: unknown): DuplicatePrimitiveResult {
  if (!isObject(v)) fail("DuplicatePrimitiveResult");
  return {
    new_name: asString(v.new_name, "DuplicatePrimitiveResult.new_name"),
    committed: asBool(v.committed, "DuplicatePrimitiveResult.committed"),
    commit_error: asNullableString(v.commit_error, "DuplicatePrimitiveResult.commit_error"),
  };
}

export function parseImportFromPathResult(v: unknown): ImportFromPathResult {
  if (!isObject(v)) fail("ImportFromPathResult");
  switch (v.kind) {
    case "imported":
      if (!isKind(v.primitive_kind)) fail("ImportFromPathResult.primitive_kind");
      return {
        kind: "imported",
        primitive_kind: v.primitive_kind,
        name: asString(v.name, "ImportFromPathResult.name"),
        committed: asBool(v.committed, "ImportFromPathResult.committed"),
        commit_error: asNullableString(v.commit_error, "ImportFromPathResult.commit_error"),
      };
    case "already_exists":
      if (!isKind(v.primitive_kind)) fail("ImportFromPathResult.primitive_kind");
      return {
        kind: "already_exists",
        primitive_kind: v.primitive_kind,
        name: asString(v.name, "ImportFromPathResult.name"),
      };
    case "not_classifiable":
      return { kind: "not_classifiable", reason: asString(v.reason, "ImportFromPathResult.reason") };
    default:
      return fail("ImportFromPathResult (unknown kind)");
  }
}

export function parseForgetResult(v: unknown): ForgetResult {
  if (!isObject(v)) fail("ForgetResult");
  return { removed: asBool(v.removed, "ForgetResult.removed") };
}

// ---- bootstrap-discovery parsers ----------------------------------------

function parseBootstrapClassification(v: unknown): BootstrapClassification {
  if (v === "AlreadyImported") return "already_imported";
  if (isObject(v)) {
    if ("New" in v) return "new";
    if ("Drifted" in v) return "drifted";
  }
  return fail("Classification");
}

function parseBootstrapGroup(v: unknown): BootstrapGroup {
  if (!isObject(v) || !isKind(v.kind)) fail("BootstrapGroup");
  return {
    kind: v.kind,
    name: asString(v.name, "BootstrapGroup.name"),
    classification: parseBootstrapClassification(v.classification),
  };
}

function parseManualReviewGroup(v: unknown): { kind: Kind; name: string } {
  if (!isObject(v) || !isKind(v.kind)) fail("ManualReviewGroup");
  return { kind: v.kind, name: asString(v.name, "ManualReviewGroup.name") };
}

function parseCrossReferenced(v: unknown): CrossReferenced {
  if (!isObject(v)) fail("CrossReferenced");
  if (!Array.isArray(v.groups)) fail("CrossReferenced.groups");
  if (!Array.isArray(v.needs_manual_review)) fail("CrossReferenced.needs_manual_review");
  if (!Array.isArray(v.symlinked)) fail("CrossReferenced.symlinked");
  if (!Array.isArray(v.unclassified)) fail("CrossReferenced.unclassified");
  const groups = v.groups.map(parseBootstrapGroup);
  const needsManual = v.needs_manual_review.map(parseManualReviewGroup);
  // Recompute the banner summary exactly as core's `summary()` (the serialized
  // CrossReferenced omits the method's output).
  const summary: BootstrapSummary = {
    new: groups.filter((g) => g.classification === "new").length,
    already_imported: groups.filter((g) => g.classification === "already_imported").length,
    drifted: groups.filter((g) => g.classification === "drifted").length,
    needs_manual_review: needsManual.length,
  };
  return {
    groups,
    needs_manual_review: needsManual,
    symlinked: v.symlinked.length,
    unclassified: v.unclassified.length,
    summary,
  };
}

function parseBootstrapAction(v: unknown): BootstrapAction {
  if (!isObject(v) || !isKind(v.kind)) fail("BootstrapAction");
  return {
    kind: v.kind,
    name: asString(v.name, "BootstrapAction.name"),
    // Keep the verbatim object — it round-trips back to execute untouched.
    raw: v,
  };
}

function parseBootstrapPlanModel(v: unknown): BootstrapPlan {
  if (!isObject(v) || !Array.isArray(v.creates) || !Array.isArray(v.reimports))
    fail("BootstrapPlan");
  return {
    creates: v.creates.map(parseBootstrapAction),
    reimports: v.reimports.map(parseBootstrapAction),
  };
}

export function parseBootstrapScanResult(v: unknown): BootstrapScanResult {
  if (!isObject(v)) fail("BootstrapScanResult");
  return {
    crossReferenced: parseCrossReferenced(v.cross_referenced),
    plan: parseBootstrapPlanModel(v.plan),
  };
}

function parseBootstrapSession(v: unknown): BootstrapSession {
  if (!isObject(v)) fail("BootstrapSession");
  return {
    formatVersion: asNumber(v.format_version, "BootstrapSession.format_version"),
    startedAt: asString(v.started_at, "BootstrapSession.started_at"),
    // Keep the verbatim object — re-sent to execute as `resume` untouched.
    raw: v,
  };
}

/** Parse the `read_bootstrap_session` envelope (`{session: … | null}`). An
 *  absent session is a legitimate `null` (the first-run state), not a failure. */
export function parseBootstrapSessionResult(v: unknown): BootstrapSession | null {
  if (!isObject(v)) fail("BootstrapSessionResult");
  if (v.session === null || v.session === undefined) return null;
  return parseBootstrapSession(v.session);
}

function parseBootstrapSkippedItem(v: unknown): BootstrapSkippedItem {
  if (!isObject(v) || !isKind(v.kind)) fail("BootstrapSkippedItem");
  const reason = v.reason;
  if (reason !== "WorkingCopyDirty" && reason !== "InstallMissing")
    fail("BootstrapSkippedItem.reason");
  return {
    kind: v.kind,
    name: asString(v.name, "BootstrapSkippedItem.name"),
    source_target: asTarget(v.source_target, "BootstrapSkippedItem.source_target"),
    reason,
  };
}

export function parseBootstrapExecuteSummary(v: unknown): BootstrapExecuteSummary {
  if (!isObject(v) || !Array.isArray(v.skipped_items)) fail("BootstrapExecuteSummary");
  return {
    backup_path: asNullableString(v.backup_path, "BootstrapExecuteSummary.backup_path"),
    created: asNumber(v.created, "BootstrapExecuteSummary.created"),
    reimported: asNumber(v.reimported, "BootstrapExecuteSummary.reimported"),
    skipped: asNumber(v.skipped, "BootstrapExecuteSummary.skipped"),
    skipped_items: v.skipped_items.map(parseBootstrapSkippedItem),
    // Absent on an older bridge → 0 (additive field; never a parse failure).
    reconciled: v.reconciled === undefined ? 0 : asNumber(v.reconciled, "BootstrapExecuteSummary.reconciled"),
    // Commit-gating: the fields are present only when something was written;
    // absent (an all-skipped / empty run) → null, NOT a parse failure.
    committed: v.committed === undefined ? null : asNullableBool(v.committed, "BootstrapExecuteSummary.committed"),
    commit_error:
      v.commit_error === undefined ? null : asNullableString(v.commit_error, "BootstrapExecuteSummary.commit_error"),
  };
}

function parseDriftReport(v: unknown): DriftReport {
  if (!isObject(v) || !isKind(v.kind)) fail("DriftReport");
  return {
    kind: v.kind,
    name: asString(v.name, "DriftReport.name"),
    target: asTarget(v.target, "DriftReport.target"),
    status: parseDriftStatus(v.status),
  };
}

export function parseDriftReports(v: unknown): DriftReport[] {
  if (!Array.isArray(v)) fail("DriftReport[]");
  return v.map(parseDriftReport);
}

function parseInstalledTarget(v: unknown): InstalledTarget {
  if (!isObject(v)) fail("InstalledTarget");
  return {
    target: asTarget(v.target, "InstalledTarget.target"),
    installed_version: asString(v.installed_version, "InstalledTarget.installed_version"),
    installed_at: asString(v.installed_at, "InstalledTarget.installed_at"),
  };
}

export function parseInstalledTargets(v: unknown): InstalledTarget[] {
  if (!Array.isArray(v)) fail("InstalledTarget[]");
  return v.map(parseInstalledTarget);
}

export function parseImportResult(v: unknown): ImportResult {
  if (!isObject(v)) fail("ImportResult");
  return { imported: asNumber(v.imported, "ImportResult.imported") };
}

// ---------------------------------------------------------------------------
// Working-file (editor) validators
//
// The discriminant is load-bearing: `role` for the list, `kind` for the bytes
// union. A serde rename (e.g. `text`→`utf8`) must throw a typed BridgeShapeError
// here, never surface as `undefined` in the editor pane. A `binary` payload
// legitimately carries no `text` — size only — and must parse fine.
// ---------------------------------------------------------------------------

function parseWorkingFileRole(v: unknown): WorkingFileRole {
  if (v === "primary" || v === "ref") return v;
  return fail("WorkingFileRole");
}

function parseWorkingFileEntry(v: unknown): WorkingFileEntry {
  if (!isObject(v)) fail("WorkingFileEntry");
  return {
    path: asString(v.path, "WorkingFileEntry.path"),
    role: parseWorkingFileRole(v.role),
    is_text: asBool(v.is_text, "WorkingFileEntry.is_text"),
    size_bytes: asNumber(v.size_bytes, "WorkingFileEntry.size_bytes"),
  };
}

export function parseWorkingFileEntries(v: unknown): WorkingFileEntry[] {
  if (!Array.isArray(v)) fail("WorkingFileEntry[]");
  return v.map(parseWorkingFileEntry);
}

export function parseWorkingFileBytes(v: unknown): WorkingFileBytes {
  if (!isObject(v)) fail("WorkingFileBytes");
  switch (v.kind) {
    case "text":
      return {
        kind: "text",
        text: asString(v.text, "WorkingFileBytes.text"),
        ext: asNullableString(v.ext, "WorkingFileBytes.ext"),
      };
    case "binary":
      return { kind: "binary", size: asNumber(v.size, "WorkingFileBytes.size") };
    default:
      return fail("WorkingFileBytes (unknown kind)");
  }
}

// ---------------------------------------------------------------------------
// Target-overlay validators (target-overlays slice)
// ---------------------------------------------------------------------------

const TARGET_NAMES: readonly TargetName[] = ["claude", "pi", "codex"];

function parseTargetName(v: unknown, what: string): TargetName {
  if (typeof v === "string" && (TARGET_NAMES as readonly string[]).includes(v)) return v as TargetName;
  return fail(what);
}

export function parseTargetView(v: unknown): TargetView {
  if (!isObject(v)) fail("TargetView");
  return {
    working: parseWorkingContent(v.working),
    has_overlay: asBool(v.has_overlay, "TargetView.has_overlay"),
  };
}

function parseOverlayList(v: unknown): OverlayList {
  if (!isObject(v)) fail("OverlayList");
  return {
    target: parseTargetName(v.target, "OverlayList.target"),
    paths: asStringArray(v.paths, "OverlayList.paths"),
  };
}

export function parseOverlayLists(v: unknown): OverlayList[] {
  if (!Array.isArray(v)) fail("OverlayList[]");
  return v.map(parseOverlayList);
}

// ---------------------------------------------------------------------------
// Git remote sync (Slice 8). Parsers for the bridge's git-sync envelopes. The
// PAT never appears in any of these — `RemoteStatus.pat_redacted` is the only
// PAT-derived field and it is already the redacted form (`redact_pat`).
// ---------------------------------------------------------------------------

/** Remote URL + redacted PAT for the settings panel. Both nullable: null url =
 *  no remote configured; null pat = no token stored. */
export interface RemoteStatus {
  remote_url: string | null;
  pat_redacted: string | null;
}

export function parseRemoteStatus(v: unknown): RemoteStatus {
  if (!isObject(v)) fail("RemoteStatus");
  return {
    remote_url: asNullableString(v.remote_url, "RemoteStatus.remote_url"),
    pat_redacted: asNullableString(v.pat_redacted, "RemoteStatus.pat_redacted"),
  };
}

/** One secret-scan hit the push gate found. `matched` is the verbatim offending
 *  bytes — the UI surfaces it so the user sees exactly what tripped the gate. */
export interface ScanFinding {
  path: string;
  line: number;
  kind: string;
  matched: string;
}

export function parseScanFindings(v: unknown): ScanFinding[] {
  if (!isObject(v) || !Array.isArray(v.findings)) fail("ScanFinding[]");
  return v.findings.map((f) => {
    if (!isObject(f)) fail("ScanFinding");
    return {
      path: asString(f.path, "ScanFinding.path"),
      line: asNumber(f.line, "ScanFinding.line"),
      kind: asString(f.kind, "ScanFinding.kind"),
      matched: asString(f.matched, "ScanFinding.matched"),
    };
  });
}

/** Count of commits ahead of the upstream — the "Push N" badge. */
export interface UnpushedCount {
  count: number;
}

export function parseUnpushedCount(v: unknown): UnpushedCount {
  if (!isObject(v)) fail("UnpushedCount");
  return { count: asNumber(v.count, "UnpushedCount.count") };
}

/** Whether a rebase is paused awaiting conflict resolution. */
export interface PullPaused {
  paused: boolean;
}

export function parsePullPaused(v: unknown): PullPaused {
  if (!isObject(v)) fail("PullPaused");
  return { paused: asBool(v.paused, "PullPaused.paused") };
}

/** Outcome of `pull_now`: a clean pull, or a paused rebase the UI must resolve.
 *  A conflict is a routable RESULT (rides the OK envelope as data), not an
 *  error — the UI swaps to the resolver banner. */
export type PullResult =
  | { outcome: "ok" }
  | { outcome: "conflict"; conflict_count: number };

export function parsePullResult(v: unknown): PullResult {
  if (!isObject(v)) fail("PullResult");
  switch (v.outcome) {
    case "ok":
      return { outcome: "ok" };
    case "conflict":
      return { outcome: "conflict", conflict_count: asNumber(v.conflict_count, "PullResult.conflict_count") };
    default:
      return fail("PullResult (unknown outcome)");
  }
}

/** Outcome of `continue_pull`: the rebase finished, or the next replayed commit
 *  collided afresh and the resolver loops. */
export type ContinueResult =
  | { outcome: "done" }
  | { outcome: "still_conflicted"; conflict_count: number };

export function parseContinueResult(v: unknown): ContinueResult {
  if (!isObject(v)) fail("ContinueResult");
  switch (v.outcome) {
    case "done":
      return { outcome: "done" };
    case "still_conflicted":
      return {
        outcome: "still_conflicted",
        conflict_count: asNumber(v.conflict_count, "ContinueResult.conflict_count"),
      };
    default:
      return fail("ContinueResult (unknown outcome)");
  }
}

/** A conflicted path classified for the resolver's renderer. `kind` mirrors the
 *  bridge's `classify_conflict_path`: current_txt/metadata_yaml get value
 *  pickers; version_file/other fall back to the copy-path escape hatch. */
export type ConflictKind = "current_txt" | "metadata_yaml" | "version_file" | "other";

export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
}

const CONFLICT_KINDS: readonly ConflictKind[] = ["current_txt", "metadata_yaml", "version_file", "other"];

export function parseConflictList(v: unknown): ConflictEntry[] {
  if (!isObject(v) || !Array.isArray(v.conflicts)) fail("ConflictEntry[]");
  return v.conflicts.map((c) => {
    if (!isObject(c)) fail("ConflictEntry");
    const kind = asString(c.kind, "ConflictEntry.kind");
    if (!(CONFLICT_KINDS as readonly string[]).includes(kind)) fail("ConflictEntry.kind");
    return { path: asString(c.path, "ConflictEntry.path"), kind: kind as ConflictKind };
  });
}

/** One side of a conflicted blob, decoded as text. `content` is null when that
 *  side has no entry (e.g. the other side deleted the file). */
export interface ConflictBlob {
  content: string | null;
}

export function parseConflictBlob(v: unknown): ConflictBlob {
  if (!isObject(v)) fail("ConflictBlob");
  return { content: asNullableString(v.content, "ConflictBlob.content") };
}

/** configure_remote's reply: the validated, normalized remote URL (no PAT). */
export interface ConfiguredRemote {
  remote_url: string;
}

export function parseConfiguredRemote(v: unknown): ConfiguredRemote {
  if (!isObject(v)) fail("ConfiguredRemote");
  return { remote_url: asString(v.remote_url, "ConfiguredRemote.remote_url") };
}

// --- URL import (Slice 10b) -------------------------------------------------
// The fetched-primitive preview returned by fetch_primitive_from_url, plus the
// create-time seed. ref_files carry raw bytes as a JSON number array (the
// Vec<u8> wire convention), round-tripped verbatim into the create payload.

export interface RefFileWire {
  rel_path: string;
  content: number[];
}

export interface FetchedPrimitive {
  content: string;
  suggested_name: string;
  author: string | null;
  source_url: string;
  ref_files: RefFileWire[];
}

export function parseFetchedPrimitive(v: unknown): FetchedPrimitive {
  if (!isObject(v) || !Array.isArray(v.ref_files)) fail("FetchedPrimitive");
  return {
    content: asString(v.content, "FetchedPrimitive.content"),
    suggested_name: asString(v.suggested_name, "FetchedPrimitive.suggested_name"),
    author: asNullableString(v.author, "FetchedPrimitive.author"),
    source_url: asString(v.source_url, "FetchedPrimitive.source_url"),
    ref_files: v.ref_files.map((rf) => {
      if (!isObject(rf)) fail("RefFile");
      return {
        rel_path: asString(rf.rel_path, "RefFile.rel_path"),
        content: asByteArray(rf.content, "RefFile.content"),
      };
    }),
  };
}
