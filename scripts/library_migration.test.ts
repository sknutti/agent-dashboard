import { expect, test, describe } from "bun:test";
import { importInstalls, STANDALONE_INSTALLS_PATH } from "./library_migration.ts";
import type { LibraryConfig } from "./library_config.ts";
import type { BridgeResult, LibraryError, runBridge } from "./library_bridge.ts";

const CONFIG: LibraryConfig = {
  libraryPath: "/libs/x",
  bridgePath: "/bin/bridge",
  installsPath: "/data/installs.json",
  home: "/home/test",
  sessionPath: "/data/bootstrap-session.json",
  backupDir: "/data/backups",
  remoteUrl: null,
  askpassDir: "/data/askpass",
};

// A `run` stub that records its call and returns a canned BridgeResult. Typed
// loosely (the real runBridge is generic over the validator's return).
type Call = { bridgePath: string; command: string; args: Record<string, unknown> };
function stubRun(result: BridgeResult<unknown>): { run: typeof runBridge; calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (bridgePath: string, command: string, args: Record<string, unknown>) => {
    calls.push({ bridgePath, command, args });
    return result;
  }) as unknown as typeof runBridge;
  return { run, calls };
}

const libErr = (code: string): LibraryError => ({ code, message: `msg:${code}`, detail: "secret/path" });

describe("importInstalls", () => {
  test("invokes the bridge import_installs with the standalone source + config installs path", async () => {
    const { run, calls } = stubRun({ ok: true, data: { imported: 119 } });
    await importInstalls(CONFIG, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bridgePath).toBe("/bin/bridge");
    expect(calls[0]!.command).toBe("import_installs");
    expect(calls[0]!.args).toEqual({
      source_path: STANDALONE_INSTALLS_PATH,
      installs_path: "/data/installs.json",
    });
  });

  test("the standalone source path points at the macOS app's Application Support installs.json", () => {
    expect(STANDALONE_INSTALLS_PATH).toContain("com.sknutti.promptlibrary");
    expect(STANDALONE_INSTALLS_PATH).toMatch(/installs\.json$/);
  });

  test("happy path returns the imported record count", async () => {
    const { run } = stubRun({ ok: true, data: { imported: 119 } });
    const r = await importInstalls(CONFIG, run);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.imported).toBe(119);
  });

  test("an already-imported destination surfaces installs_already_present (distinct, actionable)", async () => {
    const { run } = stubRun({ ok: false, error: libErr("installs_already_present") });
    const r = await importInstalls(CONFIG, run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("installs_already_present");
  });

  test("a format-version skew surfaces installs_format_mismatch (distinct from a generic failure)", async () => {
    const { run } = stubRun({ ok: false, error: libErr("installs_format_mismatch") });
    const r = await importInstalls(CONFIG, run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("installs_format_mismatch");
  });

  test("a transport failure surfaces the bridge error code verbatim", async () => {
    const { run } = stubRun({ ok: false, error: libErr("bridge_not_found") });
    const r = await importInstalls(CONFIG, run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bridge_not_found");
  });

  test("a custom source path (test injection) overrides the standalone default", async () => {
    const { run, calls } = stubRun({ ok: true, data: { imported: 3 } });
    await importInstalls(CONFIG, run, "/tmp/source/installs.json");
    expect(calls[0]!.args.source_path).toBe("/tmp/source/installs.json");
  });
});
