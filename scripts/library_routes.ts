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
  type LibraryStatus,
} from "./library_models.ts";

type Run = typeof runBridge;
type HttpStatus = 200 | 404 | 409 | 422 | 502;

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
      return 409;
    // Bad client input (the :kind / :name segment, or a non-UTF-8 path).
    case "library_invalid_name":
    case "library_invalid_kind":
    case "library_invalid_version":
    case "library_invalid_path_encoding":
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
  if (!r.ok) return errorResult(r.error);
  return { status: 200, body: { configured: true, ...r.data } };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLibraryRoutes(app: Hono): void {
  // Config is resolved per-request so editing config/library.yaml (or the env
  // override) takes effect without a server restart — cheap (one small YAML read).
  app.get("/api/library/status", async (c) => {
    const { status, body } = await buildLibraryStatus(loadLibraryConfig());
    return c.json(body as object, status as ContentfulStatusCode);
  });
  app.get("/api/library/kind-info", async (c) => {
    const { status, body } = await buildKindInfo(loadLibraryConfig());
    return c.json(body as object, status as ContentfulStatusCode);
  });
  app.get("/api/library/target-info", async (c) => {
    const { status, body } = await buildTargetInfo(loadLibraryConfig());
    return c.json(body as object, status as ContentfulStatusCode);
  });
  app.get("/api/library/primitives", async (c) => {
    const { status, body } = await buildLibraryPrimitives(loadLibraryConfig());
    return c.json(body as object, status as ContentfulStatusCode);
  });
  app.get("/api/library/primitives/:kind/:name", async (c) => {
    const { status, body } = await buildPrimitiveDetail(
      loadLibraryConfig(),
      c.req.param("kind"),
      c.req.param("name"),
    );
    return c.json(body as object, status as ContentfulStatusCode);
  });
}
