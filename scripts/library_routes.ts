// Dashboard-normalized read-only /api/library/* routes. Each delegates to the
// Rust bridge via library_bridge.ts and returns a route-local result — a
// library failure never degrades Observability health (/api/summary, /healthz,
// doctor are untouched: these handlers share no state with them).
//
// Following the repo's factored-handler convention (routes.ts buildSessionX),
// the work lives in exported `buildX(config, run)` functions that are unit-
// tested directly with a stubbed `run` (no subprocess); the route handlers are
// thin `c.json(body, status)` wrappers. The bridge invoker is injected so the
// route logic is testable without a Rust build.

import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { loadLibraryConfig, type LibraryConfig } from "./library_config.ts";
import { runBridge, type LibraryError } from "./library_bridge.ts";
import {
  parseKindInfoTable,
  parseTargetInfo,
  parsePrimitiveSummaries,
  parsePrimitiveDetail,
  parseLibraryStatus,
  parseInstallSummary,
  parseUninstallSummary,
  parseDriftReports,
  parseInstalledTargets,
  parseWorkingFileEntries,
  parseWorkingFileBytes,
  parsePrimitiveVersionView,
  parsePublishResult,
  parseTargetView,
  parseOverlayLists,
  parseMetadataUpdateResult,
  type LibraryStatus,
} from "./library_models.ts";
import { importInstalls } from "./library_migration.ts";

type Run = typeof runBridge;
type HttpStatus = 200 | 404 | 409 | 422 | 502;

/**
 * Write commands get a larger watchdog than the 10s read default. Killing a
 * read is free; killing a write mid-flight is exactly the non-atomic-across-
 * targets hazard (D3), so the timeout must never trip on a HEALTHY fs write —
 * it only bounds a genuinely hung bridge. runBridge already escalates to SIGKILL
 * (its watchdog calls proc.kill("SIGKILL")), and core writes atomically (stage +
 * rename), so even a killed write leaves the ledger + target files intact (D4).
 */
const WRITE_TIMEOUT_MS = 30_000;

// D1 — serialize ALL ledger writers in this process. core's fd-lock guards only
// the `save()` syscall, NOT the load→mutate→save cycle: two concurrent bridge
// spawns both read the same snapshot and the second save drops the first's
// record (a silent lost update — impossible in the single-process desktop app,
// the expected case under process-per-request). A process-wide async mutex makes
// every write handler run strictly one-at-a-time. Reads skip it (atomic rename
// gives them a consistent whole-file snapshot). It's a single promise chain:
// each writer awaits the previous one's settlement before starting; a rejection
// is swallowed for the *chain* (so it never wedges) but still propagates to the
// caller that owns it.
let writeChain: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(fn, fn);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface LibraryRouteResult {
  status: HttpStatus;
  body: unknown;
}

/** Map a dashboard-stable LibraryError code to an HTTP status. */
export function statusForCode(code: string): HttpStatus {
  switch (code) {
    // The library can't be located / isn't a library / its path is bad — the
    // request is well-formed but the precondition fails.
    case "library_unconfigured":
    case "library_marker_missing":
    case "library_invalid_path":
    // Install/drift/migration precondition faults: well-formed request, but the
    // ledger/install state isn't in a state the command can act on.
    case "installs_unconfigured":
    case "installs_already_present": // dest already holds records — idempotent refuse
    case "installs_destination_corrupt": // dashboard's own ledger is unreadable
    case "drift_no_install_record": // acknowledge/scan with nothing recorded
    case "library_no_current_version": // install a primitive with no pinned version
    // Working-file editor conflicts: the request is well-formed but the target
    // file is in a state the command can't act on.
    case "working_file_exists": // create over an existing ref file — use Save
    case "working_file_refuse_primary": // rename/delete the primary file (refused in-core)
    case "library_version_exists": // re-publish an existing label — immutable; use a new label
    // Metadata edit dropped a target that still has overlay files. Like the
    // install `colliding_content`/`force` two-phase-confirm: recoverable by
    // re-issuing with `discard_orphan_overlays: true`, so it's a 409 conflict
    // the user resolves by confirming, NOT a 422 bad-input dead-end.
    case "library_target_removed_with_overlays":
      return 409;
    // Bad client input (the :kind / :name segment, or a non-UTF-8 path).
    case "library_invalid_name":
    case "library_invalid_kind":
    case "library_invalid_version":
    case "library_invalid_path_encoding":
    case "library_invalid_target":
    // Unprocessable migration/install inputs.
    case "installs_format_mismatch": // source format_version != dashboard (lockstep, D9)
    case "installs_source_corrupt": // the standalone source won't parse
    case "library_target_not_allowed": // target not in the primitive's allowed_targets
    case "library_target_not_allowed_for_kind":
    case "library_install_not_supported":
    // Working-file editor unprocessable inputs.
    case "library_invalid_working_path": // ../, absolute, NUL, primary-as-ref — the traversal tripwire
    case "working_file_too_many": // bundle is at the 200-file cap
      return 422;
    case "primitive_not_found":
    case "working_file_not_found": // save/rename a ref file that doesn't exist — use Create
    case "library_version_not_found": // set-current/inspect/revert a label that isn't on disk
      return 404;
    // Everything else — transport faults and read/parse faults — is a 502: the
    // dashboard reached for the library and the bridge couldn't deliver.
    default:
      return 502;
  }
}

/** Turn a LibraryError into a route result. m4: `detail` is logged server-side
 *  and NEVER forwarded to the client (it can embed filesystem paths). */
function errorResult(error: LibraryError): LibraryRouteResult {
  console.error(`[library] ${error.code}: ${error.detail}`);
  return { status: statusForCode(error.code), body: { code: error.code, message: error.message } };
}

const UNCONFIGURED: LibraryError = {
  code: "library_unconfigured",
  message: "no library is configured",
  detail: "library_path is unset in config/library.yaml (and no CC_LIBRARY_PATH override)",
};

// ---------------------------------------------------------------------------
// Factored handlers
// ---------------------------------------------------------------------------

export async function buildKindInfo(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await run(config.bridgePath, "kind_info", {}, { validate: parseKindInfoTable });
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

export async function buildTargetInfo(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await run(config.bridgePath, "target_info", {}, { validate: parseTargetInfo });
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

export async function buildLibraryPrimitives(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "list_primitives",
    { path: config.libraryPath },
    { validate: parsePrimitiveSummaries },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

export async function buildPrimitiveDetail(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "primitive_detail",
    { path: config.libraryPath, kind, name },
    { validate: parsePrimitiveDetail },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Informational status. Unlike the others it never returns a *library* error:
 *  an unconfigured/invalid library is reported as data (`configured`/`is_valid`
 *  flags) so the UI can render the right empty/setup state. Only a genuine
 *  bridge transport fault yields a 502. */
export async function buildLibraryStatus(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) {
    const body: LibraryStatus & { configured: boolean } = {
      configured: false,
      is_valid: false,
      marker_exists: false,
      is_git_repo: false,
      branch: null,
      dirty: null,
      unpushed: null,
    };
    return { status: 200, body };
  }
  const r = await run(
    config.bridgePath,
    "library_status",
    { path: config.libraryPath },
    { validate: parseLibraryStatus },
  );
  if (!r.ok) {
    // A bridge transport fault (binary missing, timeout, unreadable output) is
    // reported as informational DATA, not a 502 — the UI gates on status, and a
    // 502 here collapses to a generic "couldn't load" with no way to act. The
    // `unavailable` descriptor (code + safe message, NOT detail — m4) lets the
    // UI render an actionable state (e.g. "the bridge isn't built — cargo build").
    console.error(`[library] status ${r.error.code}: ${r.error.detail}`);
    return {
      status: 200,
      body: {
        configured: true,
        is_valid: false,
        marker_exists: false,
        is_git_repo: false,
        branch: null,
        dirty: null,
        unpushed: null,
        unavailable: { code: r.error.code, message: r.error.message },
      },
    };
  }
  return { status: 200, body: { configured: true, ...r.data } };
}

// ---------------------------------------------------------------------------
// Write / drift / migration handlers
//
// The install DESTINATION (`home`, `installs_path`) and the library `path` are
// ALWAYS taken from server config, NEVER from the HTTP body — the route layer is
// the containment boundary (InstallPaths::new does zero validation, D7). The
// body supplies only `targets`/`force`/`target`. Every WRITE acquires the
// process write lock (D1); reads skip it. `force` defaults false (two-phase
// safe default): an overwrite only ever results from an explicit `force:true`.
// ---------------------------------------------------------------------------

interface WriteBody {
  targets?: unknown;
  force?: unknown;
  target?: unknown;
}

export async function buildInstall(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WriteBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  // Install materializes the pinned version from the library, so it needs the
  // layout — refuse early (no spawn) when unconfigured.
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = {
    path: config.libraryPath,
    home: config.home,
    installs_path: config.installsPath,
    kind,
    name,
    targets: body.targets ?? [],
    force: body.force === true,
    installed_at: now,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "install", args, { validate: parseInstallSummary, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  // A summary containing `colliding_content` is a NORMAL 200 (the dialog
  // trigger) — the UI inspects outcomes; only a bridge/app error is non-200.
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

export async function buildUninstall(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  // Uninstall works off installs.json + the install root only — no layout, so
  // it runs even when the library is unconfigured.
  const args = {
    home: config.home,
    installs_path: config.installsPath,
    kind,
    name,
    targets: body.targets ?? [],
    force: body.force === true,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "uninstall", args, { validate: parseUninstallSummary, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

export async function buildAcknowledgeDrift(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const args = {
    home: config.home,
    installs_path: config.installsPath,
    kind,
    name,
    target: body.target ?? null,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "acknowledge_drift", args, { timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Read: the compact per-target install projection (no write lock). */
export async function buildInstallsForPrimitive(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const r = await run(
    config.bridgePath,
    "list_installs_for_primitive",
    { home: config.home, installs_path: config.installsPath, kind, name },
    { validate: parseInstalledTargets },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Read: whole-ledger drift in one spawn — feeds explorer badges + detail (no
 *  write lock; atomic rename gives a consistent snapshot). */
export async function buildDriftBatch(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await run(
    config.bridgePath,
    "scan_drift_batch",
    { home: config.home, installs_path: config.installsPath },
    { validate: parseDriftReports },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Read: per-primitive drift (fresh + scoped) — the AUTHORITATIVE source for the
 *  detail pane's rows and post-write/post-ack reload (D8). The batch above is for
 *  explorer badges only; reloading the whole batch after a single-target write is
 *  heavy and racy. No write lock. */
export async function buildScanDrift(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const r = await run(
    config.bridgePath,
    "scan_drift",
    { home: config.home, installs_path: config.installsPath, kind, name },
    { validate: parseDriftReports },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: the one-click standalone→dashboard migration. */
export async function buildImportInstalls(
  config: LibraryConfig,
  run: Run = runBridge,
  sourcePath?: string,
): Promise<LibraryRouteResult> {
  const r = await withWriteLock(() => importInstalls(config, run, sourcePath));
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Working-file (editor) handlers (working-copy slice)
//
// The library ROOT is always `config.libraryPath` (never the body) — every
// working-file command needs the layout, so each refuses early when unconfigured.
// The ref-file PATH rides the HTTP body/query as `path` and is forwarded to the
// bridge as `rel`/`old_rel`/`new_rel` (the bridge reserves `path` for the library
// root). It is NOT validated here: core's `validate_path_shape`/`validate_ref_path`
// is the single containment boundary (the traversal tripwire) — the route must not
// duplicate or weaken it, so a `../` path flows straight through and comes back as
// `library_invalid_working_path` → 422.
//
// Reads (`list`/`read`) skip the write timeout AND the ledger mutex. Writes get
// WRITE_TIMEOUT_MS + SIGKILL but ALSO skip the ledger mutex (D1): a working-file
// write never load→mutate→saves `installs.json`, and core's `save_base_file` is a
// single atomic temp-file+rename, so concurrent writes to the same file are
// last-writer-wins with no torn file — the simplest atomicity case, no cross-step
// partial-failure surface (stated per the roadmap's multi-write rule).
// ---------------------------------------------------------------------------

interface WorkingWriteBody {
  content?: unknown;
  path?: unknown;
  old_path?: unknown;
  new_path?: unknown;
}

/** Read: the primitive's `working/base/` bundle list (primary-first). No lock. */
export async function buildListWorkingFiles(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "list_working_files",
    { path: config.libraryPath, kind, name },
    { validate: parseWorkingFileEntries },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Read: one ref file's tagged bytes (text/binary). The ref path rides a query
 *  param (a `:path` segment can't carry `/` for nested refs). No lock. */
export async function buildReadWorkingFile(
  config: LibraryConfig,
  kind: string,
  name: string,
  relPath: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "read_working_file",
    { path: config.libraryPath, kind, name, rel: relPath },
    { validate: parseWorkingFileBytes },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: save the PRIMARY file (parse-validated in-core before the atomic
 *  write; a malformed blob returns library_parse_error, disk unchanged). */
export async function buildSaveWorking(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WorkingWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "save_working",
    { path: config.libraryPath, kind, name, content: body.content },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Write: create a new ref file (errors working_file_exists if occupied). */
export async function buildCreateWorkingFile(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WorkingWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "create_working_file",
    { path: config.libraryPath, kind, name, rel: body.path, content: body.content },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Write: update an existing ref file (errors working_file_not_found if absent). */
export async function buildSaveWorkingFile(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WorkingWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "save_working_file",
    { path: config.libraryPath, kind, name, rel: body.path, content: body.content },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Write: rename/move a ref file (refuses the primary; non-destructive in-core). */
export async function buildRenameWorkingFile(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WorkingWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "rename_working_file",
    { path: config.libraryPath, kind, name, old_rel: body.old_path, new_rel: body.new_path },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Write: delete a ref file (idempotent on missing; refuses the primary). */
export async function buildDeleteWorkingFile(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: WorkingWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "delete_working_file",
    { path: config.libraryPath, kind, name, rel: body.path },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Versioning / publishing handlers (versioning slice)
//
// The library ROOT is always `config.libraryPath` (never the body) — every
// command needs the layout, so each refuses early when unconfigured. The body
// supplies only `version_label` (+ optional `notes` for publish). Writes get
// WRITE_TIMEOUT_MS + SIGKILL but SKIP the ledger mutex (Decision 4): versioning
// touches `versions/<label>/` + `current.txt` + the git index, NEVER
// `installs.json`, so there is no load→mutate→save ledger cycle to serialize;
// git's own `index.lock` serializes concurrent commits, and a lock collision
// surfaces as a NON-fatal `commit_error` in the PublishResult, not corruption.
//
// publish/set-current return a `PublishResult` ({committed, commit_error}) at
// HTTP 200 even when the git commit failed (Decision 1+3): the version mutation
// already succeeded; the commit is advisory. The UI renders the commit state as
// a cue, never an error toast. `read` is a pure read (no lock, default 10s
// timeout); `revert` rewrites only gitignored `working/` and never commits
// (Decision 2), returning `{}`.
// ---------------------------------------------------------------------------

interface VersionWriteBody {
  version_label?: unknown;
  notes?: unknown;
}

/** Write: snapshot the working copy as a new immutable version, then commit.
 *  Re-publishing an existing label → library_version_exists (409). The publish
 *  timestamp is server-stamped (config/clock owned by the route, like install),
 *  never body-derived. */
export async function buildPublish(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: VersionWriteBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "publish",
    {
      path: config.libraryPath,
      kind,
      name,
      version_label: body.version_label,
      notes: typeof body.notes === "string" ? body.notes : null,
      created_at: now,
    },
    { validate: parsePublishResult, timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: move `current.txt` (the pointer a FUTURE install reads) to a version,
 *  then commit. Unknown label → library_version_not_found (404). Working copy
 *  untouched (this is NOT a revert). */
export async function buildSetCurrentVersion(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: VersionWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "set_current_version",
    { path: config.libraryPath, kind, name, version_label: body.version_label },
    { validate: parsePublishResult, timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Read: a frozen version's primary content + metadata for the inspector. The
 *  label rides a `:label` path segment (a version label has no `/`). No lock,
 *  default read timeout. Unknown label → library_version_not_found (404). */
export async function buildReadPrimitiveVersion(
  config: LibraryConfig,
  kind: string,
  name: string,
  label: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "read_primitive_version",
    { path: config.libraryPath, kind, name, version_label: label },
    { validate: parsePrimitiveVersionView },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: rewind `working/` to a frozen version (overwrite + delete orphans). A
 *  LIBRARY-CONTENT op, distinct from install pinning — it does NOT commit
 *  (working/ is gitignored) and touches no install record. Unknown label → 404. */
export async function buildRevertToVersion(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: VersionWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "revert_to_version",
    { path: config.libraryPath, kind, name, version_label: body.version_label },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Target-overlay handlers (target-overlays slice)
//
// The library ROOT is always `config.libraryPath` (never the body); the target
// rides a `:target` path segment (a closed enum value — no `/`, so it's a safe
// segment, unlike the working-file ref path that needed `?path=`). A bad
// `:target` value → library_invalid_target (422) in-core. Reads
// (`read_primitive_target` / `list_overlays`) skip the write lock and take the
// default read timeout. Writes (`write_overlay` / `remove_overlay`) get
// WRITE_TIMEOUT + SIGKILL but NO ledger mutex (Decision 2): overlays write only
// `working/targets/<target>/<primary>` — gitignored, single-file-atomic in-core,
// never installs.json and never a git commit. A malformed overlay blob returns
// library_parse_error (the in-core parse-validate fires BEFORE the atomic write,
// so disk is unchanged) — 502 today, exactly as the Slice 3 primary save
// (`save_working`) treats the same code; the editor surfaces it inline, and we
// don't fork a shared code's status.
// ---------------------------------------------------------------------------

interface OverlayWriteBody {
  content?: unknown;
}

/** Read: the merged primary for a (primitive, target) pair + has_overlay. A
 *  target outside the primitive's allowed_targets → library_target_not_allowed
 *  (422); a bad :target value → library_invalid_target (422). No lock. */
export async function buildReadPrimitiveTarget(
  config: LibraryConfig,
  kind: string,
  name: string,
  target: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "read_primitive_target",
    { path: config.libraryPath, kind, name, target },
    { validate: parseTargetView },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: save the PRIMARY overlay file for a target (parse-validated in-core
 *  before the atomic write; malformed → library_parse_error, disk unchanged).
 *  Writes only working/targets/<target>/<primary> — no commit, no ledger. */
export async function buildWriteOverlay(
  config: LibraryConfig,
  kind: string,
  name: string,
  target: string,
  body: OverlayWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "write_overlay",
    { path: config.libraryPath, kind, name, target, content: body.content },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Write: remove the PRIMARY overlay file for a target (idempotent in-core; the
 *  merged view reverts to the base passthrough). No commit, no ledger. */
export async function buildRemoveOverlay(
  config: LibraryConfig,
  kind: string,
  name: string,
  target: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "remove_overlay",
    { path: config.libraryPath, kind, name, target },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** Read: every target's overlay surface (one {target, paths} per target that
 *  carries ≥1 overlay file). No lock, default read timeout. */
export async function buildListOverlays(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "list_overlays",
    { path: config.libraryPath, kind, name },
    { validate: parseOverlayLists },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Metadata-editing handler (metadata-editing slice)
//
// The library ROOT is always `config.libraryPath` (never the body); the body
// supplies the editable subset (`allowed_targets` / `display_name` / `author` +
// the optional `discard_orphan_overlays` confirm). Like publish/set-current it
// returns a commit-bearing result at HTTP 200 even on a commit failure: unlike
// the overlay writes, `metadata.yaml` is git-TRACKED, so the write COMMITS
// (Slice 4's posture) — `committed`/`commit_error` ride back as a cue, never an
// error toast. WRITE_TIMEOUT + SIGKILL but NO ledger mutex (no installs.json
// touch; git's index.lock serializes commits, exactly like publish). Dropping a
// target that still has overlay files → library_target_removed_with_overlays
// (409): the UI confirms and re-issues with `discard_orphan_overlays: true`. The
// error PAYLOAD (the dropped paths) stays server-side (m4 / never-forward-
// detail); the UI names the affected paths from its already-loaded list_overlays
// data, so the confirm copy needs no payload forwarding (O1, resolved: derive
// client-side).
// ---------------------------------------------------------------------------

interface MetadataWriteBody {
  allowed_targets?: unknown;
  display_name?: unknown;
  author?: unknown;
  discard_orphan_overlays?: unknown;
}

/** Write: replace a primitive's editable metadata fields, then commit. Dropping
 *  a target with overlay files → library_target_removed_with_overlays (409),
 *  resolved by re-issuing with `discard_orphan_overlays: true`. A kind-illegal
 *  target → library_target_not_allowed_for_kind (422). Returns the freshly-
 *  written metadata + the advisory commit result at 200 even on a commit fail. */
export async function buildUpdateMetadata(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: MetadataWriteBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "update_metadata",
    {
      path: config.libraryPath,
      kind,
      name,
      allowed_targets: body.allowed_targets,
      display_name: typeof body.display_name === "string" ? body.display_name : null,
      author: typeof body.author === "string" ? body.author : null,
      discard_orphan_overlays: body.discard_orphan_overlays === true,
    },
    { validate: parseMetadataUpdateResult, timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** `loadConfig` is injectable so the HTTP-wiring test is deterministic — it must
 *  not depend on the machine's actual config/library.yaml contents. */
export function registerLibraryRoutes(
  app: Hono,
  loadConfig: () => LibraryConfig = loadLibraryConfig,
): void {
  const json = (c: any, r: LibraryRouteResult) =>
    c.json(r.body as object, r.status as ContentfulStatusCode);
  // Tolerant body read: a missing/empty/invalid JSON body is an empty object
  // (the handlers default their fields), never a 500. Returns a loose record so
  // it serves both the install WriteBody and the editor WorkingWriteBody shapes.
  const readJson = async (c: any): Promise<Record<string, unknown>> => {
    try {
      return ((await c.req.json()) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  };
  // Config is resolved per-request so editing config/library.yaml (or the env
  // override) takes effect without a server restart — cheap (one small YAML read).
  app.get("/api/library/status", async (c) => json(c, await buildLibraryStatus(loadConfig())));
  app.get("/api/library/kind-info", async (c) => json(c, await buildKindInfo(loadConfig())));
  app.get("/api/library/target-info", async (c) => json(c, await buildTargetInfo(loadConfig())));
  app.get("/api/library/primitives", async (c) => json(c, await buildLibraryPrimitives(loadConfig())));
  // Whole-ledger drift (feeds explorer badges + detail on the 30s poll). Mounted
  // before the :kind/:name routes — distinct path, but kept grouped with reads.
  app.get("/api/library/drift", async (c) => json(c, await buildDriftBatch(loadConfig())));
  app.get("/api/library/primitives/:kind/:name", async (c) =>
    json(c, await buildPrimitiveDetail(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  app.get("/api/library/primitives/:kind/:name/installs", async (c) =>
    json(c, await buildInstallsForPrimitive(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  app.get("/api/library/primitives/:kind/:name/drift", async (c) =>
    json(c, await buildScanDrift(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  // Working-file editor reads (no write lock). The ref path rides a `?path=`
  // query param on the content read — a `:path` segment can't carry `/` for a
  // nested ref like `notes/intro.md`. A missing param forwards "" → core rejects
  // it as an invalid working path (422), never a silent miss.
  app.get("/api/library/primitives/:kind/:name/working-files", async (c) =>
    json(c, await buildListWorkingFiles(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  app.get("/api/library/primitives/:kind/:name/working-files/content", async (c) =>
    json(
      c,
      await buildReadWorkingFile(
        loadConfig(),
        c.req.param("kind"),
        c.req.param("name"),
        c.req.query("path") ?? "",
      ),
    ),
  );
  // Writes — POST install / DELETE uninstall / POST acknowledge-drift / POST
  // import. Each inherits server.ts's loopback Host + Origin guard; the write
  // lock (D1) lives in the handlers. D7 residual: server.ts allows an ABSENT
  // Origin on writes (for OTLP server-to-server emitters, which only ever hit
  // /v1/*). A browser CSRF always sends an Origin → already blocked by the
  // present-Origin-must-be-loopback check; the only uncovered vector is a LOCAL
  // non-browser process POSTing with no Origin — accepted as residual (a local
  // process has many higher-leverage options). The containment boundary that
  // matters — the write root being CONFIG-resolved, never body-derived — is
  // enforced here (buildInstall/Uninstall ignore body home/installs_path) and
  // asserted by the D7 tripwire test.
  app.post("/api/library/primitives/:kind/:name/install", async (c) =>
    json(c, await buildInstall(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.delete("/api/library/primitives/:kind/:name/install", async (c) =>
    json(c, await buildUninstall(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/acknowledge-drift", async (c) =>
    json(c, await buildAcknowledgeDrift(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/import-installs", async (c) => json(c, await buildImportInstalls(loadConfig())));
  // Working-file editor writes (WRITE_TIMEOUT + SIGKILL; no ledger mutex — they
  // never touch installs.json, and core's save_base_file is single-file-atomic).
  // The primary save (`/working`) is parse-validated in-core before the atomic
  // write; the ref-file verbs (`/working-files`) refuse the primary filename
  // in-core. Each inherits server.ts's loopback Host + Origin guard.
  app.post("/api/library/primitives/:kind/:name/working", async (c) =>
    json(c, await buildSaveWorking(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/working-files", async (c) =>
    json(c, await buildCreateWorkingFile(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.put("/api/library/primitives/:kind/:name/working-files", async (c) =>
    json(c, await buildSaveWorkingFile(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.put("/api/library/primitives/:kind/:name/working-files/rename", async (c) =>
    json(c, await buildRenameWorkingFile(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.delete("/api/library/primitives/:kind/:name/working-files", async (c) =>
    json(c, await buildDeleteWorkingFile(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  // Versioning / publishing reads + writes. The read (`GET …/versions/:label`)
  // carries the label as a path segment (a version label has no `/`); it skips
  // the write lock. The writes (publish / set-current / revert) get
  // WRITE_TIMEOUT + SIGKILL but no ledger mutex (Decision 4 — they never touch
  // installs.json). publish/set-current return a PublishResult ({committed,
  // commit_error}) at 200 even on a commit failure (Decision 1+3). Each inherits
  // server.ts's loopback Host + Origin guard. Mounted AFTER the more specific
  // `/working-files*` routes; `/versions` and `/versions/:label` don't collide
  // with them (distinct path prefix).
  app.get("/api/library/primitives/:kind/:name/versions/:label", async (c) =>
    json(
      c,
      await buildReadPrimitiveVersion(
        loadConfig(),
        c.req.param("kind"),
        c.req.param("name"),
        c.req.param("label"),
      ),
    ),
  );
  app.post("/api/library/primitives/:kind/:name/versions", async (c) =>
    json(c, await buildPublish(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/current-version", async (c) =>
    json(c, await buildSetCurrentVersion(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/revert", async (c) =>
    json(c, await buildRevertToVersion(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  // Target-overlay reads + writes. The merged-view read carries the target as a
  // `:target` path segment (a closed enum value, no `/`); the overlays-list read
  // is per-primitive. Both skip the write lock. The writes (`PUT`/`DELETE
  // …/overlay`) get WRITE_TIMEOUT + SIGKILL but no ledger mutex (Decision 2 —
  // they touch only gitignored working/targets/, never installs.json, never a
  // commit). Each inherits server.ts's loopback Host + Origin guard. Mounted
  // AFTER the `/working-files*` and `/versions*` routes; `/targets` and
  // `/overlays` are distinct path prefixes — no collision.
  app.get("/api/library/primitives/:kind/:name/targets/:target", async (c) =>
    json(
      c,
      await buildReadPrimitiveTarget(
        loadConfig(),
        c.req.param("kind"),
        c.req.param("name"),
        c.req.param("target"),
      ),
    ),
  );
  app.put("/api/library/primitives/:kind/:name/targets/:target/overlay", async (c) =>
    json(
      c,
      await buildWriteOverlay(
        loadConfig(),
        c.req.param("kind"),
        c.req.param("name"),
        c.req.param("target"),
        await readJson(c),
      ),
    ),
  );
  app.delete("/api/library/primitives/:kind/:name/targets/:target/overlay", async (c) =>
    json(
      c,
      await buildRemoveOverlay(
        loadConfig(),
        c.req.param("kind"),
        c.req.param("name"),
        c.req.param("target"),
      ),
    ),
  );
  app.get("/api/library/primitives/:kind/:name/overlays", async (c) =>
    json(c, await buildListOverlays(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  // Metadata edit (write; commits — metadata.yaml is git-tracked, unlike the
  // gitignored overlays above). WRITE_TIMEOUT + SIGKILL, no ledger mutex.
  // Returns a MetadataUpdateResult ({metadata, committed, commit_error}) at 200
  // even on a commit failure (Slice 4's posture). Dropping a target with overlay
  // files → 409; the UI confirms and re-PUTs with discard_orphan_overlays. The
  // `/metadata` segment is distinct from /working-files, /versions, /targets,
  // /overlays — no collision. Inherits server.ts's loopback Host + Origin guard.
  app.put("/api/library/primitives/:kind/:name/metadata", async (c) =>
    json(c, await buildUpdateMetadata(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
}
