import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  buildLibraryStatus,
  buildKindInfo,
  buildTargetInfo,
  buildLibraryPrimitives,
  buildPrimitiveDetail,
  statusForCode,
  registerLibraryRoutes,
} from "./library_routes.ts";
import type { runBridge, LibraryError } from "./library_bridge.ts";
import type { LibraryConfig } from "./library_config.ts";

const FIX = join(import.meta.dir, "fixtures", "bridge");
const data = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")).data;

const CONFIGURED: LibraryConfig = { libraryPath: "/libs/x", bridgePath: "/bin/bridge" };
const UNCONFIGURED: LibraryConfig = { libraryPath: null, bridgePath: "/bin/bridge" };

// Stubs standing in for runBridge — the route logic is tested with NO subprocess.
const okRun = (d: unknown): typeof runBridge => (async () => ({ ok: true, data: d })) as any;
const errRun = (error: LibraryError): typeof runBridge =>
  (async () => ({ ok: false, error })) as any;
const libErr = (code: string): LibraryError => ({ code, message: `msg:${code}`, detail: "/Users/secret/path" });

describe("statusForCode — LibraryError → HTTP", () => {
  test("config/marker/path problems are 409", () => {
    for (const c of ["library_unconfigured", "library_marker_missing", "library_invalid_path"])
      expect(statusForCode(c)).toBe(409);
  });
  test("bad client input is 422", () => {
    for (const c of ["library_invalid_name", "library_invalid_kind", "library_invalid_path_encoding"])
      expect(statusForCode(c)).toBe(422);
  });
  test("a missing primitive is 404", () => {
    expect(statusForCode("primitive_not_found")).toBe(404);
  });
  test("bridge/transport + parse failures are 502", () => {
    for (const c of ["bridge_not_found", "bridge_timeout", "bridge_bad_output", "library_unreadable", "library_parse_error"])
      expect(statusForCode(c)).toBe(502);
  });
  test("an unknown code defaults to 502", () => {
    expect(statusForCode("something_new")).toBe(502);
  });
});

describe("buildKindInfo / buildTargetInfo (capability tables, no path needed)", () => {
  test("kind-info returns 200 with the table", async () => {
    const r = await buildKindInfo(CONFIGURED, okRun(data("kind_info")));
    expect(r.status).toBe(200);
    expect((r.body as any).skill.primary_filename).toEqual({ kind: "fixed", value: "SKILL.md" });
  });
  test("target-info returns 200 with library Targets", async () => {
    const r = await buildTargetInfo(CONFIGURED, okRun(data("target_info")));
    expect(r.status).toBe(200);
    expect((r.body as any).targets).toHaveLength(3);
  });
  test("a bridge failure surfaces as 502 with only {code,message} (detail withheld, m4)", async () => {
    const r = await buildKindInfo(CONFIGURED, errRun(libErr("bridge_not_found")));
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ code: "bridge_not_found", message: "msg:bridge_not_found" });
    // m4: the path-bearing detail must NEVER reach the client body
    expect(JSON.stringify(r.body)).not.toContain("/Users/");
  });
});

describe("buildLibraryPrimitives", () => {
  test("unconfigured → 409 library_unconfigured WITHOUT calling the bridge", async () => {
    let called = false;
    const spy: typeof runBridge = (async () => {
      called = true;
      return { ok: true, data: [] };
    }) as any;
    const r = await buildLibraryPrimitives(UNCONFIGURED, spy);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(called).toBe(false);
  });
  test("configured → 200 with the summary array", async () => {
    const r = await buildLibraryPrimitives(CONFIGURED, okRun(data("list_primitives")));
    expect(r.status).toBe(200);
    expect(r.body as any[]).toHaveLength(4);
  });
  test("a marker-missing error maps to 409", async () => {
    const r = await buildLibraryPrimitives(CONFIGURED, errRun(libErr("library_marker_missing")));
    expect(r.status).toBe(409);
  });
});

describe("buildPrimitiveDetail", () => {
  test("configured → 200 detail", async () => {
    const r = await buildPrimitiveDetail(CONFIGURED, "skill", "diagnose", okRun(data("primitive_detail_skill")));
    expect(r.status).toBe(200);
    expect((r.body as any).working.kind).toBe("md");
  });
  test("a missing primitive → 404", async () => {
    const r = await buildPrimitiveDetail(CONFIGURED, "skill", "nope", errRun(libErr("primitive_not_found")));
    expect(r.status).toBe(404);
  });
  test("a traversal name (invalid name) → 422", async () => {
    const r = await buildPrimitiveDetail(CONFIGURED, "skill", "../etc", errRun(libErr("library_invalid_name")));
    expect(r.status).toBe(422);
  });
  test("unconfigured → 409 without calling the bridge", async () => {
    const r = await buildPrimitiveDetail(UNCONFIGURED, "skill", "diagnose", errRun(libErr("should_not_run")));
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
  });
});

describe("buildLibraryStatus (informational — never errors on a bad path)", () => {
  test("unconfigured → 200 configured:false WITHOUT calling the bridge", async () => {
    let called = false;
    const spy: typeof runBridge = (async () => {
      called = true;
      return { ok: true, data: {} };
    }) as any;
    const r = await buildLibraryStatus(UNCONFIGURED, spy);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, is_valid: false });
    expect(called).toBe(false);
  });
  test("configured → 200 configured:true + the status fields", async () => {
    const r = await buildLibraryStatus(CONFIGURED, okRun(data("library_status_valid")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, is_valid: true, marker_exists: true });
  });
  test("a bridge transport fault is reported as data (200 + unavailable), never a 502", async () => {
    // The UI gates on status; a 502 here collapses to a generic "couldn't load".
    // Reporting the fault as data lets the UI render an actionable message.
    const r = await buildLibraryStatus(CONFIGURED, errRun(libErr("bridge_not_found")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, is_valid: false });
    expect((r.body as any).unavailable).toMatchObject({ code: "bridge_not_found", message: "msg:bridge_not_found" });
    // m4: the path-bearing detail still never reaches the client
    expect(JSON.stringify(r.body)).not.toContain("/Users/");
  });
});

// Route-local isolation: library routes mounted on a Hono app must not affect a
// sibling Observability route, even with no library configured.
describe("registerLibraryRoutes — HTTP wiring + Observability isolation", () => {
  test("library routes are additive; an unconfigured library leaves siblings 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true })); // stand-in Observability route
    // Inject an unconfigured config so the test is deterministic — independent of
    // the machine's actual config/library.yaml (env override, a local edit, etc).
    registerLibraryRoutes(app, () => UNCONFIGURED);

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // unaffected by the library being unconfigured

    const status = await app.request("/api/library/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ configured: false });

    const primitives = await app.request("/api/library/primitives");
    expect(primitives.status).toBe(409); // library-local error, not a 500
  });
});
