import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  buildLibraryStatus,
  buildKindInfo,
  buildTargetInfo,
  buildLibraryPrimitives,
  buildSearch,
  buildPrimitiveDetail,
  buildInstall,
  buildUninstall,
  buildAcknowledgeDrift,
  buildReimport,
  buildInstallsForPrimitive,
  buildDriftBatch,
  buildScanDrift,
  buildImportInstalls,
  buildListWorkingFiles,
  buildReadWorkingFile,
  buildSaveWorking,
  buildCreateWorkingFile,
  buildSaveWorkingFile,
  buildRenameWorkingFile,
  buildDeleteWorkingFile,
  buildPublish,
  buildSetCurrentVersion,
  buildReadPrimitiveVersion,
  buildRevertToVersion,
  buildReadPrimitiveTarget,
  buildWriteOverlay,
  buildRemoveOverlay,
  buildListOverlays,
  buildUpdateMetadata,
  buildCreatePrimitive,
  buildDeletePrimitive,
  buildRenamePrimitive,
  buildDuplicatePrimitive,
  buildImportFromPath,
  buildForgetPrimitive,
  buildBootstrapScan,
  buildBootstrapExecute,
  buildReadBootstrapSession,
  buildClearBootstrapSession,
  withWriteLock,
  statusForCode,
  registerLibraryRoutes,
} from "./library_routes.ts";
import type { runBridge, LibraryError, BridgeResult } from "./library_bridge.ts";
import type { LibraryConfig } from "./library_config.ts";

const FIX = join(import.meta.dir, "fixtures", "bridge");
const data = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")).data;

const CONFIGURED: LibraryConfig = {
  libraryPath: "/libs/x",
  bridgePath: "/bin/bridge",
  installsPath: "/data/installs.json",
  home: "/home/test",
  sessionPath: "/data/bootstrap-session.json",
  backupDir: "/data/backups",
  remoteUrl: null,
  askpassDir: "/data/askpass",
};
const UNCONFIGURED: LibraryConfig = {
  libraryPath: null,
  bridgePath: "/bin/bridge",
  installsPath: "/data/installs.json",
  home: "/home/test",
  sessionPath: "/data/bootstrap-session.json",
  backupDir: "/data/backups",
  remoteUrl: null,
  askpassDir: "/data/askpass",
};

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

describe("buildSearch (content search — read, no write lock)", () => {
  test("unconfigured → library_unconfigured WITHOUT calling the bridge", async () => {
    let called = false;
    const spy: typeof runBridge = (async () => {
      called = true;
      return { ok: true, data: [] };
    }) as any;
    const r = await buildSearch(UNCONFIGURED, "needle", spy);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(called).toBe(false);
  });
  test("configured → 200 with the parsed SearchResult array", async () => {
    const hits = [{ kind: "skill", name: "diagnose", line_number: 4, line_text: "needle here" }];
    const r = await buildSearch(CONFIGURED, "needle", okRun(hits));
    expect(r.status).toBe(200);
    expect(r.body as any[]).toHaveLength(1);
    expect((r.body as any)[0]).toEqual(hits[0]);
  });
  test("an empty result set → 200 with []", async () => {
    const r = await buildSearch(CONFIGURED, "", okRun([]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  test("a bridge read fault maps to 502 with only {code,message} (detail withheld, m4)", async () => {
    const r = await buildSearch(CONFIGURED, "needle", errRun(libErr("library_unreadable")));
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ code: "library_unreadable", message: "msg:library_unreadable" });
    expect(JSON.stringify(r.body)).not.toContain("/Users/");
  });
  test("the query is threaded to the bridge as args.query", async () => {
    let seen: Record<string, unknown> | undefined;
    const spy: typeof runBridge = (async (_bridge: string, _cmd: string, args: Record<string, unknown>) => {
      seen = args;
      return { ok: true, data: [] };
    }) as any;
    await buildSearch(CONFIGURED, "find me", spy);
    expect(seen).toEqual({ path: "/libs/x", query: "find me" });
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

// ---------------------------------------------------------------------------
// Write routes (install-drift slice)
// ---------------------------------------------------------------------------

// A run stub that records every (bridgePath, command, args) it is called with,
// so the args-derivation (config-resolved, NOT body-derived — D7) is asserted.
function captureRun(result: BridgeResult<unknown>): {
  run: typeof runBridge;
  calls: { bridgePath: string; command: string; args: Record<string, unknown> }[];
} {
  const calls: { bridgePath: string; command: string; args: Record<string, unknown> }[] = [];
  const run = (async (bridgePath: string, command: string, args: Record<string, unknown>) => {
    calls.push({ bridgePath, command, args });
    return result;
  }) as unknown as typeof runBridge;
  return { run, calls };
}

// Inline outcomes the committed fixtures don't cover (collision / drift).
const COLLIDING_INSTALL = {
  successes: [
    { target: "claude", outcome: { kind: "colliding_content", version: "v1", conflicts: ["SKILL.md"] } },
  ],
  failures: [],
};
const DRIFTED_UNINSTALL = {
  successes: [{ target: "claude", outcome: { kind: "drifted", conflicts: ["SKILL.md"] } }],
  failures: [],
};

describe("statusForCode — write/migration codes", () => {
  test("install/drift/migration precondition faults are 409", () => {
    for (const c of [
      "installs_unconfigured",
      "installs_already_present",
      "installs_destination_corrupt",
      "drift_no_install_record",
      "library_no_current_version",
    ])
      expect(statusForCode(c)).toBe(409);
  });
  test("unprocessable migration/install inputs are 422", () => {
    for (const c of [
      "installs_format_mismatch",
      "installs_source_corrupt",
      "library_target_not_allowed",
      "library_target_not_allowed_for_kind",
      "library_install_not_supported",
    ])
      expect(statusForCode(c)).toBe(422);
  });
});

describe("buildInstall", () => {
  test("a clean install returns 200 with the InstallSummary", async () => {
    const r = await buildInstall(CONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, okRun(data("install_summary")));
    expect(r.status).toBe(200);
    expect((r.body as any).successes[0].outcome.kind).toBe("installed");
  });

  test("a colliding_content outcome is a NORMAL 200 result (the dialog trigger), not an error", async () => {
    const r = await buildInstall(CONFIGURED, "skill", "deploy-prod", { targets: ["claude"], force: false }, okRun(COLLIDING_INSTALL));
    expect(r.status).toBe(200);
    expect((r.body as any).successes[0].outcome.kind).toBe("colliding_content");
  });

  test("unconfigured library → 409 WITHOUT spawning the bridge (install needs the layout)", async () => {
    const { run, calls } = captureRun({ ok: true, data: data("install_summary") });
    const r = await buildInstall(UNCONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, run);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(calls).toHaveLength(0);
  });

  test("D7 tripwire: install destination is CONFIG-resolved; a body's home/installs_path is ignored", async () => {
    const { run, calls } = captureRun({ ok: true, data: data("install_summary") });
    // A hostile body trying to redirect the write root.
    const body = {
      targets: ["claude"],
      force: false,
      home: "/etc",
      installs_path: "/etc/installs.json",
      installsPath: "/etc/installs.json",
      path: "/etc",
    } as any;
    await buildInstall(CONFIGURED, "skill", "diagnose", body, run, "2026-06-11T00:00:00Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.home).toBe("/home/test"); // config, not "/etc"
    expect(calls[0]!.args.installs_path).toBe("/data/installs.json"); // config, not "/etc/..."
    expect(calls[0]!.args.path).toBe("/libs/x"); // config libraryPath, not body
    expect(calls[0]!.args.installed_at).toBe("2026-06-11T00:00:00Z"); // server-supplied clock
    expect(calls[0]!.args.kind).toBe("skill");
    expect(calls[0]!.args.targets).toEqual(["claude"]);
  });

  test("the installed_at clock defaults to a valid RFC3339 timestamp", async () => {
    const { run, calls } = captureRun({ ok: true, data: data("install_summary") });
    await buildInstall(CONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, run);
    expect(calls[0]!.args.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("a pre-flight failure (e.g. no current version) maps to its status", async () => {
    const r = await buildInstall(CONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, errRun(libErr("library_no_current_version")));
    expect(r.status).toBe(409);
  });
});

describe("buildUninstall", () => {
  test("a clean uninstall returns 200 with the UninstallSummary", async () => {
    const r = await buildUninstall(CONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, okRun(data("uninstall_summary")));
    expect(r.status).toBe(200);
    expect((r.body as any).successes[0].outcome.kind).toBe("removed");
  });

  test("a drifted outcome is a NORMAL 200 result (prompt-then-force), not an error", async () => {
    const r = await buildUninstall(CONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, okRun(DRIFTED_UNINSTALL));
    expect(r.status).toBe(200);
    expect((r.body as any).successes[0].outcome.kind).toBe("drifted");
  });

  test("uninstall does not require the library layout — works while unconfigured", async () => {
    // It writes off installs.json + the install root only; no `path` needed.
    const { run, calls } = captureRun({ ok: true, data: data("uninstall_summary") });
    const r = await buildUninstall(UNCONFIGURED, "skill", "diagnose", { targets: ["claude"], force: false }, run);
    expect(r.status).toBe(200);
    expect(calls[0]!.args.installs_path).toBe("/data/installs.json");
    expect(calls[0]!.args.home).toBe("/home/test");
  });
});

describe("buildAcknowledgeDrift", () => {
  test("success returns 200 with an empty body", async () => {
    const r = await buildAcknowledgeDrift(CONFIGURED, "skill", "diagnose", { target: "claude" }, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  test("no install record → 409", async () => {
    const r = await buildAcknowledgeDrift(CONFIGURED, "skill", "diagnose", { target: "claude" }, errRun(libErr("drift_no_install_record")));
    expect(r.status).toBe(409);
  });

  test("the acknowledged (kind,name,target) reach the bridge from the route, not config", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildAcknowledgeDrift(CONFIGURED, "agent", "reviewer", { target: "pi" }, run);
    expect(calls[0]!.command).toBe("acknowledge_drift");
    expect(calls[0]!.args).toMatchObject({ kind: "agent", name: "reviewer", target: "pi", installs_path: "/data/installs.json" });
  });
});

describe("buildInstallsForPrimitive (read — no write lock)", () => {
  test("returns 200 with the InstalledTarget projection", async () => {
    const r = await buildInstallsForPrimitive(CONFIGURED, "skill", "diagnose", okRun(data("list_installs")));
    expect(r.status).toBe(200);
    expect((r.body as any)[0]).toMatchObject({ target: "claude", installed_version: "v1" });
  });

  test("an empty ledger returns 200 [] (first-launch parity)", async () => {
    const r = await buildInstallsForPrimitive(CONFIGURED, "skill", "diagnose", okRun([]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe("buildDriftBatch (read — no write lock)", () => {
  test("returns 200 with the DriftReport[] that feeds badges + detail", async () => {
    const r = await buildDriftBatch(CONFIGURED, okRun(data("scan_drift")));
    expect(r.status).toBe(200);
    expect((r.body as any)[0]).toMatchObject({ kind: "skill", name: "diagnose", target: "claude" });
  });

  test("a bridge fault surfaces as 502 (detail withheld)", async () => {
    const r = await buildDriftBatch(CONFIGURED, errRun(libErr("bridge_not_found")));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("/Users/");
  });
});

describe("buildScanDrift (per-primitive — detail authority, D8)", () => {
  test("returns 200 with the scoped DriftReport[] and passes kind/name to the bridge", async () => {
    const { run, calls } = captureRun({ ok: true, data: data("scan_drift") });
    const r = await buildScanDrift(CONFIGURED, "skill", "diagnose", run);
    expect(r.status).toBe(200);
    expect(calls[0]!.command).toBe("scan_drift");
    expect(calls[0]!.args).toMatchObject({ kind: "skill", name: "diagnose", installs_path: "/data/installs.json" });
  });
});

describe("buildImportInstalls (migration)", () => {
  test("success returns 200 { imported }", async () => {
    const { run } = captureRun({ ok: true, data: { imported: 119 } });
    const r = await buildImportInstalls(CONFIGURED, run);
    expect(r.status).toBe(200);
    expect((r.body as any).imported).toBe(119);
  });

  test("an already-present destination → 409", async () => {
    const r = await buildImportInstalls(CONFIGURED, errRun(libErr("installs_already_present")));
    expect(r.status).toBe(409);
  });

  test("a format-version mismatch → 422", async () => {
    const r = await buildImportInstalls(CONFIGURED, errRun(libErr("installs_format_mismatch")));
    expect(r.status).toBe(422);
  });
});

describe("withWriteLock (D1 — serialize all ledger writers)", () => {
  test("two overlapping writers run strictly one-at-a-time, never interleaved", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const work = (label: string) =>
      withWriteLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${label}:start`);
        await new Promise((res) => setTimeout(res, 5));
        order.push(`${label}:end`);
        active -= 1;
        return label;
      });
    // Dispatch concurrently — the lock must serialize them.
    const [a, b] = await Promise.all([work("A"), work("B")]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(maxActive).toBe(1); // never two writers in flight at once
    // Each writer fully completes before the next starts (no interleave).
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test("a rejecting writer does not wedge the queue — the next writer still runs", async () => {
    const ran: string[] = [];
    let threw = false;
    try {
      await withWriteLock(async () => {
        ran.push("fail");
        throw new Error("boom");
      });
    } catch (e) {
      threw = (e as Error).message === "boom";
    }
    expect(threw).toBe(true);
    const after = await withWriteLock(async () => {
      ran.push("after");
      return "ok";
    });
    expect(after).toBe("ok");
    expect(ran).toEqual(["fail", "after"]);
  });
});

// ---------------------------------------------------------------------------
// Working-file (editor) routes (working-copy slice)
// ---------------------------------------------------------------------------

describe("statusForCode — working-file codes", () => {
  test("editor conflicts (exists / refuse-primary) are 409", () => {
    for (const c of ["working_file_exists", "working_file_refuse_primary"])
      expect(statusForCode(c)).toBe(409);
  });
  test("invalid working path + too-many are 422", () => {
    for (const c of ["library_invalid_working_path", "working_file_too_many"])
      expect(statusForCode(c)).toBe(422);
  });
  test("a missing working file is 404", () => {
    expect(statusForCode("working_file_not_found")).toBe(404);
  });
});

describe("buildListWorkingFiles (read — no write lock)", () => {
  test("configured → 200 with primary-first entries", async () => {
    const r = await buildListWorkingFiles(CONFIGURED, "skill", "diagnose", okRun(data("list_working_files")));
    expect(r.status).toBe(200);
    expect((r.body as any)[0]).toMatchObject({ path: "SKILL.md", role: "primary" });
  });
  test("unconfigured → 409 WITHOUT spawning (needs the layout)", async () => {
    const { run, calls } = captureRun({ ok: true, data: [] });
    const r = await buildListWorkingFiles(UNCONFIGURED, "skill", "diagnose", run);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(calls).toHaveLength(0);
  });
});

describe("buildReadWorkingFile", () => {
  test("text → 200 tagged text bytes", async () => {
    const r = await buildReadWorkingFile(CONFIGURED, "skill", "diagnose", "notes.md", okRun(data("read_working_file_text")));
    expect(r.status).toBe(200);
    expect((r.body as any).kind).toBe("text");
  });
  test("binary → 200 size-only (no bytes)", async () => {
    const r = await buildReadWorkingFile(CONFIGURED, "skill", "diagnose", "logo.bin", okRun(data("read_working_file_binary")));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: "binary", size: 4 });
  });
  test("the ref path reaches the bridge as `rel`; the root stays config `path`", async () => {
    const { run, calls } = captureRun({ ok: true, data: data("read_working_file_text") });
    await buildReadWorkingFile(CONFIGURED, "skill", "diagnose", "notes/intro.md", run);
    expect(calls[0]!.command).toBe("read_working_file");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", rel: "notes/intro.md" });
  });
  test("traversal tripwire (risk-a, route half): a ../ path maps library_invalid_working_path → 422", async () => {
    const r = await buildReadWorkingFile(
      CONFIGURED,
      "skill",
      "diagnose",
      "../../etc/passwd",
      errRun(libErr("library_invalid_working_path")),
    );
    expect(r.status).toBe(422);
    expect((r.body as any).code).toBe("library_invalid_working_path");
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    const r = await buildReadWorkingFile(UNCONFIGURED, "skill", "diagnose", "notes.md", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildSaveWorking (primary save)", () => {
  test("success → 200 {}", async () => {
    const r = await buildSaveWorking(CONFIGURED, "skill", "diagnose", { content: "---\n---\nbody\n" }, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("a malformed primary → library_parse_error → 502 (in-core: disk untouched)", async () => {
    const r = await buildSaveWorking(CONFIGURED, "skill", "diagnose", { content: "no fences" }, errRun(libErr("library_parse_error")));
    expect(r.status).toBe(502);
    expect((r.body as any).code).toBe("library_parse_error");
  });
  test("content + config root reach the bridge; a body path cannot redirect the root", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildSaveWorking(CONFIGURED, "skill", "diagnose", { content: "x", path: "/etc/evil" } as any, run);
    expect(calls[0]!.command).toBe("save_working");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", content: "x" });
    expect(calls[0]!.args.rel).toBeUndefined(); // a primary save carries no ref path
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    const r = await buildSaveWorking(UNCONFIGURED, "skill", "diagnose", { content: "x" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildCreateWorkingFile", () => {
  test("success → 200 {}", async () => {
    const r = await buildCreateWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md", content: "x" }, okRun({}));
    expect(r.status).toBe(200);
  });
  test("create over an existing ref → 409 working_file_exists", async () => {
    const r = await buildCreateWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md", content: "x" }, errRun(libErr("working_file_exists")));
    expect(r.status).toBe(409);
  });
  test("traversal tripwire: path ../escape.md → 422 library_invalid_working_path", async () => {
    const r = await buildCreateWorkingFile(CONFIGURED, "skill", "diagnose", { path: "../escape.md", content: "x" }, errRun(libErr("library_invalid_working_path")));
    expect(r.status).toBe(422);
  });
  test("body.path → bridge `rel`, content forwarded, root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildCreateWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md", content: "x" }, run);
    expect(calls[0]!.command).toBe("create_working_file");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", rel: "notes.md", content: "x" });
  });
});

describe("buildSaveWorkingFile", () => {
  test("save a missing ref → 404 working_file_not_found (use Create)", async () => {
    const r = await buildSaveWorkingFile(CONFIGURED, "skill", "diagnose", { path: "absent.md", content: "x" }, errRun(libErr("working_file_not_found")));
    expect(r.status).toBe(404);
  });
  test("success forwards rel + content", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildSaveWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md", content: "v2" }, run);
    expect(calls[0]!.command).toBe("save_working_file");
    expect(calls[0]!.args).toMatchObject({ rel: "notes.md", content: "v2" });
  });
});

describe("buildRenameWorkingFile", () => {
  test("rename the primary → 409 working_file_refuse_primary", async () => {
    const r = await buildRenameWorkingFile(CONFIGURED, "skill", "diagnose", { old_path: "SKILL.md", new_path: "x.md" }, errRun(libErr("working_file_refuse_primary")));
    expect(r.status).toBe(409);
  });
  test("forwards old_rel/new_rel", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildRenameWorkingFile(CONFIGURED, "skill", "diagnose", { old_path: "a.md", new_path: "docs/a.md" }, run);
    expect(calls[0]!.command).toBe("rename_working_file");
    expect(calls[0]!.args).toMatchObject({ old_rel: "a.md", new_rel: "docs/a.md" });
  });
});

describe("buildDeleteWorkingFile", () => {
  test("success → 200 {} (idempotent in-core)", async () => {
    const r = await buildDeleteWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md" }, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("delete the primary → 409 working_file_refuse_primary", async () => {
    const r = await buildDeleteWorkingFile(CONFIGURED, "skill", "diagnose", { path: "SKILL.md" }, errRun(libErr("working_file_refuse_primary")));
    expect(r.status).toBe(409);
  });
  test("forwards rel; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildDeleteWorkingFile(CONFIGURED, "skill", "diagnose", { path: "notes.md" }, run);
    expect(calls[0]!.command).toBe("delete_working_file");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", rel: "notes.md" });
  });
});

// ---------------------------------------------------------------------------
// Versioning / publishing (versioning slice)
//
// Inline result shapes (no committed fixtures): publish/set-current return a
// PublishResult; a commit failure is DATA at 200, not an error. read returns a
// PrimitiveVersionView. The load-bearing checks: the commit failure rides 200
// (Decision 1+3), the version write root is config-resolved (never body), the
// label flows to the bridge as `version_label`, and publish server-stamps
// `created_at` (the body cannot set it).
// ---------------------------------------------------------------------------

const PUBLISH_OK = { committed: true, commit_error: null };
const PUBLISH_NO_COMMIT = { committed: false, commit_error: null }; // non-git / nothing staged
const PUBLISH_COMMIT_FAILED = {
  committed: false,
  commit_error: "Author identity unknown\n\n*** Please tell me who you are.",
};
const VERSION_VIEW = {
  working: { kind: "md", frontmatter: "", body: "body-v1\n" },
  metadata: { created_at: "2026-04-30T12:00:00Z", notes: "first publish" },
};

describe("statusForCode — versioning codes", () => {
  test("re-publishing an existing label is a 409 immutability conflict", () => {
    expect(statusForCode("library_version_exists")).toBe(409);
  });
  test("a missing version (set-current/inspect/revert) is 404", () => {
    expect(statusForCode("library_version_not_found")).toBe(404);
  });
});

describe("buildPublish", () => {
  test("success → 200 with the PublishResult", async () => {
    const r = await buildPublish(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, okRun(PUBLISH_OK));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(PUBLISH_OK);
  });
  test("a commit failure is NON-fatal — 200 carrying committed:false + the message (Decision 1+3)", async () => {
    const r = await buildPublish(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, okRun(PUBLISH_COMMIT_FAILED));
    expect(r.status).toBe(200);
    expect((r.body as any).committed).toBe(false);
    expect((r.body as any).commit_error).toContain("identity unknown");
  });
  test("re-publishing an existing label → 409 library_version_exists", async () => {
    const r = await buildPublish(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, errRun(libErr("library_version_exists")));
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_version_exists");
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });
  test("forwards version_label + notes + a SERVER-stamped created_at; root stays config (body can't set it)", async () => {
    const { run, calls } = captureRun({ ok: true, data: PUBLISH_OK });
    await buildPublish(
      CONFIGURED,
      "skill",
      "diagnose",
      { version_label: "v2", notes: "release notes", path: "/etc/evil", created_at: "1999-01-01T00:00:00Z" } as any,
      run,
      "2026-06-12T00:00:00Z",
    );
    expect(calls[0]!.command).toBe("publish");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x", // config root, NOT the body's /etc/evil
      kind: "skill",
      name: "diagnose",
      version_label: "v2",
      notes: "release notes",
      created_at: "2026-06-12T00:00:00Z", // the injected `now`, NOT the body's 1999 value
    });
  });
  test("absent notes → null (not undefined) on the wire", async () => {
    const { run, calls } = captureRun({ ok: true, data: PUBLISH_NO_COMMIT });
    await buildPublish(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, run, "2026-06-12T00:00:00Z");
    expect(calls[0]!.args.notes).toBeNull();
  });
  test("unconfigured → 409 WITHOUT spawning (needs the layout to snapshot)", async () => {
    const { run, calls } = captureRun({ ok: true, data: PUBLISH_OK });
    const r = await buildPublish(UNCONFIGURED, "skill", "diagnose", { version_label: "v1" }, run);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(calls).toHaveLength(0);
  });
});

describe("buildSetCurrentVersion", () => {
  test("success → 200 with the commit result", async () => {
    const r = await buildSetCurrentVersion(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, okRun(PUBLISH_NO_COMMIT));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(PUBLISH_NO_COMMIT);
  });
  test("an unknown label → 404 library_version_not_found", async () => {
    const r = await buildSetCurrentVersion(CONFIGURED, "skill", "diagnose", { version_label: "v9" }, errRun(libErr("library_version_not_found")));
    expect(r.status).toBe(404);
  });
  test("forwards version_label; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: PUBLISH_NO_COMMIT });
    await buildSetCurrentVersion(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, run);
    expect(calls[0]!.command).toBe("set_current_version");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", version_label: "v1" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: PUBLISH_NO_COMMIT });
    const r = await buildSetCurrentVersion(UNCONFIGURED, "skill", "diagnose", { version_label: "v1" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildReadPrimitiveVersion (read — no write lock)", () => {
  test("success → 200 with the frozen view", async () => {
    const r = await buildReadPrimitiveVersion(CONFIGURED, "skill", "diagnose", "v1", okRun(VERSION_VIEW));
    expect(r.status).toBe(200);
    expect((r.body as any).working.body).toBe("body-v1\n");
    expect((r.body as any).metadata.created_at).toBe("2026-04-30T12:00:00Z");
  });
  test("an unknown label → 404 library_version_not_found", async () => {
    const r = await buildReadPrimitiveVersion(CONFIGURED, "skill", "diagnose", "v9", errRun(libErr("library_version_not_found")));
    expect(r.status).toBe(404);
  });
  test("the label reaches the bridge as version_label; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: VERSION_VIEW });
    await buildReadPrimitiveVersion(CONFIGURED, "skill", "diagnose", "v1", run);
    expect(calls[0]!.command).toBe("read_primitive_version");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", version_label: "v1" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: VERSION_VIEW });
    const r = await buildReadPrimitiveVersion(UNCONFIGURED, "skill", "diagnose", "v1", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildRevertToVersion", () => {
  test("success → 200 {} (a working-copy rewind, not a commit)", async () => {
    const r = await buildRevertToVersion(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("an unknown label → 404 library_version_not_found", async () => {
    const r = await buildRevertToVersion(CONFIGURED, "skill", "diagnose", { version_label: "v9" }, errRun(libErr("library_version_not_found")));
    expect(r.status).toBe(404);
  });
  test("forwards version_label; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildRevertToVersion(CONFIGURED, "skill", "diagnose", { version_label: "v1" }, run);
    expect(calls[0]!.command).toBe("revert_to_version");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", version_label: "v1" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    const r = await buildRevertToVersion(UNCONFIGURED, "skill", "diagnose", { version_label: "v1" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Target overlays (target-overlays slice)
//
// Reads (read-merged-view / list) skip the lock; writes (write/remove overlay)
// take WRITE_TIMEOUT but no ledger mutex. The load-bearing checks: the target
// rides a `:target` segment to the bridge as `target`, the root stays config-
// resolved (a body can't redirect it), a disallowed target maps 422, and a
// malformed overlay maps library_parse_error → 502 (consistent with the Slice 3
// primary save — disk untouched in-core).
// ---------------------------------------------------------------------------

const TARGET_VIEW_OVERLAY = { working: { kind: "md", frontmatter: "", body: "claude-only\n" }, has_overlay: true };
const TARGET_VIEW_BASE = { working: { kind: "md", frontmatter: "", body: "base\n" }, has_overlay: false };

describe("buildReadPrimitiveTarget (read — no write lock)", () => {
  test("success → 200 with the merged view (overlay present)", async () => {
    const r = await buildReadPrimitiveTarget(CONFIGURED, "skill", "diagnose", "claude", okRun(TARGET_VIEW_OVERLAY));
    expect(r.status).toBe(200);
    expect((r.body as any).has_overlay).toBe(true);
    expect((r.body as any).working.body).toBe("claude-only\n");
  });
  test("a base passthrough → 200 has_overlay:false", async () => {
    const r = await buildReadPrimitiveTarget(CONFIGURED, "skill", "diagnose", "pi", okRun(TARGET_VIEW_BASE));
    expect(r.status).toBe(200);
    expect((r.body as any).has_overlay).toBe(false);
  });
  test("a disallowed target → 422 library_target_not_allowed (detail withheld)", async () => {
    const r = await buildReadPrimitiveTarget(CONFIGURED, "skill", "diagnose", "codex", errRun(libErr("library_target_not_allowed")));
    expect(r.status).toBe(422);
    expect((r.body as any).code).toBe("library_target_not_allowed");
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });
  test("a bad :target value → 422 library_invalid_target", async () => {
    const r = await buildReadPrimitiveTarget(CONFIGURED, "skill", "diagnose", "nonsense", errRun(libErr("library_invalid_target")));
    expect(r.status).toBe(422);
  });
  test("the target reaches the bridge as `target`; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: TARGET_VIEW_BASE });
    await buildReadPrimitiveTarget(CONFIGURED, "skill", "diagnose", "claude", run);
    expect(calls[0]!.command).toBe("read_primitive_target");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", target: "claude" });
  });
  test("unconfigured → 409 WITHOUT spawning (needs the layout)", async () => {
    const { run, calls } = captureRun({ ok: true, data: TARGET_VIEW_BASE });
    const r = await buildReadPrimitiveTarget(UNCONFIGURED, "skill", "diagnose", "claude", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildWriteOverlay (primary overlay save)", () => {
  test("success → 200 {}", async () => {
    const r = await buildWriteOverlay(CONFIGURED, "skill", "diagnose", "claude", { content: "---\n---\nx\n" }, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("a malformed overlay → library_parse_error → 502 (in-core: disk untouched)", async () => {
    const r = await buildWriteOverlay(CONFIGURED, "skill", "diagnose", "claude", { content: "no fences" }, errRun(libErr("library_parse_error")));
    expect(r.status).toBe(502);
    expect((r.body as any).code).toBe("library_parse_error");
  });
  test("a disallowed target → 422 library_target_not_allowed", async () => {
    const r = await buildWriteOverlay(CONFIGURED, "skill", "diagnose", "codex", { content: "---\n---\nx\n" }, errRun(libErr("library_target_not_allowed")));
    expect(r.status).toBe(422);
  });
  test("content + target + config root reach the bridge; a body path cannot redirect the root", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildWriteOverlay(CONFIGURED, "skill", "diagnose", "claude", { content: "x", path: "/etc/evil" } as any, run);
    expect(calls[0]!.command).toBe("write_overlay");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", target: "claude", content: "x" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    const r = await buildWriteOverlay(UNCONFIGURED, "skill", "diagnose", "claude", { content: "x" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildRemoveOverlay (idempotent in-core)", () => {
  test("success → 200 {} (the merged view reverts to base)", async () => {
    const r = await buildRemoveOverlay(CONFIGURED, "skill", "diagnose", "claude", okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("forwards target; root stays config", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildRemoveOverlay(CONFIGURED, "skill", "diagnose", "claude", run);
    expect(calls[0]!.command).toBe("remove_overlay");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", target: "claude" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    const r = await buildRemoveOverlay(UNCONFIGURED, "skill", "diagnose", "claude", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildListOverlays (read — no write lock)", () => {
  test("success → 200 with the per-target overlay surface", async () => {
    const r = await buildListOverlays(CONFIGURED, "skill", "diagnose", okRun([{ target: "claude", paths: ["SKILL.md"] }]));
    expect(r.status).toBe(200);
    expect((r.body as any)[0]).toMatchObject({ target: "claude", paths: ["SKILL.md"] });
  });
  test("the empty surface → 200 []", async () => {
    const r = await buildListOverlays(CONFIGURED, "skill", "diagnose", okRun([]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: [] });
    const r = await buildListOverlays(UNCONFIGURED, "skill", "diagnose", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

const META_OK = {
  metadata: {
    allowed_targets: ["claude", "pi"],
    created_at: "2026-04-30T12:00:00Z",
    display_name: "Diag",
    author: "Alice",
  },
  committed: true,
  commit_error: null,
};
const META_COMMIT_FAILED = {
  metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z" },
  committed: false,
  commit_error: "Author identity unknown\n\n*** Please tell me who you are.",
};

describe("statusForCode — metadata-editing codes", () => {
  test("dropping a target with overlays is a 409 (re-issue-with-flag conflict)", () => {
    expect(statusForCode("library_target_removed_with_overlays")).toBe(409);
  });
  test("a kind-illegal target stays 422 (already mapped)", () => {
    expect(statusForCode("library_target_not_allowed_for_kind")).toBe(422);
  });
});

describe("buildUpdateMetadata", () => {
  test("success → 200 with the MetadataUpdateResult (metadata + commit state)", async () => {
    const r = await buildUpdateMetadata(
      CONFIGURED,
      "skill",
      "diagnose",
      { allowed_targets: ["claude", "pi"], display_name: "Diag", author: "Alice" },
      okRun(META_OK),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual(META_OK);
  });
  test("a commit failure is NON-fatal — 200 carrying committed:false + the message (Slice 4 posture)", async () => {
    const r = await buildUpdateMetadata(
      CONFIGURED,
      "skill",
      "diagnose",
      { allowed_targets: ["claude"] },
      okRun(META_COMMIT_FAILED),
    );
    expect(r.status).toBe(200);
    expect((r.body as any).committed).toBe(false);
    expect((r.body as any).commit_error).toContain("identity unknown");
    expect((r.body as any).metadata.allowed_targets).toEqual(["claude"]);
  });
  test("dropping a target with overlays → 409 library_target_removed_with_overlays", async () => {
    const r = await buildUpdateMetadata(
      CONFIGURED,
      "skill",
      "diagnose",
      { allowed_targets: ["pi"] },
      errRun(libErr("library_target_removed_with_overlays")),
    );
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_target_removed_with_overlays");
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });
  test("a kind-illegal target → 422 library_target_not_allowed_for_kind", async () => {
    const r = await buildUpdateMetadata(
      CONFIGURED,
      "agent",
      "router",
      { allowed_targets: ["codex"] },
      errRun(libErr("library_target_not_allowed_for_kind")),
    );
    expect(r.status).toBe(422);
  });
  test("forwards the editable subset + config root; a body path cannot redirect the root", async () => {
    const { run, calls } = captureRun({ ok: true, data: META_OK });
    await buildUpdateMetadata(
      CONFIGURED,
      "skill",
      "diagnose",
      { allowed_targets: ["claude", "pi"], display_name: "Diag", author: "Alice", discard_orphan_overlays: true, path: "/etc/evil" } as any,
      run,
    );
    expect(calls[0]!.command).toBe("update_metadata");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x", // config root, NOT the body's /etc/evil
      kind: "skill",
      name: "diagnose",
      allowed_targets: ["claude", "pi"],
      display_name: "Diag",
      author: "Alice",
      discard_orphan_overlays: true,
    });
  });
  test("absent display_name/author → null (not undefined) on the wire; discard defaults false", async () => {
    const { run, calls } = captureRun({ ok: true, data: META_OK });
    await buildUpdateMetadata(CONFIGURED, "skill", "diagnose", { allowed_targets: ["claude"] }, run);
    expect(calls[0]!.args).toMatchObject({
      display_name: null,
      author: null,
      discard_orphan_overlays: false,
    });
  });
  test("an empty-string display_name/author is preserved verbatim on the wire (the bridge collapses it to null)", async () => {
    const { run, calls } = captureRun({ ok: true, data: META_OK });
    await buildUpdateMetadata(CONFIGURED, "skill", "diagnose", { allowed_targets: ["claude"], display_name: "", author: "" }, run);
    // "" is a string, so it rides as "" — the bridge's parse_optional_nonempty
    // turns ""/null alike into None. The route only nulls non-string values.
    expect(calls[0]!.args).toMatchObject({ display_name: "", author: "" });
  });
  test("unconfigured → 409 WITHOUT spawning", async () => {
    const { run, calls } = captureRun({ ok: true, data: META_OK });
    const r = await buildUpdateMetadata(UNCONFIGURED, "skill", "diagnose", { allowed_targets: ["claude"] }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
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

  test("a failing install is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    // A config whose bridge is missing → every install fails — but only the
    // library route should feel it.
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const install = await app.request("/api/library/primitives/skill/diagnose/install", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ targets: ["claude"], force: false }),
    });
    expect([409, 422, 502]).toContain(install.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });

  test("the install/uninstall/ack/import write routes + installs/drift reads are wired", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    // We can't assert success without a bridge, but the routes must EXIST (not 404).
    const post = (p: string) =>
      app.request(p, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify({ targets: ["claude"], force: false, target: "claude" }),
      });
    expect((await app.request("/api/library/drift")).status).not.toBe(404);
    expect((await app.request("/api/library/primitives/skill/diagnose/drift")).status).not.toBe(404);
    expect((await app.request("/api/library/primitives/skill/diagnose/installs")).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/install")).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/acknowledge-drift")).status).not.toBe(404);
    expect((await post("/api/library/import-installs")).status).not.toBe(404);
    const del = await app.request("/api/library/primitives/skill/diagnose/install", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ targets: ["claude"], force: false }),
    });
    expect(del.status).not.toBe(404);
  });

  test("the search route is wired (GET, no write lock) and is distinct from :kind/:name", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    // The route must EXIST (not 404). A bare /search and a ?q= both resolve to
    // buildSearch, never to the /primitives/:kind/:name detail handler.
    expect((await app.request("/api/library/search")).status).not.toBe(404);
    expect((await app.request("/api/library/search?q=needle")).status).not.toBe(404);
  });

  test("a failing search is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const search = await app.request("/api/library/search?q=needle");
    expect([409, 422, 502]).toContain(search.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });

  test("the working-file read + write routes are wired (list/read/save/create/update/rename/delete)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const send = (p: string, method: string) =>
      app.request(p, {
        method,
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify({ path: "notes.md", content: "x", old_path: "a.md", new_path: "b.md" }),
      });
    // Reads
    expect((await app.request("/api/library/primitives/skill/diagnose/working-files")).status).not.toBe(404);
    expect(
      (await app.request("/api/library/primitives/skill/diagnose/working-files/content?path=notes.md")).status,
    ).not.toBe(404);
    // Writes
    expect((await send("/api/library/primitives/skill/diagnose/working", "POST")).status).not.toBe(404);
    expect((await send("/api/library/primitives/skill/diagnose/working-files", "POST")).status).not.toBe(404);
    expect((await send("/api/library/primitives/skill/diagnose/working-files", "PUT")).status).not.toBe(404);
    expect((await send("/api/library/primitives/skill/diagnose/working-files/rename", "PUT")).status).not.toBe(404);
    expect((await send("/api/library/primitives/skill/diagnose/working-files", "DELETE")).status).not.toBe(404);
  });

  test("a failing working-file save is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const save = await app.request("/api/library/primitives/skill/diagnose/working", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ content: "---\n---\nx\n" }),
    });
    expect([409, 422, 502]).toContain(save.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });

  test("the versioning routes are wired (read version / publish / set-current / revert)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const post = (p: string) =>
      app.request(p, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify({ version_label: "v1", notes: "x" }),
      });
    // Read (label as a path segment).
    expect((await app.request("/api/library/primitives/skill/diagnose/versions/v1")).status).not.toBe(404);
    // Writes.
    expect((await post("/api/library/primitives/skill/diagnose/versions")).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/current-version")).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/revert")).status).not.toBe(404);
  });

  test("a failing publish is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const publish = await app.request("/api/library/primitives/skill/diagnose/versions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ version_label: "v1" }),
    });
    expect([409, 422, 502]).toContain(publish.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });

  test("the target-overlay routes are wired (read merged view / write / remove / list)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const send = (p: string, method: string) =>
      app.request(p, {
        method,
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify({ content: "---\n---\nx\n" }),
      });
    // Reads.
    expect((await app.request("/api/library/primitives/skill/diagnose/targets/claude")).status).not.toBe(404);
    expect((await app.request("/api/library/primitives/skill/diagnose/overlays")).status).not.toBe(404);
    // Writes (PUT / DELETE …/overlay).
    expect((await send("/api/library/primitives/skill/diagnose/targets/claude/overlay", "PUT")).status).not.toBe(404);
    expect((await send("/api/library/primitives/skill/diagnose/targets/claude/overlay", "DELETE")).status).not.toBe(404);
  });

  test("a failing overlay write is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const write = await app.request("/api/library/primitives/skill/diagnose/targets/claude/overlay", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ content: "---\n---\nx\n" }),
    });
    expect([409, 422, 502]).toContain(write.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });

  test("a failing metadata edit is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const edit = await app.request("/api/library/primitives/skill/diagnose/metadata", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ allowed_targets: ["claude"], display_name: "Diag", author: null }),
    });
    expect([409, 422, 502]).toContain(edit.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });
});

// ---------------------------------------------------------------------------
// Reimport-from-drift route (reimport slice)
//
// Reimport pulls a drifted install's on-disk bytes back into the library as a
// new version. The load-bearing checks: (1) all five ReimportResult variants
// ride 200 as DATA (only genuine faults map to error codes); (2) the handler
// takes withWriteLock — UNLIKE its publish sibling — because it re-baselines
// installs.json (the D1 concurrency tripwire); (3) the write root + home +
// installs_path are config-resolved, never body-derived; (4) created_at is
// server-stamped; (5) discard_working / fixed_primary_text flow to the bridge.
// ---------------------------------------------------------------------------

const REIMPORTED = { kind: "reimported", new_version: "v2", committed: true, commit_error: null };
const REIMPORT_DIRTY = { kind: "working_copy_dirty" };
const REIMPORT_BROKEN = {
  kind: "broken_source",
  primary_path: "SKILL.md",
  raw_bytes: [110, 111, 112],
  parse_error: "missing frontmatter",
};

describe("buildReimport", () => {
  test("a clean reimport → 200 with the reimported result + commit fields", async () => {
    const r = await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, okRun(REIMPORTED));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(REIMPORTED);
  });

  test("working_copy_dirty rides 200 as DATA (not an error) — the UI confirms then retries", async () => {
    const r = await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, okRun(REIMPORT_DIRTY));
    expect(r.status).toBe(200);
    expect((r.body as any).kind).toBe("working_copy_dirty");
  });

  test("broken_source rides 200 carrying the raw bytes + parse error for the fix sheet", async () => {
    const r = await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, okRun(REIMPORT_BROKEN));
    expect(r.status).toBe(200);
    expect((r.body as any).kind).toBe("broken_source");
    expect((r.body as any).raw_bytes).toEqual([110, 111, 112]);
  });

  test("an invalid version label → 422 (genuine fault, detail withheld)", async () => {
    const r = await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "nope" }, errRun(libErr("library_invalid_version")));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });

  test("no install record → 502 only on a genuine core fault, NOT the not_installed result", async () => {
    // The `not_installed` RESULT rides 200 (data); a bridge/core fault is the
    // separate error path. Assert the result path first…
    const okR = await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "pi", version_label: "v2" }, okRun({ kind: "not_installed" }));
    expect(okR.status).toBe(200);
    expect((okR.body as any).kind).toBe("not_installed");
  });

  test("forwards source_target→target, label, discard_working, fixed_primary_text + a SERVER-stamped created_at; root/home/installs stay config", async () => {
    const { run, calls } = captureRun({ ok: true, data: REIMPORTED });
    await buildReimport(
      CONFIGURED,
      "skill",
      "diagnose",
      {
        source_target: "claude",
        version_label: "v2",
        notes: "captured drift",
        discard_working: true,
        fixed_primary_text: "---\n---\nfixed\n",
        path: "/etc/evil",
        home: "/etc/evil-home",
        installs_path: "/etc/evil-installs",
        created_at: "1999-01-01T00:00:00Z",
      } as any,
      run,
      "2026-06-12T00:00:00Z",
    );
    expect(calls[0]!.command).toBe("reimport_install");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x", // config root, NOT the body's /etc/evil
      home: "/home/test", // config, NOT body
      installs_path: "/data/installs.json", // config, NOT body
      kind: "skill",
      name: "diagnose",
      target: "claude", // source_target → the bridge's single-target `target`
      version_label: "v2",
      notes: "captured drift",
      discard_working: true,
      fixed_primary_text: "---\n---\nfixed\n",
      created_at: "2026-06-12T00:00:00Z", // injected `now`, NOT the body's 1999
    });
  });

  test("absent discard_working / fixed_primary_text default to false / null on the wire", async () => {
    const { run, calls } = captureRun({ ok: true, data: REIMPORTED });
    await buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, run, "2026-06-12T00:00:00Z");
    expect(calls[0]!.args.discard_working).toBe(false);
    expect(calls[0]!.args.fixed_primary_text).toBeNull();
  });

  test("unconfigured → 409 WITHOUT spawning (needs the layout to snapshot)", async () => {
    const { run, calls } = captureRun({ ok: true, data: REIMPORTED });
    const r = await buildReimport(UNCONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, run);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(calls).toHaveLength(0);
  });

  // D1 tripwire — reimport DIVERGES from its publish sibling: it must hold the
  // write lock because it re-baselines installs.json. A reimport and an
  // acknowledge dispatched concurrently must run strictly one-at-a-time.
  test("D1: reimport serializes against a concurrent ledger write (acknowledge)", async () => {
    let active = 0;
    let maxActive = 0;
    const slowRun: typeof runBridge = (async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((res) => setTimeout(res, 5));
      active -= 1;
      return { ok: true, data: REIMPORTED };
    }) as any;
    await Promise.all([
      buildReimport(CONFIGURED, "skill", "diagnose", { source_target: "claude", version_label: "v2" }, slowRun),
      buildAcknowledgeDrift(CONFIGURED, "skill", "diagnose", { target: "claude" }, slowRun),
    ]);
    expect(maxActive).toBe(1); // never two ledger writers in flight at once
  });
});

describe("registerLibraryRoutes — reimport HTTP wiring", () => {
  test("the reimport route is wired (POST …/reimport)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const res = await app.request("/api/library/primitives/skill/diagnose/reimport", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ source_target: "claude", version_label: "v2" }),
    });
    expect(res.status).not.toBe(404);
  });

  test("a failing reimport is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));

    const reimport = await app.request("/api/library/primitives/skill/diagnose/reimport", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
      body: JSON.stringify({ source_target: "claude", version_label: "v2" }),
    });
    expect([409, 422, 502]).toContain(reimport.status); // a library-local failure status

    const summary = await app.request("/api/summary");
    expect(summary.status).toBe(200); // Observability untouched
  });
});

// ---------------------------------------------------------------------------
// Primitive-lifecycle routes (lifecycle slice)
//
// Structural CRUD. The load-bearing checks: (1) the new library_primitive_exists
// → 409 mapping (a name collision is a legible conflict, never a 502);
// (2) home/installs_path are CONFIG-resolved, never body-derived (D7);
// (3) the write-lock split — delete/rename/import/forget serialize (they mutate
// installs.json), create/duplicate do NOT (publish posture); (4) the tagged
// ImportFromPathResult variants all ride 200 as data the UI routes on;
// (5) created_at is server-stamped; (6) route-local failure leaves Observability
// at 200.
// ---------------------------------------------------------------------------

const DELETE_OK = { uninstall: { successes: [], failures: [] }, library_dir_removed: true, committed: true, commit_error: null };
const DELETE_BAILED = {
  uninstall: { successes: [], failures: [{ target: "claude", reason: { kind: "io", path: "x", message: "ENOTDIR" } }] },
  library_dir_removed: false,
  committed: false,
  commit_error: null,
};
const RENAME_OK = { install_records_updated: 2, committed: true, commit_error: null };
const DUPLICATE_OK = { new_name: "diagnose-copy", committed: true, commit_error: null };
const IMPORT_OK = { kind: "imported", primitive_kind: "skill", name: "imported", committed: true, commit_error: null };
const IMPORT_NOT_CLASSIFIABLE = { kind: "not_classifiable", reason: "path is not under a recognized install root" };
const CREATE_OK = { committed: true, commit_error: null };
const FORGET_OK = { removed: true };

describe("statusForCode — lifecycle codes", () => {
  test("a name collision is 409 (the create/rename/duplicate conflict)", () => {
    expect(statusForCode("library_primitive_exists")).toBe(409);
  });
});

describe("buildCreatePrimitive", () => {
  test("a clean create → 200 with the commit result", async () => {
    const r = await buildCreatePrimitive(CONFIGURED, { kind: "skill", name: "triage" }, okRun(CREATE_OK));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(CREATE_OK);
  });

  test("a name collision → 409 (library_primitive_exists), never a 502", async () => {
    const r = await buildCreatePrimitive(CONFIGURED, { kind: "skill", name: "diagnose" }, errRun(libErr("library_primitive_exists")));
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_primitive_exists");
    expect(JSON.stringify(r.body)).not.toContain("/Users/"); // m4: detail withheld
  });

  test("forwards kind/name from the body + a SERVER-stamped created_at; root stays config (no lock — publish posture)", async () => {
    const { run, calls } = captureRun({ ok: true, data: CREATE_OK });
    await buildCreatePrimitive(CONFIGURED, { kind: "skill", name: "triage", created_at: "1999-01-01T00:00:00Z" } as any, run, "2026-06-12T00:00:00Z");
    expect(calls[0]!.command).toBe("create_primitive");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x", // config root
      kind: "skill",
      name: "triage",
      created_at: "2026-06-12T00:00:00Z", // injected now, NOT the body's 1999
    });
  });

  test("unconfigured → 409 WITHOUT spawning (create needs the layout)", async () => {
    const { run, calls } = captureRun({ ok: true, data: CREATE_OK });
    const r = await buildCreatePrimitive(UNCONFIGURED, { kind: "skill", name: "triage" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildDeletePrimitive", () => {
  test("a clean delete → 200 with the summary + commit fields", async () => {
    const r = await buildDeletePrimitive(CONFIGURED, "skill", "diagnose", okRun(DELETE_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).library_dir_removed).toBe(true);
    expect((r.body as any).committed).toBe(true);
  });

  test("a bailed delete (uninstall failures, dir untouched) is a NORMAL 200 the UI inspects, not an error", async () => {
    const r = await buildDeletePrimitive(CONFIGURED, "skill", "diagnose", okRun(DELETE_BAILED));
    expect(r.status).toBe(200);
    expect((r.body as any).library_dir_removed).toBe(false);
    expect((r.body as any).committed).toBe(false);
    expect((r.body as any).uninstall.failures).toHaveLength(1);
  });

  test("D7 tripwire: home/installs_path are config-resolved; a hostile body is ignored", async () => {
    const { run, calls } = captureRun({ ok: true, data: DELETE_OK });
    await buildDeletePrimitive(CONFIGURED, "skill", "diagnose", run);
    expect(calls[0]!.command).toBe("delete_primitive");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x",
      home: "/home/test",
      installs_path: "/data/installs.json",
      kind: "skill",
      name: "diagnose",
    });
  });

  test("unconfigured → 409 WITHOUT spawning (delete needs the layout to rm the dir)", async () => {
    const { run, calls } = captureRun({ ok: true, data: DELETE_OK });
    const r = await buildDeletePrimitive(UNCONFIGURED, "skill", "diagnose", run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildRenamePrimitive", () => {
  test("a clean rename → 200 with the install-records-updated count", async () => {
    const r = await buildRenamePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "triage" }, okRun(RENAME_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).install_records_updated).toBe(2);
  });

  test("a new_name collision → 409; a missing source → 404", async () => {
    expect((await buildRenamePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "taken" }, errRun(libErr("library_primitive_exists")))).status).toBe(409);
    expect((await buildRenamePrimitive(CONFIGURED, "skill", "ghost", { new_name: "triage" }, errRun(libErr("primitive_not_found")))).status).toBe(404);
  });

  test("a malformed new_name → 422 (library_invalid_name at the boundary)", async () => {
    const r = await buildRenamePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "../evil" }, errRun(libErr("library_invalid_name")));
    expect(r.status).toBe(422);
  });

  test("forwards new_name + config-resolved home/installs_path (D7)", async () => {
    const { run, calls } = captureRun({ ok: true, data: RENAME_OK });
    await buildRenamePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "triage", home: "/etc", installs_path: "/etc/x" } as any, run);
    expect(calls[0]!.command).toBe("rename_primitive");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", home: "/home/test", installs_path: "/data/installs.json", new_name: "triage" });
  });
});

describe("buildDuplicatePrimitive", () => {
  test("a clean duplicate → 200 with the new name + commit fields", async () => {
    const r = await buildDuplicatePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "diagnose-copy" }, okRun(DUPLICATE_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).new_name).toBe("diagnose-copy");
  });

  test("forwards new_name + a SERVER-stamped created_at; sends NO installs_path (touches no ledger — publish posture)", async () => {
    const { run, calls } = captureRun({ ok: true, data: DUPLICATE_OK });
    await buildDuplicatePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "diagnose-copy" }, run, "2026-06-12T00:00:00Z");
    expect(calls[0]!.command).toBe("duplicate_primitive");
    expect(calls[0]!.args).toMatchObject({ path: "/libs/x", kind: "skill", name: "diagnose", new_name: "diagnose-copy", created_at: "2026-06-12T00:00:00Z" });
    expect(calls[0]!.args.installs_path).toBeUndefined(); // duplicate carries no install records
  });

  test("a new_name collision → 409", async () => {
    expect((await buildDuplicatePrimitive(CONFIGURED, "skill", "diagnose", { new_name: "taken" }, errRun(libErr("library_primitive_exists")))).status).toBe(409);
  });
});

describe("buildImportFromPath", () => {
  test("an Imported result → 200 with the tagged result + commit fields", async () => {
    const r = await buildImportFromPath(CONFIGURED, { source_path: "/home/test/.claude/skills/imported" }, okRun(IMPORT_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).kind).toBe("imported");
    expect((r.body as any).committed).toBe(true);
  });

  test("NotClassifiable rides 200 as DATA the UI routes on (→ bootstrap), not an error", async () => {
    const r = await buildImportFromPath(CONFIGURED, { source_path: "../../etc/passwd" }, okRun(IMPORT_NOT_CLASSIFIABLE));
    expect(r.status).toBe(200);
    expect((r.body as any).kind).toBe("not_classifiable");
  });

  test("D7 tripwire: home/installs_path are config-resolved; only source_path rides the body", async () => {
    const { run, calls } = captureRun({ ok: true, data: IMPORT_OK });
    await buildImportFromPath(CONFIGURED, { source_path: "/home/test/.claude/skills/imported", home: "/etc", installs_path: "/etc/x" } as any, run, "2026-06-12T00:00:00Z");
    expect(calls[0]!.command).toBe("import_primitive_from_path");
    expect(calls[0]!.args).toMatchObject({
      path: "/libs/x",
      home: "/home/test", // config, NOT body
      installs_path: "/data/installs.json", // config, NOT body
      source_path: "/home/test/.claude/skills/imported",
      created_at: "2026-06-12T00:00:00Z",
    });
  });

  test("unconfigured → 409 WITHOUT spawning (import needs the layout)", async () => {
    const { run, calls } = captureRun({ ok: true, data: IMPORT_OK });
    const r = await buildImportFromPath(UNCONFIGURED, { source_path: "/x" }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("buildForgetPrimitive", () => {
  test("success → 200 with {removed}", async () => {
    const r = await buildForgetPrimitive(CONFIGURED, "skill", "diagnose", okRun(FORGET_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).removed).toBe(true);
  });

  test("works while unconfigured (installs.json only — uninstall posture); home/installs_path config-resolved", async () => {
    const { run, calls } = captureRun({ ok: true, data: FORGET_OK });
    const r = await buildForgetPrimitive(UNCONFIGURED, "skill", "diagnose", run);
    expect(r.status).toBe(200);
    expect(calls[0]!.args).toMatchObject({ home: "/home/test", installs_path: "/data/installs.json", kind: "skill", name: "diagnose" });
    expect(calls[0]!.args.path).toBeUndefined(); // forget needs no library root
  });
});

describe("lifecycle write-lock split (D1)", () => {
  // delete/rename/import/forget mutate installs.json → must serialize. create/
  // duplicate touch no ledger (publish posture) → must NOT block a ledger writer.
  const slowRun = (maxRef: { active: number; max: number }): typeof runBridge =>
    (async () => {
      maxRef.active += 1;
      maxRef.max = Math.max(maxRef.max, maxRef.active);
      await new Promise((res) => setTimeout(res, 5));
      maxRef.active -= 1;
      return { ok: true, data: DELETE_OK };
    }) as any;

  test("delete serializes against a concurrent acknowledge (both ledger writers)", async () => {
    const ref = { active: 0, max: 0 };
    await Promise.all([
      buildDeletePrimitive(CONFIGURED, "skill", "a", slowRun(ref)),
      buildAcknowledgeDrift(CONFIGURED, "skill", "b", { target: "claude" }, slowRun(ref)),
    ]);
    expect(ref.max).toBe(1); // never two ledger writers in flight
  });

  test("rename, import, and forget each serialize against a ledger writer", async () => {
    for (const op of [
      (r: typeof runBridge) => buildRenamePrimitive(CONFIGURED, "skill", "a", { new_name: "b" }, r),
      (r: typeof runBridge) => buildImportFromPath(CONFIGURED, { source_path: "/x" }, r),
      (r: typeof runBridge) => buildForgetPrimitive(CONFIGURED, "skill", "a", r),
    ]) {
      const ref = { active: 0, max: 0 };
      await Promise.all([op(slowRun(ref)), buildAcknowledgeDrift(CONFIGURED, "skill", "b", { target: "claude" }, slowRun(ref))]);
      expect(ref.max).toBe(1);
    }
  });

  test("create and duplicate do NOT take the write lock (publish posture — they never touch installs.json)", async () => {
    // A create + duplicate dispatched concurrently must be able to overlap; if
    // either grabbed the ledger mutex they'd serialize to max 1.
    const ref = { active: 0, max: 0 };
    await Promise.all([
      buildCreatePrimitive(CONFIGURED, { kind: "skill", name: "a" }, slowRun(ref)),
      buildDuplicatePrimitive(CONFIGURED, "skill", "a", { new_name: "b" }, slowRun(ref)),
    ]);
    expect(ref.max).toBe(2); // both run in parallel — neither is lock-gated
  });
});

describe("registerLibraryRoutes — lifecycle HTTP wiring", () => {
  test("the lifecycle routes are wired (create / delete / rename / duplicate / forget / import-from-path)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const post = (p: string, body: object) =>
      app.request(p, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify(body),
      });
    expect((await post("/api/library/primitives", { kind: "skill", name: "triage" })).status).not.toBe(404);
    expect((await post("/api/library/import-from-path", { source_path: "/x" })).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/rename", { new_name: "triage" })).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/duplicate", { new_name: "copy" })).status).not.toBe(404);
    expect((await post("/api/library/primitives/skill/diagnose/forget", {})).status).not.toBe(404);
    const del = await app.request("/api/library/primitives/skill/diagnose", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
    });
    expect(del.status).not.toBe(404);
  });

  test("the bare DELETE …/:kind/:name does not shadow …/install (uninstall) or …/working-files", async () => {
    // Both more-specific DELETEs must still resolve to their own handlers, not
    // the new bare delete — distinct suffixes.
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const del = (p: string) =>
      app.request(p, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: JSON.stringify({ targets: ["claude"], path: "notes.md" }),
      });
    expect((await del("/api/library/primitives/skill/diagnose/install")).status).not.toBe(404);
    expect((await del("/api/library/primitives/skill/diagnose/working-files")).status).not.toBe(404);
  });

  test("a failing delete is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));
    const del = await app.request("/api/library/primitives/skill/diagnose", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
    });
    expect([409, 422, 502]).toContain(del.status);
    expect((await app.request("/api/summary")).status).toBe(200);
  });
});

// ===========================================================================
// Bootstrap-discovery routes (bootstrap slice)
//   scan/session-read are reads (no lock; scan on a longer watchdog); execute/
//   session-clear are writes under the ledger mutex. All five config paths are
//   injected (D7), never body-derived; every execute outcome (incl. skips) rides
//   200 as data; the execute clock is server-stamped.
// ===========================================================================

// Capture the 4th `opts` arg too (the base captureRun drops it) so the scan's
// longer-than-read-default timeout is assertable.
function captureRunOpts(result: BridgeResult<unknown>): {
  run: typeof runBridge;
  calls: { command: string; args: Record<string, unknown>; opts: any }[];
} {
  const calls: { command: string; args: Record<string, unknown>; opts: any }[] = [];
  const run = (async (_bridgePath: string, command: string, args: Record<string, unknown>, opts: any) => {
    calls.push({ command, args, opts });
    return result;
  }) as unknown as typeof runBridge;
  return { run, calls };
}

const SCAN_RESULT = {
  cross_referenced: {
    groups: [
      { kind: "skill", name: "newskill", classification: { New: { content: { hash: "h1" } } } },
      { kind: "skill", name: "diagnose", classification: { Drifted: { content: { hash: "h2" } } } },
      { kind: "agent", name: "old", classification: "AlreadyImported" },
    ],
    needs_manual_review: [{ kind: "command", name: "weird", members: [] }],
    symlinked: [],
    unclassified: [],
  },
  plan: {
    creates: [{ kind: "skill", name: "newskill", base: { target: "claude" }, overlays: [] }],
    reimports: [{ kind: "skill", name: "diagnose", base: { target: "claude" } }],
  },
};

const EXECUTE_OK = {
  backup_path: "/data/backups/2026-06-12T00-00-00Z.tar.gz",
  created: 1,
  reimported: 1,
  skipped: 0,
  skipped_items: [],
  committed: true,
  commit_error: null,
};

const EXECUTE_SKIPPED = {
  backup_path: "/data/backups/2026-06-12T00-00-00Z.tar.gz",
  created: 1,
  reimported: 0,
  skipped: 1,
  skipped_items: [{ kind: "skill", name: "diagnose", source_target: "claude", reason: "WorkingCopyDirty" }],
  committed: true,
  commit_error: null,
};

const SESSION = {
  format_version: 2,
  started_at: "2026-06-12T00:00:00Z",
  backup_taken: true,
  excluded_ids: ["skill/foo"],
  completed: [],
};

describe("statusForCode — bootstrap codes", () => {
  test("a config-not-ready bootstrap fault is 409 (like installs_unconfigured)", () => {
    expect(statusForCode("bootstrap_unconfigured")).toBe(409);
  });
});

describe("buildBootstrapScan", () => {
  test("returns 200 with the scan envelope (passed through to the parser)", async () => {
    const r = await buildBootstrapScan(CONFIGURED, okRun(SCAN_RESULT));
    expect(r.status).toBe(200);
    expect((r.body as any).plan.creates).toHaveLength(1);
  });

  test("unconfigured library → 409 WITHOUT spawning (scan cross-references the library)", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: SCAN_RESULT });
    const r = await buildBootstrapScan(UNCONFIGURED, run);
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("library_unconfigured");
    expect(calls).toHaveLength(0);
  });

  test("D7: path + home are config-resolved; scan runs on a longer-than-read-default watchdog", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: SCAN_RESULT });
    await buildBootstrapScan(CONFIGURED, run);
    expect(calls[0]!.command).toBe("bootstrap_scan");
    expect(calls[0]!.args).toEqual({ path: "/libs/x", home: "/home/test" });
    // a slow-but-healthy home walk must not 502 on the 10s read default
    expect(calls[0]!.opts.timeoutMs).toBe(30_000);
  });
});

describe("buildBootstrapExecute", () => {
  test("a clean run returns 200 with the summary", async () => {
    const r = await buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan, excluded_ids: [] }, okRun(EXECUTE_OK));
    expect(r.status).toBe(200);
    expect((r.body as any).created).toBe(1);
    expect((r.body as any).reimported).toBe(1);
  });

  test("a partial run (skipped_items) is a NORMAL 200 — a skip is data, not an error", async () => {
    const r = await buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan }, okRun(EXECUTE_SKIPPED));
    expect(r.status).toBe(200);
    expect((r.body as any).skipped).toBe(1);
    expect((r.body as any).skipped_items[0].reason).toBe("WorkingCopyDirty");
  });

  test("unconfigured library → 409 WITHOUT spawning (execute writes versions)", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: EXECUTE_OK });
    const r = await buildBootstrapExecute(UNCONFIGURED, { plan: SCAN_RESULT.plan }, run);
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("D7 tripwire: all five paths are config-injected; a hostile body's paths are ignored; created_at is server-stamped", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: EXECUTE_OK });
    const body = {
      plan: SCAN_RESULT.plan,
      resume: SESSION,
      excluded_ids: ["skill/foo"],
      // hostile redirection attempts — every one must be ignored:
      path: "/etc",
      home: "/etc",
      installs_path: "/etc/installs.json",
      session_path: "/etc/sess.json",
      backup_dir: "/etc/backups",
      created_at: "1999-01-01T00:00:00Z",
    } as any;
    await buildBootstrapExecute(CONFIGURED, body, run, "2026-06-12T09:00:00Z");
    const a = calls[0]!.args;
    expect(a.path).toBe("/libs/x");
    expect(a.home).toBe("/home/test");
    expect(a.installs_path).toBe("/data/installs.json");
    expect(a.session_path).toBe("/data/bootstrap-session.json");
    expect(a.backup_dir).toBe("/data/backups");
    expect(a.created_at).toBe("2026-06-12T09:00:00Z"); // server clock, not body
    // the plan / resume / excluded_ids DO ride the body (round-tripped untouched)
    expect(a.plan).toEqual(SCAN_RESULT.plan);
    expect(a.resume).toEqual(SESSION);
    expect(a.excluded_ids).toEqual(["skill/foo"]);
  });

  test("a missing excluded_ids defaults to [] (never undefined to the bridge)", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: EXECUTE_OK });
    await buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan }, run);
    expect(calls[0]!.args.excluded_ids).toEqual([]);
    expect(calls[0]!.args.resume).toBeNull(); // a fresh run carries no resume
  });
});

describe("buildReadBootstrapSession / buildClearBootstrapSession", () => {
  test("read returns 200 with {session}; session_path is config-injected", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: SESSION });
    const r = await buildReadBootstrapSession(CONFIGURED, run);
    expect(r.status).toBe(200);
    expect((r.body as any).session).toEqual(SESSION);
    expect(calls[0]!.args).toEqual({ session_path: "/data/bootstrap-session.json" });
  });

  test("read passes a bridge null straight through as {session:null} (absent → 200, never 404)", async () => {
    const r = await buildReadBootstrapSession(CONFIGURED, okRun(null));
    expect(r.status).toBe(200);
    expect((r.body as any).session).toBeNull();
  });

  test("read + clear run even while the library is unconfigured (session-file only)", async () => {
    const { run, calls } = captureRunOpts({ ok: true, data: null });
    expect((await buildReadBootstrapSession(UNCONFIGURED, run)).status).toBe(200);
    expect((await buildClearBootstrapSession(UNCONFIGURED, run)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("clear returns 200 {} ", async () => {
    const r = await buildClearBootstrapSession(CONFIGURED, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
});

describe("bootstrap write-lock split (D1)", () => {
  const slowRun = (maxRef: { active: number; max: number }): typeof runBridge =>
    (async () => {
      maxRef.active += 1;
      maxRef.max = Math.max(maxRef.max, maxRef.active);
      await new Promise((res) => setTimeout(res, 5));
      maxRef.active -= 1;
      return { ok: true, data: EXECUTE_OK };
    }) as any;

  test("execute serializes against a concurrent ledger writer (it mutates installs.json)", async () => {
    const ref = { active: 0, max: 0 };
    await Promise.all([
      buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan }, slowRun(ref)),
      buildAcknowledgeDrift(CONFIGURED, "skill", "b", { target: "claude" }, slowRun(ref)),
    ]);
    expect(ref.max).toBe(1);
  });

  test("clear serializes against a concurrent execute (it removes the session mid-run)", async () => {
    const ref = { active: 0, max: 0 };
    await Promise.all([
      buildClearBootstrapSession(CONFIGURED, slowRun(ref)),
      buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan }, slowRun(ref)),
    ]);
    expect(ref.max).toBe(1);
  });

  test("session READ does NOT take the write lock (it overlaps a write)", async () => {
    const ref = { active: 0, max: 0 };
    await Promise.all([
      buildReadBootstrapSession(CONFIGURED, slowRun(ref)),
      buildBootstrapExecute(CONFIGURED, { plan: SCAN_RESULT.plan }, slowRun(ref)),
    ]);
    expect(ref.max).toBe(2); // the read is not lock-gated
  });
});

describe("registerLibraryRoutes — bootstrap HTTP wiring", () => {
  test("the four bootstrap routes are wired (scan / session GET+DELETE / execute)", async () => {
    const app = new Hono();
    registerLibraryRoutes(app, () => CONFIGURED);
    const get = (p: string) => app.request(p);
    const send = (p: string, method: string, body?: object) =>
      app.request(p, {
        method,
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:8765" },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await get("/api/library/bootstrap/scan")).status).not.toBe(404);
    expect((await get("/api/library/bootstrap/session")).status).not.toBe(404);
    expect((await send("/api/library/bootstrap/execute", "POST", { plan: SCAN_RESULT.plan })).status).not.toBe(404);
    expect((await send("/api/library/bootstrap/session", "DELETE")).status).not.toBe(404);
  });

  test("a failing scan is route-local: a sibling Observability route stays 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    registerLibraryRoutes(app, () => ({ ...CONFIGURED, bridgePath: "/no/such/bridge" }));
    const scan = await app.request("/api/library/bootstrap/scan");
    expect([409, 422, 502]).toContain(scan.status);
    expect((await app.request("/api/summary")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Git remote sync routes (Slice 8) — incl. the D6 secret-redaction tripwire
// ---------------------------------------------------------------------------
import { spyOn } from "bun:test";
import {
  buildConfigureRemote,
  buildSetPat,
  buildDeletePat,
  buildRemoteStatus,
  buildScanBeforePush,
  buildUnpushedCount,
  buildPush,
  buildPull,
  buildIsPullPaused,
  buildListConflicts,
  buildReadConflictBlob,
  buildResolveConflict,
  buildContinuePull,
  buildAbortPull,
} from "./library_routes.ts";

const WITH_REMOTE = { ...CONFIGURED, remoteUrl: "https://github.com/o/r" };
const PLANTED_PAT = "ghp_PLANTEDsecret0123456789abcdefghijkl";

describe("statusForCode — git-sync codes (Slice 8)", () => {
  test("preconditions are 409", () => {
    for (const c of ["no_pat_stored", "remote_not_configured", "askpass_unconfigured"])
      expect(statusForCode(c)).toBe(409);
  });
  test("bad inputs are 422", () => {
    for (const c of ["empty_pat", "invalid_remote_url", "invalid_conflict_side", "conflict_path_missing", "conflict_blob_not_utf8"])
      expect(statusForCode(c)).toBe(422);
  });
  test("git/secret faults are 502", () => {
    for (const c of ["git_failed", "git_timed_out", "secret_store_error"]) expect(statusForCode(c)).toBe(502);
  });
});

describe("buildConfigureRemote (validate + persist — D1)", () => {
  test("a valid URL persists the normalized form and returns it", async () => {
    const persisted: string[] = [];
    const r = await buildConfigureRemote(
      CONFIGURED,
      { url: "https://github.com/o/r" },
      okRun({ remote_url: "https://github.com/o/r" }),
      (u) => persisted.push(u),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ remote_url: "https://github.com/o/r" });
    expect(persisted).toEqual(["https://github.com/o/r"]);
  });
  test("an invalid URL is 422 and NEVER persists", async () => {
    const persisted: string[] = [];
    const r = await buildConfigureRemote(
      CONFIGURED,
      { url: "http://evil" },
      errRun({ code: "invalid_remote_url", message: "invalid remote URL", detail: "non-https" }),
      (u) => persisted.push(u),
    );
    expect(r.status).toBe(422);
    expect(persisted).toEqual([]);
  });
  test("passes the library path (origin lives in the repo) and refuses when unconfigured", async () => {
    const { run, calls } = captureRun({ ok: true, data: { remote_url: "https://github.com/o/r" } });
    await buildConfigureRemote(CONFIGURED, { url: "https://github.com/o/r" }, run, () => {});
    expect(calls[0]!.args).toEqual({ path: CONFIGURED.libraryPath, url: "https://github.com/o/r" });
    // no library → refuse before any spawn or persist
    const persisted: string[] = [];
    const r = await buildConfigureRemote(UNCONFIGURED, { url: "https://github.com/o/r" }, okRun({ remote_url: "x" }), (u) => persisted.push(u));
    expect(r.status).toBe(409); // library_unconfigured
    expect(persisted).toEqual([]);
  });
});

describe("set_pat / get_remote_status — the D6 secret discipline", () => {
  test("the request PAT is never echoed in the body and never logged (ok path)", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const r = await buildSetPat(CONFIGURED, { pat: PLANTED_PAT }, okRun({}));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(PLANTED_PAT);
    expect(spy.mock.calls.flat().join(" ")).not.toContain(PLANTED_PAT);
    spy.mockRestore();
  });
  test("even on a bridge error, neither the body nor a forwarded detail leaks (m4)", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    // a benign (PAT-free) error detail; assert it stays server-side, never in the body
    const r = await buildSetPat(
      CONFIGURED,
      { pat: PLANTED_PAT },
      errRun({ code: "secret_store_error", message: "secret store operation failed", detail: "keychain errSecAuthFailed" }),
    );
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ code: "secret_store_error", message: "secret store operation failed" });
    expect(JSON.stringify(r.body)).not.toContain("keychain errSecAuthFailed"); // detail not forwarded
    expect(JSON.stringify(r.body)).not.toContain(PLANTED_PAT);
    spy.mockRestore();
  });
  test("get_remote_status injects the config URL and surfaces only the redacted PAT", async () => {
    const { run, calls } = captureRun({ ok: true, data: { remote_url: WITH_REMOTE.remoteUrl, pat_redacted: "ghp_••••••••cdef" } });
    const r = await buildRemoteStatus(WITH_REMOTE, run);
    expect(calls[0]!.command).toBe("get_remote_status");
    expect(calls[0]!.args).toEqual({ remote_url: "https://github.com/o/r" }); // injected from config
    expect(r.body).toEqual({ remote_url: "https://github.com/o/r", pat_redacted: "ghp_••••••••cdef" });
  });
});

describe("git-sync args are config-built — `secret_store` is NEVER forwarded (security review)", () => {
  test("set_pat forwards only the pat, never an injected secret_store from the body", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildSetPat(CONFIGURED, { pat: PLANTED_PAT, secret_store: "memory" } as any, run);
    expect(calls[0]!.args).toEqual({ pat: PLANTED_PAT });
    expect(calls[0]!.args).not.toHaveProperty("secret_store");
  });
  test("push forwards only path + askpass_dir — no secret_store, no pat", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildPush(WITH_REMOTE, run);
    expect(calls[0]!.command).toBe("push_now");
    expect(calls[0]!.args).toEqual({ path: WITH_REMOTE.libraryPath, askpass_dir: WITH_REMOTE.askpassDir });
    expect(calls[0]!.args).not.toHaveProperty("secret_store");
    expect(calls[0]!.args).not.toHaveProperty("pat");
  });
});

describe("push / pull preconditions + outcomes", () => {
  test("push refuses without a library (UNCONFIGURED) and without a remote (409)", async () => {
    expect((await buildPush(UNCONFIGURED, okRun({}))).status).toBe(409); // library_unconfigured → 409
    const r = await buildPush(CONFIGURED, okRun({})); // CONFIGURED has remoteUrl: null
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe("remote_not_configured");
  });
  test("a clean push is 200 {}", async () => {
    const r = await buildPush(WITH_REMOTE, okRun({}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
  test("a pull conflict rides 200 as DATA (not an error)", async () => {
    const r = await buildPull(WITH_REMOTE, okRun({ outcome: "conflict", conflict_count: 2 }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "conflict", conflict_count: 2 });
  });
  test("a git failure is a 502 error envelope", async () => {
    const r = await buildPull(
      WITH_REMOTE,
      errRun({ code: "git_failed", message: "git command failed", detail: "fatal: could not read from remote" }),
    );
    expect(r.status).toBe(502);
    expect((r.body as any).code).toBe("git_failed");
  });
});

describe("conflict family (Slice 8)", () => {
  test("scan-before-push returns findings; unconfigured → 409", async () => {
    // okRun bypasses `validate`, so pass the PARSED shape (parseScanFindings
    // unwraps {findings} → a bare array). The parser itself is tested in models.
    const r = await buildScanBeforePush(WITH_REMOTE, okRun([{ path: "C.md", line: 1, kind: "github_classic_pat", matched: "ghp_x" }]));
    expect(r.status).toBe(200);
    expect((r.body as any[]).length).toBe(1);
    expect((await buildScanBeforePush(UNCONFIGURED, okRun([]))).status).toBe(409);
  });
  test("read-conflict-blob forwards conflict_path + side distinctly from the library path", async () => {
    const { run, calls } = captureRun({ ok: true, data: { content: "local-change\n" } });
    const r = await buildReadConflictBlob(WITH_REMOTE, "notes.txt", "local", run);
    expect(calls[0]!.args).toEqual({ path: WITH_REMOTE.libraryPath, conflict_path: "notes.txt", side: "local" });
    expect(r.body).toEqual({ content: "local-change\n" });
  });
  test("resolve-conflict maps body.path → conflict_path", async () => {
    const { run, calls } = captureRun({ ok: true, data: {} });
    await buildResolveConflict(WITH_REMOTE, { path: "notes.txt", side: "remote" }, run);
    expect(calls[0]!.args).toEqual({ path: WITH_REMOTE.libraryPath, conflict_path: "notes.txt", side: "remote" });
  });
  test("continue-pull routes done vs still_conflicted", async () => {
    expect((await buildContinuePull(WITH_REMOTE, okRun({ outcome: "done" }))).body).toEqual({ outcome: "done" });
    const still = await buildContinuePull(WITH_REMOTE, okRun({ outcome: "still_conflicted", conflict_count: 1 }));
    expect(still.body).toEqual({ outcome: "still_conflicted", conflict_count: 1 });
  });
  test("is-pull-paused + abort + unpushed-count + delete-pat round-trip their shapes", async () => {
    expect((await buildIsPullPaused(WITH_REMOTE, okRun({ paused: true }))).body).toEqual({ paused: true });
    expect((await buildAbortPull(WITH_REMOTE, okRun({}))).body).toEqual({});
    expect((await buildUnpushedCount(WITH_REMOTE, okRun({ count: 4 }))).body).toEqual({ count: 4 });
    expect((await buildDeletePat(CONFIGURED, okRun({}))).body).toEqual({});
    expect((await buildListConflicts(WITH_REMOTE, okRun([]))).body).toEqual([]); // parsed shape (parseConflictList unwraps)
  });
});

describe("route-local failure — a git route failing leaves the rest of the app at 200", () => {
  test("a failed git push keeps /api/summary + /healthz at 200", async () => {
    const app = new Hono();
    app.get("/api/summary", (c) => c.json({ ok: true }));
    app.get("/healthz", (c) => c.text("ok"));
    registerLibraryRoutes(app, () => ({ ...WITH_REMOTE, bridgePath: "/no/such/bridge" }));
    const push = await app.request("/api/library/git/push", { method: "POST" });
    expect([409, 422, 502]).toContain(push.status);
    expect((await app.request("/api/summary")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
