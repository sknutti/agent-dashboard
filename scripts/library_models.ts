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
