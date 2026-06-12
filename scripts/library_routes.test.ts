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
  buildInstall,
  buildUninstall,
  buildAcknowledgeDrift,
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
};
const UNCONFIGURED: LibraryConfig = {
  libraryPath: null,
  bridgePath: "/bin/bridge",
  installsPath: "/data/installs.json",
  home: "/home/test",
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
});
