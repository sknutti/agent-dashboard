import { expect, test, describe } from "bun:test";
import {
  BridgeShapeError,
  parseInstallSummary,
  parseUninstallSummary,
  parseDriftReports,
  parseInstalledTargets,
  parseImportResult,
  parseWorkingFileEntries,
  parseWorkingFileBytes,
} from "./library_models.ts";

// These parsers guard the WRITE-side process boundary. The load-bearing check
// is the tagged-enum discriminant (`kind`): a core serde rename must surface as
// a typed BridgeShapeError, never `undefined` deep in the conflict dialog. We
// exercise each variant + a renamed/dropped discriminant per enum with inline
// objects; the committed-fixture round-trip lives in library_bridge.test.ts.

describe("parseInstallSummary", () => {
  test("accepts every TargetOutcome variant (installed/no_op_identical/colliding_content)", () => {
    const summary = {
      successes: [
        { target: "claude", outcome: { kind: "installed", version: "v1" } },
        { target: "pi", outcome: { kind: "no_op_identical", version: "v1" } },
        {
          target: "codex",
          outcome: { kind: "colliding_content", version: "v1", conflicts: ["SKILL.md"] },
        },
      ],
      failures: [],
    };
    const r = parseInstallSummary(summary);
    expect(r.successes).toHaveLength(3);
    const collide = r.successes[2]!.outcome;
    expect(collide.kind).toBe("colliding_content");
    if (collide.kind === "colliding_content") expect(collide.conflicts).toEqual(["SKILL.md"]);
  });

  test("parses pre-flight failures (occupied_by_unexpected_kind / io / other)", () => {
    const summary = {
      successes: [],
      failures: [
        {
          target: "claude",
          reason: { kind: "occupied_by_unexpected_kind", path: "x", expected: "file", actual: "dir" },
        },
        { target: "pi", reason: { kind: "io", path: "y", message: "boom" } },
        { target: "codex", reason: { kind: "other", message: "nope" } },
      ],
    };
    const r = parseInstallSummary(summary);
    expect(r.failures.map((f) => f.reason.kind)).toEqual(["occupied_by_unexpected_kind", "io", "other"]);
  });

  test("rejects an unknown outcome discriminant (serde rename guard)", () => {
    const summary = {
      successes: [{ target: "claude", outcome: { kind: "content_collision", version: "v1" } }],
      failures: [],
    };
    expect(() => parseInstallSummary(summary)).toThrow(BridgeShapeError);
  });

  test("rejects a colliding_content missing its conflicts array", () => {
    const summary = {
      successes: [{ target: "claude", outcome: { kind: "colliding_content", version: "v1" } }],
      failures: [],
    };
    expect(() => parseInstallSummary(summary)).toThrow(BridgeShapeError);
  });

  test("rejects a top-level shape with no successes/failures arrays", () => {
    expect(() => parseInstallSummary({ successes: [] })).toThrow(BridgeShapeError);
    expect(() => parseInstallSummary({})).toThrow(BridgeShapeError);
    expect(() => parseInstallSummary(null)).toThrow(BridgeShapeError);
  });
});

describe("parseUninstallSummary", () => {
  test("accepts every UninstallOutcome variant (removed/not_installed/drifted)", () => {
    const summary = {
      successes: [
        { target: "claude", outcome: { kind: "removed" } },
        { target: "pi", outcome: { kind: "not_installed" } },
        { target: "codex", outcome: { kind: "drifted", conflicts: ["AGENTS.md"] } },
      ],
      failures: [],
    };
    const r = parseUninstallSummary(summary);
    expect(r.successes.map((s) => s.outcome.kind)).toEqual(["removed", "not_installed", "drifted"]);
    const drifted = r.successes[2]!.outcome;
    if (drifted.kind === "drifted") expect(drifted.conflicts).toEqual(["AGENTS.md"]);
  });

  test("rejects an unknown uninstall discriminant", () => {
    const summary = {
      successes: [{ target: "claude", outcome: { kind: "deleted" } }],
      failures: [],
    };
    expect(() => parseUninstallSummary(summary)).toThrow(BridgeShapeError);
  });
});

describe("parseDriftReports", () => {
  test("accepts every DriftStatus variant (clean/modified/missing)", () => {
    const reports = [
      { kind: "skill", name: "diagnose", target: "claude", status: { kind: "clean" } },
      { kind: "agent", name: "reviewer", target: "pi", status: { kind: "modified", conflicts: ["A"] } },
      { kind: "command", name: "deploy", target: "codex", status: { kind: "missing", missing: ["B"] } },
    ];
    const r = parseDriftReports(reports);
    expect(r).toHaveLength(3);
    expect(r[0]!.status.kind).toBe("clean");
    const mod = r[1]!.status;
    if (mod.kind === "modified") expect(mod.conflicts).toEqual(["A"]);
    const miss = r[2]!.status;
    if (miss.kind === "missing") expect(miss.missing).toEqual(["B"]);
  });

  test("the outer DriftReport.kind (PrimitiveKind) is distinct from the nested status.kind tag", () => {
    const r = parseDriftReports([
      { kind: "skill", name: "diagnose", target: "claude", status: { kind: "modified", conflicts: [] } },
    ]);
    expect(r[0]!.kind).toBe("skill");
    expect(r[0]!.status.kind).toBe("modified");
  });

  test("rejects an unknown drift status discriminant", () => {
    const reports = [{ kind: "skill", name: "x", target: "claude", status: { kind: "stale" } }];
    expect(() => parseDriftReports(reports)).toThrow(BridgeShapeError);
  });

  test("rejects an unknown primitive kind on the report", () => {
    const reports = [{ kind: "widget", name: "x", target: "claude", status: { kind: "clean" } }];
    expect(() => parseDriftReports(reports)).toThrow(BridgeShapeError);
  });

  test("an empty batch parses to an empty array (first-launch parity)", () => {
    expect(parseDriftReports([])).toEqual([]);
  });

  test("rejects a non-array", () => {
    expect(() => parseDriftReports({})).toThrow(BridgeShapeError);
  });
});

describe("parseInstalledTargets", () => {
  test("parses the compact per-target projection", () => {
    const targets = [
      { target: "claude", installed_version: "v1", installed_at: "2026-04-30T12:00:00Z" },
    ];
    const r = parseInstalledTargets(targets);
    expect(r[0]).toEqual({ target: "claude", installed_version: "v1", installed_at: "2026-04-30T12:00:00Z" });
  });

  test("an empty list parses to an empty array (nothing installed)", () => {
    expect(parseInstalledTargets([])).toEqual([]);
  });

  test("rejects a record missing installed_version", () => {
    expect(() =>
      parseInstalledTargets([{ target: "claude", installed_at: "2026-04-30T12:00:00Z" }]),
    ).toThrow(BridgeShapeError);
  });
});

describe("parseImportResult", () => {
  test("parses { imported: <count> }", () => {
    expect(parseImportResult({ imported: 119 })).toEqual({ imported: 119 });
  });

  test("rejects a non-number imported count", () => {
    expect(() => parseImportResult({ imported: "119" })).toThrow(BridgeShapeError);
    expect(() => parseImportResult({})).toThrow(BridgeShapeError);
  });
});

describe("parseWorkingFileEntries", () => {
  test("parses a primary-first list with both roles", () => {
    const entries = [
      { path: "SKILL.md", role: "primary", is_text: true, size_bytes: 13 },
      { path: "logo.bin", role: "ref", is_text: false, size_bytes: 4 },
      { path: "notes.md", role: "ref", is_text: true, size_bytes: 6 },
    ];
    const r = parseWorkingFileEntries(entries);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ path: "SKILL.md", role: "primary", is_text: true, size_bytes: 13 });
    expect(r[1]!.role).toBe("ref");
    expect(r[1]!.is_text).toBe(false);
  });

  test("an empty list parses to an empty array (absent working/base)", () => {
    expect(parseWorkingFileEntries([])).toEqual([]);
  });

  test("rejects an unknown role discriminant (serde rename guard)", () => {
    expect(() =>
      parseWorkingFileEntries([{ path: "x.md", role: "secondary", is_text: true, size_bytes: 1 }]),
    ).toThrow(BridgeShapeError);
  });

  test("rejects an entry missing a required field", () => {
    expect(() =>
      parseWorkingFileEntries([{ path: "x.md", role: "ref", is_text: true }]),
    ).toThrow(BridgeShapeError);
    expect(() => parseWorkingFileEntries({})).toThrow(BridgeShapeError);
  });
});

describe("parseWorkingFileBytes", () => {
  test("parses the text variant with a present extension", () => {
    expect(parseWorkingFileBytes({ kind: "text", text: "hello\n", ext: "md" })).toEqual({
      kind: "text",
      text: "hello\n",
      ext: "md",
    });
  });

  test("parses the text variant with a null extension (no dot in the path)", () => {
    expect(parseWorkingFileBytes({ kind: "text", text: "x", ext: null })).toEqual({
      kind: "text",
      text: "x",
      ext: null,
    });
  });

  test("parses the binary variant — size only, no bytes", () => {
    const r = parseWorkingFileBytes({ kind: "binary", size: 4 });
    expect(r).toEqual({ kind: "binary", size: 4 });
    if (r.kind === "binary") expect(r.size).toBe(4);
  });

  test("rejects an unknown kind discriminant (serde rename guard)", () => {
    expect(() => parseWorkingFileBytes({ kind: "utf8", text: "x", ext: null })).toThrow(
      BridgeShapeError,
    );
    expect(() => parseWorkingFileBytes({ text: "x" })).toThrow(BridgeShapeError);
  });

  test("rejects a text variant missing its text", () => {
    expect(() => parseWorkingFileBytes({ kind: "text", ext: "md" })).toThrow(BridgeShapeError);
  });
});
