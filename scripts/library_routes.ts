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
import { loadLibraryConfig, persistRemoteUrl, type LibraryConfig } from "./library_config.ts";
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
  parseReimportResult,
  parseSearchResults,
  parseDeletePrimitiveResult,
  parseRenamePrimitiveResult,
  parseDuplicatePrimitiveResult,
  parseImportFromPathResult,
  parseForgetResult,
  parseBootstrapScanResult,
  parseBootstrapSessionResult,
  parseBootstrapExecuteSummary,
  parseRemoteStatus,
  parseScanFindings,
  parseUnpushedCount,
  parsePullPaused,
  parsePullResult,
  parseContinueResult,
  parseConflictList,
  parseConflictBlob,
  parseConfiguredRemote,
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

/**
 * Push/pull egress (Slice 8, D5) tolerate a slower-but-healthy network than a
 * local fs write, so they get a longer watchdog. It MUST exceed the bridge's
 * inner `PULL_TIMEOUT` (60s) so a hung pull surfaces as a clean `git_timed_out`
 * from the bridge rather than a SIGKILL'd torn process. Bounded so a dead
 * network can't wedge the write chain (the whole git-sync family serializes
 * under `withWriteLock`) forever.
 */
const NETWORK_TIMEOUT_MS = 90_000;

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
    case "bootstrap_unconfigured": // session/backup path unset — dashboard config not ready
    case "installs_already_present": // dest already holds records — idempotent refuse
    case "installs_destination_corrupt": // dashboard's own ledger is unreadable
    case "drift_no_install_record": // acknowledge/scan with nothing recorded
    case "library_no_current_version": // install a primitive with no pinned version
    // Working-file editor conflicts: the request is well-formed but the target
    // file is in a state the command can't act on.
    case "working_file_exists": // create over an existing ref file — use Save
    case "working_file_refuse_primary": // rename/delete the primary file (refused in-core)
    case "library_version_exists": // re-publish an existing label — immutable; use a new label
    case "library_primitive_exists": // create/rename/duplicate onto a taken name — pick another
    // Metadata edit dropped a target that still has overlay files. Like the
    // install `colliding_content`/`force` two-phase-confirm: recoverable by
    // re-issuing with `discard_orphan_overlays: true`, so it's a 409 conflict
    // the user resolves by confirming, NOT a 422 bad-input dead-end.
    case "library_target_removed_with_overlays":
    // Git-sync preconditions (Slice 8): well-formed request, but the git/PAT
    // state isn't ready for the command.
    case "no_pat_stored": // push/pull before a PAT is configured
    case "remote_not_configured": // push/pull before a remote URL is set
    case "askpass_unconfigured": // dashboard config (askpass_dir) not injected
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
    // Git-sync bad inputs (Slice 8).
    case "empty_pat": // set_pat with an empty token
    case "invalid_remote_url": // configure_remote with a non-github/non-https/credentialed URL
    case "invalid_conflict_side": // resolve/read with a side other than local|remote
    case "conflict_path_missing": // resolve/read with no conflict path
    case "conflict_blob_not_utf8": // a conflicted blob the text resolver can't render
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

/** Library-wide content search (search slice). A READ — no write lock, no
 *  WRITE_TIMEOUT; it uses the default read timeout exactly like
 *  buildLibraryPrimitives. An absent/empty `query` forwards `""` → the bridge
 *  returns `[]` (200), never an error. */
export async function buildSearch(
  config: LibraryConfig,
  query: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "find_in_library",
    { path: config.libraryPath, query },
    { validate: parseSearchResults },
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

/** A reimport-from-drift request: pull a `(kind, name, source_target)` install's
 *  on-disk bytes back into the library as `version_label`. `discard_working`
 *  confirms blowing away unpublished working-copy edits (the two-phase
 *  `working_copy_dirty` confirm); `fixed_primary_text` is the broken-source retry
 *  payload (the user-corrected primary file). */
interface ReimportBody {
  source_target?: unknown;
  version_label?: unknown;
  notes?: unknown;
  discard_working?: unknown;
  fixed_primary_text?: unknown;
}

/** Write: snapshot an installed copy's on-disk (drifted) bytes as a new library
 *  version and re-baseline the install record. Reimport is the INVERSE of
 *  install. Unlike its publish sibling, this handler takes `withWriteLock`: core
 *  re-baselines `installs.json` (reimport.rs re-introduces the load→mutate→save
 *  ledger cycle D1 serializes), so without the lock a concurrent install/
 *  acknowledge could lost-update the record. Needs the library layout (the
 *  snapshot materializes into `versions/`), so refuse early when unconfigured.
 *
 *  All five ReimportResult variants ride HTTP 200 as DATA the UI routes on
 *  (reimported / working_copy_dirty / broken_source / not_installed /
 *  install_missing) — exactly as a `colliding_content` InstallSummary rides 200.
 *  Only genuine core faults map to 422/409/404/502. The reimport timestamp is
 *  server-stamped (route owns the clock, like publish/install), never
 *  body-derived. */
export async function buildReimport(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: ReimportBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = {
    path: config.libraryPath,
    home: config.home,
    installs_path: config.installsPath,
    kind,
    name,
    target: body.source_target ?? null,
    version_label: body.version_label,
    notes: typeof body.notes === "string" ? body.notes : null,
    discard_working: body.discard_working === true,
    fixed_primary_text: typeof body.fixed_primary_text === "string" ? body.fixed_primary_text : null,
    created_at: now,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "reimport_install", args, {
      validate: parseReimportResult,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
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
// Primitive-lifecycle handlers (lifecycle slice)
//
// Structural CRUD over the library. The library ROOT is always
// `config.libraryPath`; `home`/`installs_path` are CONFIG-injected, NEVER
// body-derived (D7) — only `kind`/`name`/`new_name`/`source_path` ride the body.
// The write-lock split follows the publish-vs-reimport precedent: a command
// takes `withWriteLock` IFF it load→mutate→saves installs.json.
//   - create / duplicate → NO lock (publish posture): they edit only the
//     library tree + git, never installs.json. A concurrent commit race is
//     non-fatal (git's own index.lock + the {committed, commit_error} contract),
//     exactly as concurrent publishes already are.
//   - delete / rename / import / forget → withWriteLock: each mutates
//     installs.json — the D1 lost-update hazard reimport documents.
// create/duplicate/delete/rename/import need the layout → refuse early when
// unconfigured. `forget` works off installs.json only, so it runs even
// unconfigured (the uninstall posture). The server-stamped `created_at` (route
// owns the clock, like publish/install) seeds new metadata; it is never
// body-derived.
// ---------------------------------------------------------------------------

interface CreateBody {
  kind?: unknown;
  name?: unknown;
}

interface NewNameBody {
  new_name?: unknown;
}

interface ImportFromPathBody {
  source_path?: unknown;
}

/** Write: scaffold a new primitive, then commit. `kind`/`name` ride the body
 *  (collection-level POST). A name collision → library_primitive_exists (409); a
 *  malformed name → library_invalid_name (422). No write lock (touches no
 *  installs.json — publish posture). Returns a PublishResult shape. */
export async function buildCreatePrimitive(
  config: LibraryConfig,
  body: CreateBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "create_primitive",
    {
      path: config.libraryPath,
      kind: typeof body.kind === "string" ? body.kind : "",
      name: typeof body.name === "string" ? body.name : "",
      created_at: now,
    },
    { validate: parsePublishResult, timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: wipe a primitive — force-uninstall every target, rm -rf the dir, drop
 *  records, then commit (ONLY when the dir was actually removed). Takes the write
 *  lock (it mutates installs.json). A DeletePrimitiveResult rides 200 as data the
 *  UI inspects — a bail (uninstall `failures` non-empty, dir untouched) is NOT an
 *  error. */
export async function buildDeletePrimitive(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = { path: config.libraryPath, home: config.home, installs_path: config.installsPath, kind, name };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "delete_primitive", args, {
      validate: parseDeletePrimitiveResult,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: fs::rename the library dir + rewrite installs.json records, then
 *  commit. A `new_name` collision → 409; a missing source → 404. Takes the write
 *  lock (it rewrites installs.json). The `install_records_updated` count rides
 *  back for the UI's "N installed copies keep the old name" caveat. */
export async function buildRenamePrimitive(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: NewNameBody,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = {
    path: config.libraryPath,
    home: config.home,
    installs_path: config.installsPath,
    kind,
    name,
    new_name: typeof body.new_name === "string" ? body.new_name : "",
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "rename_primitive", args, {
      validate: parseRenamePrimitiveResult,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: copy working/ + a freshly-stamped metadata.yaml to `new_name`, then
 *  commit. Versions and install records are NOT carried. No write lock (touches
 *  no installs.json — publish posture). A `new_name` collision → 409; a missing
 *  source → 404. */
export async function buildDuplicatePrimitive(
  config: LibraryConfig,
  kind: string,
  name: string,
  body: NewNameBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "duplicate_primitive",
    {
      path: config.libraryPath,
      kind,
      name,
      new_name: typeof body.new_name === "string" ? body.new_name : "",
      created_at: now,
    },
    { validate: parseDuplicatePrimitiveResult, timeoutMs: WRITE_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: import a primitive from a local path ALREADY under a recognized
 *  install root (the drag-drop fast path, NOT url import — that's Slice 10b).
 *  `home`/`installs_path` are config-injected (D7); only `source_path` rides the
 *  body. Takes the write lock (execute_creates writes installs.json). Every
 *  ImportFromPathResult variant rides 200 as data the UI routes on
 *  (imported / already_exists / not_classifiable); only `imported` committed. */
export async function buildImportFromPath(
  config: LibraryConfig,
  body: ImportFromPathBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = {
    path: config.libraryPath,
    home: config.home,
    installs_path: config.installsPath,
    source_path: typeof body.source_path === "string" ? body.source_path : "",
    created_at: now,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "import_primitive_from_path", args, {
      validate: parseImportFromPathResult,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: drop a primitive's installs.json records (the Reconcile "mark removed"
 *  action for a primitive whose library dir is already gone). Works off
 *  installs.json only — no layout, so it runs even when the library is
 *  unconfigured (uninstall posture). Takes the write lock (it mutates
 *  installs.json). NO commit (the ledger is not in the library repo). */
export async function buildForgetPrimitive(
  config: LibraryConfig,
  kind: string,
  name: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const args = { home: config.home, installs_path: config.installsPath, kind, name };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "forget_primitive", args, {
      validate: parseForgetResult,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Bootstrap-discovery handlers (bootstrap slice)
//
// The first-run scan→review→execute wizard. `path`/`home`/`installs_path`/
// `session_path`/`backup_dir` are ALL config-injected (D7) — only the
// `plan`/`resume`/`excluded_ids` (round-tripped from the scan) ride the body.
// scan + session-read are READS (no write lock); scan gets a longer watchdog
// than the 10s read default (it walks the home tree once). execute +
// session-clear are WRITES under the ledger mutex (execute mutates installs.json
// — the reimport divergence; clear serializes against a concurrent execute).
// Every BootstrapExecuteSummary (including a partial run's skipped_items) rides
// 200 as DATA; only genuine core faults map to 4xx/502. The execute timestamp is
// server-stamped (route owns the clock), never body-derived.
// ---------------------------------------------------------------------------

/** The scan walks the user's `~/.claude`/`.pi`/`.codex` roots once; at ~117
 *  primitives it benches in the ~50-80ms range the search slice measured, but a
 *  pathological home could be slower — so it gets a watchdog larger than the 10s
 *  read default (which would spuriously 502 a slow-but-healthy scan). Distinct
 *  from WRITE_TIMEOUT_MS by intent, not value. */
const BOOTSTRAP_SCAN_TIMEOUT_MS = 30_000;

interface BootstrapExecuteRequestBody {
  plan?: unknown;
  resume?: unknown;
  excluded_ids?: unknown;
}

/** Read: scan the machine, cross-reference the library, and return the full
 *  classification + the derived executable plan in one envelope (`derive_plan`
 *  ran server-side). Needs the library layout (it cross-references), so refuse
 *  early when unconfigured. No write lock; a longer watchdog than the read
 *  default. */
export async function buildBootstrapScan(
  config: LibraryConfig,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await run(
    config.bridgePath,
    "bootstrap_scan",
    { path: config.libraryPath, home: config.home },
    { validate: parseBootstrapScanResult, timeoutMs: BOOTSTRAP_SCAN_TIMEOUT_MS },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Write: execute a (frontend-filtered) bootstrap plan — create the New ones,
 *  reimport the Drifted ones, after a one-time source backup, with a resumable
 *  session checkpoint. Takes the write lock (it mutates installs.json — the
 *  reimport divergence from publish). All five config paths are injected (D7);
 *  only plan/resume/excluded_ids ride the body. `created_at` is server-stamped.
 *  A partial run's skipped_items ride 200 as data, never an error. */
export async function buildBootstrapExecute(
  config: LibraryConfig,
  body: BootstrapExecuteRequestBody,
  run: Run = runBridge,
  now: string = new Date().toISOString(),
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const args = {
    path: config.libraryPath,
    home: config.home,
    installs_path: config.installsPath,
    session_path: config.sessionPath,
    backup_dir: config.backupDir,
    plan: body.plan ?? null,
    resume: body.resume ?? null,
    excluded_ids: Array.isArray(body.excluded_ids) ? body.excluded_ids : [],
    created_at: now,
  };
  const r = await withWriteLock(() =>
    run(config.bridgePath, "bootstrap_execute", args, {
      validate: parseBootstrapExecuteSummary,
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** Read: load the resumable bootstrap session (the prior partial run's
 *  checkpoint). Works off the session file only (no layout), so it runs even
 *  when the library is unconfigured. An absent session is a 200 `{session:null}`,
 *  never a 404. No write lock. */
export async function buildReadBootstrapSession(
  config: LibraryConfig,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const r = await run(
    config.bridgePath,
    "read_bootstrap_session",
    { session_path: config.sessionPath },
    { validate: parseBootstrapSessionResult },
  );
  return r.ok ? { status: 200, body: { session: r.data } } : errorResult(r.error);
}

/** Write: clear the bootstrap session (the wizard's Discard / start-over).
 *  Idempotent. Takes the write lock to serialize against a concurrent execute.
 *  Session-file only — runs even when the library is unconfigured. */
export async function buildClearBootstrapSession(
  config: LibraryConfig,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  const r = await withWriteLock(() =>
    run(config.bridgePath, "clear_bootstrap_session", { session_path: config.sessionPath }, {
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** `loadConfig` is injectable so the HTTP-wiring test is deterministic — it must
 *  not depend on the machine's actual config/library.yaml contents. */
// ---------------------------------------------------------------------------
// Git remote sync (Slice 8). The ONLY routes that egress to a non-loopback host
// (push/pull) and the ONLY ones whose bridge call handles a secret. The PAT is
// NEVER in these args — the bridge reads it from the keychain itself; the route
// only ever injects the library path + the dashboard-owned askpass dir. The whole
// family serializes under withWriteLock (D5): the rebase state in .git is shared
// mutable state a concurrent resolve/list would tear. `secret_store` is NEVER
// injected here, so production always hits the real keychain (the cfg(test)-gated
// arg can't reach the bridge from a route).
// ---------------------------------------------------------------------------

const REMOTE_NOT_CONFIGURED: LibraryError = {
  code: "remote_not_configured",
  message: "no git remote is configured",
  detail: "remote_url is unset in config/library.yaml — configure a remote before push/pull",
};

interface GitBody {
  url?: unknown;
  pat?: unknown;
  path?: unknown; // a conflict path (UI-facing key); injected as conflict_path
  side?: unknown;
}

const gitStr = (v: unknown): string => (typeof v === "string" ? v : "");

/** configure_remote: validate + normalize in-bridge, WIRE the library's git
 *  `origin` to the URL (so a locally-created library can push, not just a clone),
 *  then persist the URL to config/library.yaml (D1 — the ONE route that mutates
 *  the config file). All inside the write lock; persist only on success. Needs a
 *  configured library now (origin lives in the repo). `persist` injected for tests. */
export async function buildConfigureRemote(
  config: LibraryConfig,
  body: GitBody,
  run: Run = runBridge,
  persist: (url: string, configDir?: string) => void = persistRemoteUrl,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(async () => {
    const res = await run(
      config.bridgePath,
      "configure_remote",
      { path: config.libraryPath, url: gitStr(body.url) },
      { validate: parseConfiguredRemote, timeoutMs: WRITE_TIMEOUT_MS },
    );
    if (res.ok) persist(res.data.remote_url);
    return res;
  });
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** set_pat: store the PAT in the keychain. The raw PAT rides the bridge args
 *  (stdin) ONLY — the route never logs it (errorResult logs error.detail, which
 *  is bridge-supplied + PAT-free, never the request body). Write-locked. */
export async function buildSetPat(config: LibraryConfig, body: GitBody, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await withWriteLock(() =>
    run(config.bridgePath, "set_pat", { pat: gitStr(body.pat) }, { timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** delete_pat: idempotent PAT removal. Write-locked. */
export async function buildDeletePat(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await withWriteLock(() => run(config.bridgePath, "delete_pat", {}, { timeoutMs: WRITE_TIMEOUT_MS }));
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** get_remote_status: remote URL (injected from config) + REDACTED PAT. No write
 *  lock (pure status read). The only PAT form on the wire is `pat_redacted`. */
export async function buildRemoteStatus(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  const r = await run(
    config.bridgePath,
    "get_remote_status",
    { remote_url: config.remoteUrl },
    { validate: parseRemoteStatus },
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** scan_before_push: the secret-scan gate (D4 — the UI runs this first and only
 *  pushes after the user reviews). Write-locked (reads `.git` refs). */
export async function buildScanBeforePush(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "scan_before_push", { path: config.libraryPath }, { validate: parseScanFindings, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** count_unpushed_commits: the "Push N" badge. Write-locked (shares ref state). */
export async function buildUnpushedCount(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "count_unpushed_commits", { path: config.libraryPath }, { validate: parseUnpushedCount, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** push_now: the egress. Write-locked + NETWORK_TIMEOUT. Injects the library
 *  path + the dashboard-owned askpass dir; the bridge reads the PAT from the
 *  keychain. Refuses early when no library OR no remote is configured (a clean
 *  precondition over a raw git "no origin" failure). NOTE: this does NOT wire the
 *  git `origin` remote — like the reference, `origin` must already exist in the
 *  repo; configure_remote only persists the URL for display + this precondition. */
export async function buildPush(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  if (!config.remoteUrl) return errorResult(REMOTE_NOT_CONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "push_now", { path: config.libraryPath, askpass_dir: config.askpassDir }, { timeoutMs: NETWORK_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** pull_now: `git pull --rebase`. Write-locked + NETWORK_TIMEOUT. A rebase
 *  conflict rides 200 as `{outcome:"conflict", conflict_count}` data (D7); a
 *  timeout/other failure is an error. */
export async function buildPull(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  if (!config.remoteUrl) return errorResult(REMOTE_NOT_CONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "pull_now", { path: config.libraryPath, askpass_dir: config.askpassDir }, { validate: parsePullResult, timeoutMs: NETWORK_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** is_pull_paused: the conflict-banner gate. Write-locked (reads `.git`). */
export async function buildIsPullPaused(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "is_pull_paused", { path: config.libraryPath }, { validate: parsePullPaused, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** list_pull_conflicts: classified conflict paths for the resolver. Write-locked. */
export async function buildListConflicts(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "list_pull_conflicts", { path: config.libraryPath }, { validate: parseConflictList, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** read_conflict_blob: one side of a conflicted file as text (`content` null if
 *  the side has no entry). `conflictPath`/`side` are query params (the path can
 *  contain `/`). Write-locked. */
export async function buildReadConflictBlob(
  config: LibraryConfig,
  conflictPath: string,
  side: string,
  run: Run = runBridge,
): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(
      config.bridgePath,
      "read_conflict_blob",
      { path: config.libraryPath, conflict_path: conflictPath, side },
      { validate: parseConflictBlob, timeoutMs: WRITE_TIMEOUT_MS },
    ),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** resolve_conflict: stage the chosen side. Body `{path, side}` (UI-facing
 *  `path` = the conflict path, injected as `conflict_path`). Write-locked. */
export async function buildResolveConflict(config: LibraryConfig, body: GitBody, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(
      config.bridgePath,
      "resolve_conflict",
      { path: config.libraryPath, conflict_path: gitStr(body.path), side: gitStr(body.side) },
      { timeoutMs: WRITE_TIMEOUT_MS },
    ),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

/** continue_pull: `git rebase --continue`. `{outcome:"done"}` or
 *  `{outcome:"still_conflicted", conflict_count}` (the resolver loops). Write-locked. */
export async function buildContinuePull(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "continue_pull", { path: config.libraryPath }, { validate: parseContinueResult, timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: r.data } : errorResult(r.error);
}

/** abort_pull: `git rebase --abort` — unwind to the pre-pull state. Write-locked. */
export async function buildAbortPull(config: LibraryConfig, run: Run = runBridge): Promise<LibraryRouteResult> {
  if (!config.libraryPath) return errorResult(UNCONFIGURED);
  const r = await withWriteLock(() =>
    run(config.bridgePath, "abort_pull", { path: config.libraryPath }, { timeoutMs: WRITE_TIMEOUT_MS }),
  );
  return r.ok ? { status: 200, body: {} } : errorResult(r.error);
}

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
  // Content search (read, no write lock). Distinct `/search` prefix — no
  // collision with `:kind/:name`. An absent `q` forwards `""` → bridge returns
  // `[]` (200), so the route never errors on a blank query.
  app.get("/api/library/search", async (c) => json(c, await buildSearch(loadConfig(), c.req.query("q") ?? "")));
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
  // Reimport-from-drift: pull a drifted install's on-disk bytes back into the
  // library as a new version. The third drift-row write (beside acknowledge +
  // reinstall), it takes the write lock (it re-baselines installs.json) and
  // WRITE_TIMEOUT in the handler. All ReimportResult variants ride 200 as data.
  app.post("/api/library/primitives/:kind/:name/reimport", async (c) =>
    json(c, await buildReimport(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
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
  // Primitive-lifecycle writes (structural CRUD). create is collection-level
  // (`POST …/primitives`, body {kind,name}); delete is the bare-resource DELETE
  // (distinct from `…/install` uninstall, `…/working-files` — different suffix,
  // no collision); rename/duplicate/forget are POST sub-actions (matching the
  // working-file `…/rename` precedent — a POST verb, not a PATCH on the
  // resource); import is collection-level (`POST …/import-from-path`, mirrors
  // import-installs). The write-lock + commit posture lives in each handler
  // (create/duplicate unlocked = publish posture; delete/rename/import/forget
  // locked = installs.json writers). Each inherits server.ts's loopback Host +
  // Origin guard. Mounted AFTER the more specific `…/:kind/:name/<suffix>` routes
  // so the bare DELETE doesn't shadow them.
  app.post("/api/library/primitives", async (c) => json(c, await buildCreatePrimitive(loadConfig(), await readJson(c))));
  app.post("/api/library/import-from-path", async (c) =>
    json(c, await buildImportFromPath(loadConfig(), await readJson(c))),
  );
  app.delete("/api/library/primitives/:kind/:name", async (c) =>
    json(c, await buildDeletePrimitive(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  app.post("/api/library/primitives/:kind/:name/rename", async (c) =>
    json(c, await buildRenamePrimitive(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/duplicate", async (c) =>
    json(c, await buildDuplicatePrimitive(loadConfig(), c.req.param("kind"), c.req.param("name"), await readJson(c))),
  );
  app.post("/api/library/primitives/:kind/:name/forget", async (c) =>
    json(c, await buildForgetPrimitive(loadConfig(), c.req.param("kind"), c.req.param("name"))),
  );
  // Bootstrap discovery wizard (the first-run scan→import flow). scan + session
  // read are GETs (no write lock); execute + session clear are writes (execute
  // mutates installs.json; clear serializes against it). Grouped under the
  // distinct `/bootstrap` prefix — no `:kind/:name` collision (the isolation
  // /search got). Each inherits server.ts's loopback Host + Origin guard.
  app.get("/api/library/bootstrap/scan", async (c) => json(c, await buildBootstrapScan(loadConfig())));
  app.get("/api/library/bootstrap/session", async (c) => json(c, await buildReadBootstrapSession(loadConfig())));
  app.post("/api/library/bootstrap/execute", async (c) =>
    json(c, await buildBootstrapExecute(loadConfig(), await readJson(c))),
  );
  app.delete("/api/library/bootstrap/session", async (c) => json(c, await buildClearBootstrapSession(loadConfig())));
  // Git remote sync (Slice 8) — grouped under the distinct `/git` prefix (no
  // `:kind/:name` collision). push/pull are the ONLY routes in the app that
  // egress; the PAT enters ONLY via PUT /git/pat's body (then straight to the
  // keychain, never logged) and leaves ONLY as `pat_redacted` from GET /git/status.
  // Each inherits server.ts's loopback Host + Origin guard; the write lock +
  // NETWORK_TIMEOUT live in the handlers (D5). Bodies/args are built field-by-
  // field — `secret_store` is NEVER forwarded from a body, so a request can't
  // downgrade the production bridge off the keychain (security review, D6).
  app.post("/api/library/git/remote", async (c) => json(c, await buildConfigureRemote(loadConfig(), await readJson(c))));
  app.put("/api/library/git/pat", async (c) => json(c, await buildSetPat(loadConfig(), await readJson(c))));
  app.delete("/api/library/git/pat", async (c) => json(c, await buildDeletePat(loadConfig())));
  app.get("/api/library/git/status", async (c) => json(c, await buildRemoteStatus(loadConfig())));
  app.get("/api/library/git/scan-before-push", async (c) => json(c, await buildScanBeforePush(loadConfig())));
  app.get("/api/library/git/unpushed-count", async (c) => json(c, await buildUnpushedCount(loadConfig())));
  app.post("/api/library/git/push", async (c) => json(c, await buildPush(loadConfig())));
  app.post("/api/library/git/pull", async (c) => json(c, await buildPull(loadConfig())));
  app.get("/api/library/git/paused", async (c) => json(c, await buildIsPullPaused(loadConfig())));
  app.get("/api/library/git/conflicts", async (c) => json(c, await buildListConflicts(loadConfig())));
  // The conflict path can contain `/`, so it rides `?path=` (like working-files
  // content), and the side rides `?side=local|remote`.
  app.get("/api/library/git/conflicts/blob", async (c) =>
    json(c, await buildReadConflictBlob(loadConfig(), c.req.query("path") ?? "", c.req.query("side") ?? "")),
  );
  app.post("/api/library/git/conflicts/resolve", async (c) =>
    json(c, await buildResolveConflict(loadConfig(), await readJson(c))),
  );
  app.post("/api/library/git/pull/continue", async (c) => json(c, await buildContinuePull(loadConfig())));
  app.post("/api/library/git/pull/abort", async (c) => json(c, await buildAbortPull(loadConfig())));
}
