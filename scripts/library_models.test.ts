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
  parsePrimitiveVersionView,
  parsePublishResult,
  parseReimportResult,
  parseMetadataUpdateResult,
  parseTargetView,
  parseOverlayLists,
  parseSearchResults,
  parseDeletePrimitiveResult,
  parseRenamePrimitiveResult,
  parseDuplicatePrimitiveResult,
  parseImportFromPathResult,
  parseForgetResult,
  parseBootstrapScanResult,
  parseBootstrapSessionResult,
  parseBootstrapExecuteSummary,
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

describe("parseSearchResults", () => {
  test("parses a FindHit array (mirrors core's find::FindHit)", () => {
    const hits = [
      { kind: "skill" as const, name: "diagnose", line_number: 4, line_text: "needle here" },
      { kind: "command" as const, name: "review", line_number: 1, line_text: "find me" },
    ];
    expect(parseSearchResults(hits)).toEqual(hits);
  });

  test("an empty result set parses to an empty array", () => {
    expect(parseSearchResults([])).toEqual([]);
  });

  test("rejects an element missing line_number", () => {
    expect(() =>
      parseSearchResults([{ kind: "skill", name: "diagnose", line_text: "x" }]),
    ).toThrow(BridgeShapeError);
  });

  test("rejects a non-number line_number", () => {
    expect(() =>
      parseSearchResults([{ kind: "skill", name: "diagnose", line_number: "4", line_text: "x" }]),
    ).toThrow(BridgeShapeError);
  });

  test("rejects an unknown kind discriminant", () => {
    expect(() =>
      parseSearchResults([{ kind: "widget", name: "diagnose", line_number: 4, line_text: "x" }]),
    ).toThrow(BridgeShapeError);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseSearchResults({})).toThrow(BridgeShapeError);
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

describe("parsePrimitiveVersionView (frozen version inspector)", () => {
  test("parses an md working content + metadata with notes", () => {
    const v = parsePrimitiveVersionView({
      working: { kind: "md", frontmatter: "", body: "body-v1\n" },
      metadata: { created_at: "2026-04-30T12:00:00Z", notes: "first publish" },
    });
    expect(v.working).toEqual({ kind: "md", frontmatter: "", body: "body-v1\n" });
    expect(v.metadata).toEqual({ created_at: "2026-04-30T12:00:00Z", notes: "first publish" });
  });

  test("parses a toml working content + metadata without notes (skip_serializing_if=None)", () => {
    const v = parsePrimitiveVersionView({
      working: { kind: "toml", text: "x = 1\n" },
      metadata: { created_at: "2026-04-30T12:00:00Z" },
    });
    expect(v.working).toEqual({ kind: "toml", text: "x = 1\n" });
    expect(v.metadata.notes).toBeUndefined();
  });

  test("tolerates an explicit null notes (treated as absent)", () => {
    const v = parsePrimitiveVersionView({
      working: { kind: "md", frontmatter: "", body: "b" },
      metadata: { created_at: "2026-04-30T12:00:00Z", notes: null },
    });
    expect(v.metadata.notes).toBeUndefined();
  });

  test("rejects an unknown working-content discriminant (serde rename guard)", () => {
    expect(() =>
      parsePrimitiveVersionView({
        working: { kind: "markdown", frontmatter: "", body: "b" },
        metadata: { created_at: "t" },
      }),
    ).toThrow(BridgeShapeError);
  });

  test("rejects metadata missing created_at", () => {
    expect(() =>
      parsePrimitiveVersionView({ working: { kind: "toml", text: "" }, metadata: {} }),
    ).toThrow(BridgeShapeError);
  });
});

describe("parsePublishResult (non-fatal commit contract)", () => {
  test("a successful commit → committed:true, commit_error:null", () => {
    expect(parsePublishResult({ committed: true, commit_error: null })).toEqual({
      committed: true,
      commit_error: null,
    });
  });

  test("a failed commit → committed:false carrying the legible git message", () => {
    const r = parsePublishResult({ committed: false, commit_error: "Author identity unknown" });
    expect(r.committed).toBe(false);
    expect(r.commit_error).toBe("Author identity unknown");
  });

  test("a no-op / non-git commit → committed:false, commit_error:null", () => {
    expect(parsePublishResult({ committed: false, commit_error: null })).toEqual({
      committed: false,
      commit_error: null,
    });
  });

  test("rejects a missing committed flag, or a non-string/non-null commit_error", () => {
    expect(() => parsePublishResult({ commit_error: null })).toThrow(BridgeShapeError);
    expect(() => parsePublishResult({ committed: true, commit_error: 5 })).toThrow(BridgeShapeError);
    expect(() => parsePublishResult(null)).toThrow(BridgeShapeError);
  });
});

describe("parseMetadataUpdateResult (metadata + non-fatal commit contract)", () => {
  test("a successful edit → the written metadata + committed:true", () => {
    const r = parseMetadataUpdateResult({
      metadata: { allowed_targets: ["claude", "pi"], created_at: "2026-04-30T12:00:00Z", display_name: "Diag", author: "Alice" },
      committed: true,
      commit_error: null,
    });
    expect(r.committed).toBe(true);
    expect(r.commit_error).toBeNull();
    expect(r.metadata).toEqual({
      allowed_targets: ["claude", "pi"],
      created_at: "2026-04-30T12:00:00Z",
      display_name: "Diag",
      author: "Alice",
    });
  });

  test("a cleared field is simply absent in the metadata (skip_serializing_if None)", () => {
    const r = parseMetadataUpdateResult({
      metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z" },
      committed: false,
      commit_error: null,
    });
    expect(r.metadata.display_name).toBeUndefined();
    expect(r.metadata.author).toBeUndefined();
  });

  test("a failed commit → committed:false carrying the legible git message; the write still rode back", () => {
    const r = parseMetadataUpdateResult({
      metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z" },
      committed: false,
      commit_error: "Author identity unknown",
    });
    expect(r.committed).toBe(false);
    expect(r.commit_error).toBe("Author identity unknown");
    expect(r.metadata.allowed_targets).toEqual(["claude"]);
  });

  test("rejects a missing metadata, a missing committed flag, or a non-string/non-null commit_error", () => {
    expect(() => parseMetadataUpdateResult({ committed: true, commit_error: null })).toThrow(BridgeShapeError);
    expect(() =>
      parseMetadataUpdateResult({ metadata: { allowed_targets: [], created_at: "x" }, commit_error: null }),
    ).toThrow(BridgeShapeError);
    expect(() =>
      parseMetadataUpdateResult({ metadata: { allowed_targets: [], created_at: "x" }, committed: true, commit_error: 5 }),
    ).toThrow(BridgeShapeError);
    expect(() => parseMetadataUpdateResult(null)).toThrow(BridgeShapeError);
  });
});

describe("parseTargetView (merged primary for a target)", () => {
  test("parses an md merged view with an overlay present", () => {
    const v = parseTargetView({
      working: { kind: "md", frontmatter: "", body: "claude-only\n" },
      has_overlay: true,
    });
    expect(v.working).toEqual({ kind: "md", frontmatter: "", body: "claude-only\n" });
    expect(v.has_overlay).toBe(true);
  });

  test("parses a base passthrough (has_overlay:false)", () => {
    const v = parseTargetView({ working: { kind: "toml", text: "x = 1\n" }, has_overlay: false });
    expect(v.has_overlay).toBe(false);
  });

  test("rejects a non-boolean has_overlay", () => {
    expect(() =>
      parseTargetView({ working: { kind: "md", frontmatter: "", body: "b" }, has_overlay: "yes" }),
    ).toThrow(BridgeShapeError);
  });

  test("rejects an unknown working-content discriminant (serde rename guard)", () => {
    expect(() =>
      parseTargetView({ working: { kind: "markdown", frontmatter: "", body: "b" }, has_overlay: true }),
    ).toThrow(BridgeShapeError);
  });
});

describe("parseOverlayLists (per-target overlay surface)", () => {
  test("parses a list of target → sorted paths", () => {
    const v = parseOverlayLists([
      { target: "claude", paths: ["SKILL.md"] },
      { target: "pi", paths: ["SKILL.md", "ref/extra.md"] },
    ]);
    expect(v).toEqual([
      { target: "claude", paths: ["SKILL.md"] },
      { target: "pi", paths: ["SKILL.md", "ref/extra.md"] },
    ]);
  });

  test("parses the empty list (no overlays)", () => {
    expect(parseOverlayLists([])).toEqual([]);
  });

  test("rejects an unknown target value (closed-enum guard)", () => {
    expect(() => parseOverlayLists([{ target: "antigravity", paths: [] }])).toThrow(BridgeShapeError);
  });

  test("rejects a non-array paths field", () => {
    expect(() => parseOverlayLists([{ target: "claude", paths: "SKILL.md" }])).toThrow(BridgeShapeError);
  });

  test("rejects a non-array top level", () => {
    expect(() => parseOverlayLists({ target: "claude", paths: [] })).toThrow(BridgeShapeError);
  });
});

describe("parseReimportResult (tagged union — every variant rides the ok envelope)", () => {
  test("reimported carries the new label + the non-fatal commit contract", () => {
    expect(
      parseReimportResult({ kind: "reimported", new_version: "v2", committed: true, commit_error: null }),
    ).toEqual({ kind: "reimported", new_version: "v2", committed: true, commit_error: null });
  });

  test("reimported with a commit failure → committed:false carrying the git message", () => {
    const r = parseReimportResult({
      kind: "reimported",
      new_version: "v3",
      committed: false,
      commit_error: "Author identity unknown",
    });
    expect(r).toMatchObject({ kind: "reimported", committed: false, commit_error: "Author identity unknown" });
  });

  test("working_copy_dirty is a bare tagged variant", () => {
    expect(parseReimportResult({ kind: "working_copy_dirty" })).toEqual({ kind: "working_copy_dirty" });
  });

  test("broken_source carries the primary path, raw bytes, and parse error", () => {
    expect(
      parseReimportResult({
        kind: "broken_source",
        primary_path: "SKILL.md",
        raw_bytes: [110, 111, 112],
        parse_error: "missing frontmatter",
      }),
    ).toEqual({
      kind: "broken_source",
      primary_path: "SKILL.md",
      raw_bytes: [110, 111, 112],
      parse_error: "missing frontmatter",
    });
  });

  test("not_installed / install_missing are bare tagged variants", () => {
    expect(parseReimportResult({ kind: "not_installed" })).toEqual({ kind: "not_installed" });
    expect(parseReimportResult({ kind: "install_missing" })).toEqual({ kind: "install_missing" });
  });

  test("an unknown discriminant throws (a core serde rename must not surface as undefined)", () => {
    expect(() => parseReimportResult({ kind: "reimagined" })).toThrow(BridgeShapeError);
    expect(() => parseReimportResult(null)).toThrow(BridgeShapeError);
  });

  test("rejects a reimported missing its commit fields, or broken_source with non-numeric bytes", () => {
    expect(() => parseReimportResult({ kind: "reimported", new_version: "v2" })).toThrow(BridgeShapeError);
    expect(() =>
      parseReimportResult({ kind: "broken_source", primary_path: "SKILL.md", raw_bytes: ["x"], parse_error: "e" }),
    ).toThrow(BridgeShapeError);
  });
});

// ---------------------------------------------------------------------------
// Primitive-lifecycle parsers (lifecycle slice)
// ---------------------------------------------------------------------------

describe("parseDeletePrimitiveResult", () => {
  test("round-trips the nested uninstall summary + dir-removed + commit fields", () => {
    const v = {
      uninstall: { successes: [{ target: "claude", outcome: { kind: "removed" } }], failures: [] },
      library_dir_removed: true,
      committed: true,
      commit_error: null,
    };
    const r = parseDeletePrimitiveResult(v);
    expect(r.library_dir_removed).toBe(true);
    expect(r.uninstall.successes[0]!.outcome.kind).toBe("removed");
    expect(r.committed).toBe(true);
  });

  test("a bailed delete carries the failures + library_dir_removed:false", () => {
    const r = parseDeletePrimitiveResult({
      uninstall: { successes: [], failures: [{ target: "claude", reason: { kind: "io", path: "p", message: "ENOTDIR" } }] },
      library_dir_removed: false,
      committed: false,
      commit_error: null,
    });
    expect(r.library_dir_removed).toBe(false);
    expect(r.uninstall.failures).toHaveLength(1);
  });

  test("rejects a non-boolean library_dir_removed or a missing uninstall block", () => {
    expect(() =>
      parseDeletePrimitiveResult({ uninstall: { successes: [], failures: [] }, library_dir_removed: "yes", committed: true, commit_error: null }),
    ).toThrow(BridgeShapeError);
    expect(() => parseDeletePrimitiveResult({ library_dir_removed: true, committed: true, commit_error: null })).toThrow(BridgeShapeError);
    expect(() => parseDeletePrimitiveResult(null)).toThrow(BridgeShapeError);
  });
});

describe("parseRenamePrimitiveResult", () => {
  test("round-trips the install-records-updated count + commit fields", () => {
    expect(parseRenamePrimitiveResult({ install_records_updated: 3, committed: true, commit_error: null })).toEqual({
      install_records_updated: 3,
      committed: true,
      commit_error: null,
    });
  });

  test("rejects a non-numeric count", () => {
    expect(() => parseRenamePrimitiveResult({ install_records_updated: "3", committed: true, commit_error: null })).toThrow(BridgeShapeError);
    expect(() => parseRenamePrimitiveResult({})).toThrow(BridgeShapeError);
  });
});

describe("parseDuplicatePrimitiveResult", () => {
  test("round-trips the new name + commit fields", () => {
    expect(parseDuplicatePrimitiveResult({ new_name: "diagnose-copy", committed: false, commit_error: "no identity" })).toEqual({
      new_name: "diagnose-copy",
      committed: false,
      commit_error: "no identity",
    });
  });

  test("rejects a missing new_name", () => {
    expect(() => parseDuplicatePrimitiveResult({ committed: true, commit_error: null })).toThrow(BridgeShapeError);
  });
});

describe("parseImportFromPathResult (tagged union — every variant rides the ok envelope)", () => {
  test("imported carries kind + name + the commit contract", () => {
    expect(
      parseImportFromPathResult({ kind: "imported", primitive_kind: "skill", name: "diagnose", committed: true, commit_error: null }),
    ).toEqual({ kind: "imported", primitive_kind: "skill", name: "diagnose", committed: true, commit_error: null });
  });

  test("already_exists carries kind + name, no commit fields", () => {
    expect(parseImportFromPathResult({ kind: "already_exists", primitive_kind: "command", name: "review" })).toEqual({
      kind: "already_exists",
      primitive_kind: "command",
      name: "review",
    });
  });

  test("not_classifiable carries the reason", () => {
    expect(parseImportFromPathResult({ kind: "not_classifiable", reason: "not under a known root" })).toEqual({
      kind: "not_classifiable",
      reason: "not under a known root",
    });
  });

  test("an unknown discriminant or a bad primitive_kind throws", () => {
    expect(() => parseImportFromPathResult({ kind: "teleported" })).toThrow(BridgeShapeError);
    expect(() => parseImportFromPathResult({ kind: "imported", primitive_kind: "wizard", name: "x", committed: true, commit_error: null })).toThrow(BridgeShapeError);
    expect(() => parseImportFromPathResult(null)).toThrow(BridgeShapeError);
  });
});

describe("parseForgetResult", () => {
  test("round-trips the removed flag", () => {
    expect(parseForgetResult({ removed: true })).toEqual({ removed: true });
    expect(parseForgetResult({ removed: false })).toEqual({ removed: false });
  });

  test("rejects a non-boolean removed", () => {
    expect(() => parseForgetResult({ removed: "yes" })).toThrow(BridgeShapeError);
    expect(() => parseForgetResult({})).toThrow(BridgeShapeError);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap-discovery parsers (bootstrap slice). The load-bearing checks: the
// externally-tagged Classification (`"AlreadyImported"` vs `{New|Drifted:…}`),
// the recomputed summary, the verbatim-`raw`-preserved plan/session (round-trip
// to execute untouched), and the un-renamed `WorkingCopyDirty`/`InstallMissing`
// skip reason (NOT snake_case — a serde rename would break the cue mapping).
// ---------------------------------------------------------------------------

const SCAN = {
  cross_referenced: {
    groups: [
      { kind: "skill", name: "newskill", classification: { New: { content: { hash: "h1" } } } },
      { kind: "skill", name: "diagnose", classification: { Drifted: { content: { hash: "h2" }, drifted_targets: ["claude"] } } },
      { kind: "agent", name: "old", classification: "AlreadyImported" },
    ],
    needs_manual_review: [{ kind: "command", name: "weird", members: [] }],
    symlinked: [{ kind: "skill", name: "linked" }],
    unclassified: [],
  },
  plan: {
    creates: [{ kind: "skill", name: "newskill", base: { target: "claude" }, overlays: [] }],
    reimports: [{ kind: "skill", name: "diagnose", base: { target: "claude" } }],
  },
};

describe("parseBootstrapScanResult", () => {
  test("parses the classification tags and recomputes the banner summary", () => {
    const r = parseBootstrapScanResult(SCAN);
    expect(r.crossReferenced.groups.map((g) => [g.kind, g.name, g.classification])).toEqual([
      ["skill", "newskill", "new"],
      ["skill", "diagnose", "drifted"],
      ["agent", "old", "already_imported"],
    ]);
    // summary is recomputed (the serialized CrossReferenced omits summary()).
    expect(r.crossReferenced.summary).toEqual({
      new: 1,
      already_imported: 1,
      drifted: 1,
      needs_manual_review: 1,
    });
    expect(r.crossReferenced.symlinked).toBe(1);
    expect(r.crossReferenced.unclassified).toBe(0);
    expect(r.crossReferenced.needs_manual_review).toEqual([{ kind: "command", name: "weird" }]);
  });

  test("surfaces which targets drifted so the wizard can name the overlay", () => {
    const r = parseBootstrapScanResult(SCAN);
    const drifted = r.crossReferenced.groups.find((g) => g.name === "diagnose");
    expect(drifted?.driftedTargets).toEqual(["claude"]);
    // Non-drifted groups carry no drifted targets.
    expect(r.crossReferenced.groups.find((g) => g.name === "newskill")?.driftedTargets).toEqual([]);
    expect(r.crossReferenced.groups.find((g) => g.name === "old")?.driftedTargets).toEqual([]);
  });

  test("lifts kind/name for display but preserves the verbatim action object for re-send", () => {
    const r = parseBootstrapScanResult(SCAN);
    expect(r.plan.creates[0]).toEqual({
      kind: "skill",
      name: "newskill",
      raw: { kind: "skill", name: "newskill", base: { target: "claude" }, overlays: [] },
    });
    // `raw` is the EXACT object the bridge returned — the base/overlays the wizard
    // must round-trip back to execute, not drop.
    expect(r.plan.reimports[0]!.raw).toEqual({ kind: "skill", name: "diagnose", base: { target: "claude" } });
  });

  test("rejects a renamed/dropped Classification discriminant (a serde drift tripwire)", () => {
    const bad = { ...SCAN, cross_referenced: { ...SCAN.cross_referenced, groups: [{ kind: "skill", name: "x", classification: { Renamed: {} } }] } };
    expect(() => parseBootstrapScanResult(bad)).toThrow(BridgeShapeError);
    expect(() => parseBootstrapScanResult({ cross_referenced: SCAN.cross_referenced })).toThrow(BridgeShapeError); // no plan
    expect(() => parseBootstrapScanResult(null)).toThrow(BridgeShapeError);
  });
});

describe("parseBootstrapSessionResult", () => {
  const SESSION = {
    format_version: 2,
    started_at: "2026-06-12T00:00:00Z",
    backup_taken: true,
    excluded_ids: ["skill/foo"],
    completed: [],
  };

  test("an absent session is a legitimate null (the first-run state), not a failure", () => {
    expect(parseBootstrapSessionResult({ session: null })).toBeNull();
  });

  test("lifts startedAt/formatVersion but preserves the verbatim session for re-send", () => {
    const r = parseBootstrapSessionResult({ session: SESSION });
    expect(r).not.toBeNull();
    expect(r!.formatVersion).toBe(2);
    expect(r!.startedAt).toBe("2026-06-12T00:00:00Z");
    // the whole session round-trips back to execute as `resume` untouched.
    expect(r!.raw).toEqual(SESSION);
  });

  test("rejects a malformed envelope / session", () => {
    expect(() => parseBootstrapSessionResult(null)).toThrow(BridgeShapeError);
    expect(() => parseBootstrapSessionResult({ session: { started_at: "x" } })).toThrow(BridgeShapeError); // no format_version
  });
});

describe("parseBootstrapExecuteSummary", () => {
  test("a clean run parses created/reimported + the committed gating fields", () => {
    const r = parseBootstrapExecuteSummary({
      backup_path: "/data/backups/ts.tar.gz",
      created: 2,
      reimported: 1,
      skipped: 0,
      skipped_items: [],
      committed: true,
      commit_error: null,
    });
    expect(r).toEqual({
      backup_path: "/data/backups/ts.tar.gz",
      created: 2,
      reimported: 1,
      skipped: 0,
      skipped_items: [],
      reconciled: 0,
      committed: true,
      commit_error: null,
    });
  });

  test("reconciled rides the summary; absent on an older bridge defaults to 0", () => {
    const present = parseBootstrapExecuteSummary({
      backup_path: null,
      created: 0,
      reimported: 0,
      skipped: 0,
      skipped_items: [],
      reconciled: 2,
    });
    expect(present.reconciled).toBe(2);

    const absent = parseBootstrapExecuteSummary({
      backup_path: null,
      created: 0,
      reimported: 0,
      skipped: 0,
      skipped_items: [],
    });
    expect(absent.reconciled).toBe(0);
  });

  test("a skipped item rides the summary with its verbatim Rust skip-reason (no serde rename)", () => {
    const r = parseBootstrapExecuteSummary({
      backup_path: null,
      created: 0,
      reimported: 0,
      skipped: 2,
      skipped_items: [
        { kind: "skill", name: "a", source_target: "claude", reason: "WorkingCopyDirty" },
        { kind: "agent", name: "b", source_target: "pi", reason: "InstallMissing" },
      ],
      // gating: an all-skipped run wrote nothing → no commit fields on the wire.
    });
    expect(r.skipped_items[0]).toEqual({ kind: "skill", name: "a", source_target: "claude", reason: "WorkingCopyDirty" });
    expect(r.skipped_items[1]!.reason).toBe("InstallMissing");
    // absent commit fields collapse to null, NOT a parse failure.
    expect(r.committed).toBeNull();
    expect(r.commit_error).toBeNull();
    expect(r.backup_path).toBeNull();
  });

  test("rejects an unknown skip reason (a serde rename tripwire) and a non-array skipped_items", () => {
    expect(() =>
      parseBootstrapExecuteSummary({
        backup_path: null,
        created: 0,
        reimported: 0,
        skipped: 1,
        skipped_items: [{ kind: "skill", name: "a", source_target: "claude", reason: "working_copy_dirty" }],
      }),
    ).toThrow(BridgeShapeError); // snake_case is NOT the wire shape — must be WorkingCopyDirty
    expect(() => parseBootstrapExecuteSummary({ created: 0, reimported: 0, skipped: 0, skipped_items: null })).toThrow(
      BridgeShapeError,
    );
  });
});

// --- Git remote sync parsers (Slice 8) -------------------------------------
import {
  parseRemoteStatus,
  parseScanFindings,
  parseUnpushedCount,
  parsePullPaused,
  parsePullResult,
  parseContinueResult,
  parseConflictList,
  parseConflictBlob,
  parseConfiguredRemote,
} from "./library_models.ts";

describe("git-sync parsers (Slice 8)", () => {
  test("parseRemoteStatus reads url + redacted pat, both nullable", () => {
    expect(parseRemoteStatus({ remote_url: "https://github.com/o/r", pat_redacted: "ghp_••••••••6789" })).toEqual({
      remote_url: "https://github.com/o/r",
      pat_redacted: "ghp_••••••••6789",
    });
    expect(parseRemoteStatus({ remote_url: null, pat_redacted: null })).toEqual({
      remote_url: null,
      pat_redacted: null,
    });
  });

  test("parseConfiguredRemote reads the normalized url", () => {
    expect(parseConfiguredRemote({ remote_url: "https://github.com/o/r" })).toEqual({
      remote_url: "https://github.com/o/r",
    });
    expect(() => parseConfiguredRemote({})).toThrow(BridgeShapeError);
  });

  test("parseScanFindings reads the findings array with verbatim matched bytes", () => {
    const out = parseScanFindings({
      findings: [{ path: "CLAUDE.md", line: 1, kind: "github_classic_pat", matched: "ghp_xxx" }],
    });
    expect(out).toEqual([{ path: "CLAUDE.md", line: 1, kind: "github_classic_pat", matched: "ghp_xxx" }]);
    expect(parseScanFindings({ findings: [] })).toEqual([]);
  });

  test("parseUnpushedCount + parsePullPaused read their scalars", () => {
    expect(parseUnpushedCount({ count: 3 })).toEqual({ count: 3 });
    expect(parsePullPaused({ paused: true })).toEqual({ paused: true });
  });

  test("parsePullResult routes ok vs conflict", () => {
    expect(parsePullResult({ outcome: "ok" })).toEqual({ outcome: "ok" });
    expect(parsePullResult({ outcome: "conflict", conflict_count: 2 })).toEqual({
      outcome: "conflict",
      conflict_count: 2,
    });
    expect(() => parsePullResult({ outcome: "weird" })).toThrow(BridgeShapeError);
  });

  test("parseContinueResult routes done vs still_conflicted", () => {
    expect(parseContinueResult({ outcome: "done" })).toEqual({ outcome: "done" });
    expect(parseContinueResult({ outcome: "still_conflicted", conflict_count: 1 })).toEqual({
      outcome: "still_conflicted",
      conflict_count: 1,
    });
  });

  test("parseConflictList classifies and rejects an unknown kind", () => {
    expect(
      parseConflictList({
        conflicts: [
          { path: "skills/x/current.txt", kind: "current_txt" },
          { path: "README.md", kind: "other" },
        ],
      }),
    ).toEqual([
      { path: "skills/x/current.txt", kind: "current_txt" },
      { path: "README.md", kind: "other" },
    ]);
    expect(() => parseConflictList({ conflicts: [{ path: "x", kind: "bogus" }] })).toThrow(BridgeShapeError);
  });

  test("parseConflictBlob reads content or null", () => {
    expect(parseConflictBlob({ content: "local-change\n" })).toEqual({ content: "local-change\n" });
    expect(parseConflictBlob({ content: null })).toEqual({ content: null });
  });
});
