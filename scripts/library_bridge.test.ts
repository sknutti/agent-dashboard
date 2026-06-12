import { expect, test, describe } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretBridgeOutcome, runBridge } from "./library_bridge.ts";
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
} from "./library_models.ts";

const FIX = join(import.meta.dir, "fixtures", "bridge");
const fixture = (name: string) => readFileSync(join(FIX, `${name}.json`), "utf8");

// A completed, healthy process outcome wrapping `stdout`.
const ok = (stdout: string) => ({ exitCode: 0, signalCode: null, stdout, stderr: "" });

// ---------------------------------------------------------------------------
// Envelope parsing per command — against committed REAL bridge stdout, no spawn.
// ---------------------------------------------------------------------------
describe("interpretBridgeOutcome — envelope parsing (committed fixtures)", () => {
  test("kind_info parses to a total table keyed by Kind with tagged primary_filename", () => {
    const r = interpretBridgeOutcome(ok(fixture("kind_info")), parseKindInfoTable);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.skill.primary_filename).toEqual({ kind: "fixed", value: "SKILL.md" });
    expect(r.data.codex_agent.primary_filename).toEqual({ kind: "templated", extension: "toml" });
    expect(r.data.codex_agent.allowed_targets).toEqual(["codex"]);
    expect(r.data.agent.supports_ref_files).toBe(true);
  });

  test("target_info parses to library Targets only (claude/pi/codex)", () => {
    const r = interpretBridgeOutcome(ok(fixture("target_info")), parseTargetInfo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.targets.map((t) => t.target)).toEqual(["claude", "pi", "codex"]);
  });

  test("list_primitives parses summaries with dirty + nullable author", () => {
    const r = interpretBridgeOutcome(ok(fixture("list_primitives")), parsePrimitiveSummaries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(4);
    const skill = r.data.find((p) => p.kind === "skill")!;
    expect(skill).toMatchObject({ name: "diagnose", dirty: false, author: "Ada Lovelace" });
    expect(r.data.find((p) => p.kind === "agent")!.author).toBeNull();
  });

  test("primitive_detail (skill) parses the md-tagged WorkingContent + metadata", () => {
    const r = interpretBridgeOutcome(ok(fixture("primitive_detail_skill")), parsePrimitiveDetail);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.working.kind).toBe("md");
    if (r.data.working.kind === "md") expect(r.data.working.frontmatter).toContain("display_name");
    expect(r.data.metadata.author).toBe("Ada Lovelace");
    expect(r.data.versions).toEqual([]);
    expect(r.data.current_version).toBeNull();
  });

  test("primitive_detail (codex_agent) parses the toml-tagged WorkingContent", () => {
    const r = interpretBridgeOutcome(ok(fixture("primitive_detail_codex_agent")), parsePrimitiveDetail);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.working.kind).toBe("toml");
    if (r.data.working.kind === "toml") expect(typeof r.data.working.text).toBe("string");
  });

  test("library_status parses marker/git fields with nullable git state", () => {
    const r = interpretBridgeOutcome(ok(fixture("library_status_valid")), parseLibraryStatus);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ is_valid: true, marker_exists: true, is_git_repo: false });
    expect(r.data.branch).toBeNull();
  });

  // Write-side fixtures: the SAME committed bytes the Rust goldens assert against
  // live core output. Parsing them here closes the loop — a serde rename breaks
  // both the Rust golden and this parse (drift-safe both ways).
  test("install_summary parses a clean install (installed outcome, no failures)", () => {
    const r = interpretBridgeOutcome(ok(fixture("install_summary")), parseInstallSummary);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.failures).toEqual([]);
    expect(r.data.successes[0]!.target).toBe("claude");
    expect(r.data.successes[0]!.outcome).toEqual({ kind: "installed", version: "v1" });
  });

  test("uninstall_summary parses a removed outcome", () => {
    const r = interpretBridgeOutcome(ok(fixture("uninstall_summary")), parseUninstallSummary);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.successes[0]!.outcome).toEqual({ kind: "removed" });
  });

  test("scan_drift parses a per-target DriftReport with a clean status", () => {
    const r = interpretBridgeOutcome(ok(fixture("scan_drift")), parseDriftReports);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]).toMatchObject({ kind: "skill", name: "diagnose", target: "claude" });
    expect(r.data[0]!.status).toEqual({ kind: "clean" });
  });

  test("list_installs parses the compact per-target projection", () => {
    const r = interpretBridgeOutcome(ok(fixture("list_installs")), parseInstalledTargets);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]).toEqual({
      target: "claude",
      installed_version: "v1",
      installed_at: "2026-04-30T12:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Application error passthrough (a valid ok:false envelope).
// ---------------------------------------------------------------------------
describe("interpretBridgeOutcome — application errors", () => {
  test("a valid ok:false envelope passes its code/message through verbatim", () => {
    const r = interpretBridgeOutcome(ok(fixture("error_marker_missing")), parsePrimitiveSummaries);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("library_marker_missing");
    expect(r.error.message).toBe("not a prompt-library directory");
  });
});

// ---------------------------------------------------------------------------
// Transport failures — distinct from application errors (two-layer model).
// ---------------------------------------------------------------------------
describe("interpretBridgeOutcome — transport failures", () => {
  const id = <T>(d: unknown) => d as T;

  test("a killed process (signalCode set, exitCode null) is bridge_timeout", () => {
    const r = interpretBridgeOutcome({ exitCode: null, signalCode: "SIGKILL", stdout: "", stderr: "" }, id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_timeout");
  });

  test("a non-zero exit (not killed) is bridge_command_failed", () => {
    const r = interpretBridgeOutcome({ exitCode: 3, signalCode: null, stdout: "", stderr: "boom" }, id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_command_failed");
  });

  test("unparseable stdout is bridge_bad_output", () => {
    const r = interpretBridgeOutcome(ok("not json at all"), id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_bad_output");
  });

  test("a protocol-version mismatch is bridge_bad_output", () => {
    const r = interpretBridgeOutcome(ok(JSON.stringify({ v: 2, ok: true, data: {} })), id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_bad_output");
  });

  test("a validator throw (TS interface lies) becomes bridge_bad_output, not undefined", () => {
    // valid envelope, but data fails the per-command shape check
    const bad = JSON.stringify({ v: 1, ok: true, data: { not: "a kind info table" } });
    const r = interpretBridgeOutcome(ok(bad), parseKindInfoTable);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_bad_output");
  });
});

// ---------------------------------------------------------------------------
// runBridge spawn path — exercised with on-the-fly fake bridge executables so
// the transport plumbing (stdin write, drain, exit/signal) is tested for real
// without depending on a Rust build.
// ---------------------------------------------------------------------------
describe("runBridge — spawn transport (fake bridge)", () => {
  function fakeBridge(body: string): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
    const path = join(dir, "bridge");
    // Always drain stdin first so our `stdin.end()` never EPIPEs the writer.
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
    chmodSync(path, 0o755);
    return { dir, path };
  }

  test("a non-absolute bridge path is rejected without spawning", async () => {
    const r = await runBridge("relative/bridge", "kind_info", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_command_failed");
  });

  test("a missing bridge binary is bridge_not_found", async () => {
    const r = await runBridge("/no/such/bridge/binary", "kind_info", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("bridge_not_found");
  });

  test("a fake bridge echoing a fixture round-trips to a typed result", async () => {
    const { dir, path } = fakeBridge(`cat '${join(FIX, "kind_info.json")}'`);
    try {
      const r = await runBridge(path, "kind_info", {}, { validate: parseKindInfoTable });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.skill.primary_filename).toEqual({ kind: "fixed", value: "SKILL.md" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fake bridge that exits non-zero is bridge_command_failed", async () => {
    const { dir, path } = fakeBridge(`echo boom >&2\nexit 3`);
    try {
      const r = await runBridge(path, "kind_info", {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("bridge_command_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hanging bridge is killed and reported as bridge_timeout", async () => {
    // `exec` so `sleep` REPLACES the shell (same pid that owns the stdout pipe).
    // Without it, SIGKILL to the shell orphans `sleep`, which keeps the pipe's
    // write-end open → the stdout drain blocks until sleep naturally exits,
    // racing the test runner's own 5s timeout. (A real single-process bridge has
    // no such child, so the watchdog kill closes stdout at once.)
    const { dir, path } = fakeBridge(`exec sleep 30`);
    try {
      const r = await runBridge(path, "kind_info", {}, { timeoutMs: 200 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("bridge_timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
