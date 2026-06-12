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
      return 422;
    case "primitive_not_found":
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
  // (the handlers default targets/force/target), never a 500.
  const readJson = async (c: any): Promise<WriteBody> => {
    try {
      return ((await c.req.json()) as WriteBody) ?? {};
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
}
