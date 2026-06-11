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

export interface LibraryStatus {
  is_valid: boolean;
  marker_exists: boolean;
  is_git_repo: boolean;
  branch: string | null;
  dirty: boolean | null;
  unpushed: boolean | null;
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
