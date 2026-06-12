import { describe, test, expect } from "vitest";
import {
  filterPrimitives,
  groupByKind,
  selectionKey,
  parseSelection,
  dirtyCue,
  editorDirtyCue,
  publishStateCue,
  metadataSaveCue,
  currentVersionCue,
  overlayCue,
  gitSummary,
  driftByTarget,
  installStateFor,
  stateCue,
  outcomeCue,
  uninstallCue,
  reimportResultCue,
  anyDrift,
  lifecycleCommitCue,
  renameInstallCaveat,
  deleteResultCue,
  importResultCue,
  KIND_ORDER,
} from "./library";
import type {
  LibraryPrimitiveSummary,
  LibraryStatus,
  LibraryDriftReport,
  LibraryInstalledTarget,
} from "./api";

const P = (kind: any, name: string, dirty = false): LibraryPrimitiveSummary => ({ kind, name, dirty, author: null });
const ITEMS: LibraryPrimitiveSummary[] = [
  P("skill", "diagnose"),
  P("skill", "browser-check", true),
  P("agent", "reviewer"),
  P("command", "deploy"),
  P("codex_agent", "code-gen"),
];

describe("filterPrimitives", () => {
  test("no query returns everything", () => {
    expect(filterPrimitives(ITEMS, "")).toHaveLength(5);
    expect(filterPrimitives(ITEMS, "   ")).toHaveLength(5);
  });
  test("case-insensitive substring match on name", () => {
    expect(filterPrimitives(ITEMS, "DIAG").map((p) => p.name)).toEqual(["diagnose"]);
    expect(filterPrimitives(ITEMS, "e").length).toBeGreaterThan(1);
  });
  test("no match yields an empty array", () => {
    expect(filterPrimitives(ITEMS, "zzz")).toEqual([]);
  });
});

describe("groupByKind", () => {
  test("groups in canonical Kind order, dropping empty groups", () => {
    const groups = groupByKind(ITEMS);
    expect(groups.map((g) => g.kind)).toEqual(["skill", "agent", "command", "codex_agent"]);
    expect(groups[0]!.items.map((p) => p.name)).toEqual(["diagnose", "browser-check"]);
    expect(groups[0]!.label).toBe("Skills");
  });
  test("an empty Kind is omitted, not rendered blank", () => {
    const groups = groupByKind([P("agent", "solo")]);
    expect(groups.map((g) => g.kind)).toEqual(["agent"]);
  });
  test("KIND_ORDER lists all four Kinds equally", () => {
    expect(KIND_ORDER).toEqual(["skill", "agent", "command", "codex_agent"]);
  });
});

describe("selectionKey / parseSelection", () => {
  test("round-trips kind + name", () => {
    expect(parseSelection(selectionKey("skill", "diagnose"))).toEqual({ kind: "skill", name: "diagnose" });
  });
  test("rejects an unknown kind or empty name", () => {
    expect(parseSelection("widget/x")).toBeNull();
    expect(parseSelection("skill/")).toBeNull();
    expect(parseSelection("nope")).toBeNull();
  });
});

describe("dirtyCue (colorblind-safe: never red/green-only)", () => {
  test("both states carry a text label AND a glyph, with no red/green tone", () => {
    const modified = dirtyCue(true);
    const pinned = dirtyCue(false);
    expect(modified.label).toBe("modified");
    expect(pinned.label).toBe("pinned");
    // a glyph always accompanies the label (not color-only)
    expect(modified.glyph.length).toBeGreaterThan(0);
    expect(pinned.glyph.length).toBeGreaterThan(0);
    // tone is never a bare red/green
    expect(["amber", "cyan", "default"]).toContain(modified.tone);
    expect(["amber", "cyan", "default"]).toContain(pinned.tone);
  });
});

describe("editorDirtyCue (distinct copy from dirtyCue; colorblind-safe)", () => {
  test("unsaved vs saved carry a label + glyph, never a bare red/green tone", () => {
    const unsaved = editorDirtyCue(true);
    const saved = editorDirtyCue(false);
    expect(unsaved.label).toBe("unsaved");
    expect(saved.label).toBe("saved");
    // distinct copy from the primitive-level dirtyCue (modified/pinned)
    expect(unsaved.label).not.toBe(dirtyCue(true).label);
    expect(unsaved.glyph.length).toBeGreaterThan(0);
    expect(saved.glyph.length).toBeGreaterThan(0);
    expect(["amber", "cyan", "default"]).toContain(unsaved.tone);
    expect(["amber", "cyan", "default"]).toContain(saved.tone);
  });
});

describe("publishStateCue (non-fatal commit contract; colorblind-safe)", () => {
  test("three distinct states distinguishable by label + glyph, never bare red/green", () => {
    const committed = publishStateCue(true, null);
    const failed = publishStateCue(false, "Author identity unknown");
    const noCommit = publishStateCue(false, null);
    // All three carry distinct labels.
    const labels = [committed.label, failed.label, noCommit.label];
    expect(new Set(labels).size).toBe(3);
    expect(committed.label).toBe("committed locally");
    // The commit-failed state is the only amber (attention) one.
    expect(failed.tone).toBe("amber");
    expect(committed.tone).not.toBe("amber");
    expect(noCommit.tone).not.toBe("amber");
    // Distinguishable WITHOUT color: every state has a non-empty glyph.
    for (const c of [committed, failed, noCommit]) {
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
    // "no commit" (non-git / nothing staged) is NOT styled as a failure.
    expect(noCommit.label).toBe("published");
  });
});

describe("metadataSaveCue (post-save commit state; colorblind-safe)", () => {
  test("three distinct states distinguishable by label + glyph, never bare red/green", () => {
    const committed = metadataSaveCue(true, null);
    const failed = metadataSaveCue(false, "Author identity unknown");
    const noCommit = metadataSaveCue(false, null);
    const labels = [committed.label, failed.label, noCommit.label];
    expect(new Set(labels).size).toBe(3);
    // The commit-failed state is the only amber (attention) one — it is NOT a
    // hard error; the edit landed, only the advisory git commit failed.
    expect(failed.tone).toBe("amber");
    expect(committed.tone).not.toBe("amber");
    expect(noCommit.tone).not.toBe("amber");
    for (const c of [committed, failed, noCommit]) {
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
    // A non-git library (no commit, no error) is a plain success, not a warning.
    expect(noCommit.label).toBe("saved");
  });
});

describe("currentVersionCue (current vs past; colorblind-safe)", () => {
  test("current vs past differ by label + glyph; current is cyan, never green", () => {
    const cur = currentVersionCue("v2", "v2");
    const past = currentVersionCue("v1", "v2");
    expect(cur.label).toBe("current");
    expect(past.label).toBe("past version");
    expect(cur.label).not.toBe(past.label);
    expect(cur.glyph).not.toBe(past.glyph); // distinguishable without color
    expect(cur.tone).toBe("cyan"); // CVD-safe accent, not green
    // A null current (no pin) reads everything as past.
    expect(currentVersionCue("v1", null).label).toBe("past version");
  });
});

describe("overlayCue (delta vs. base passthrough; colorblind-safe)", () => {
  test("overlay vs base differ by label + glyph; overlay is cyan, never green", () => {
    const overlay = overlayCue(true);
    const base = overlayCue(false);
    expect(overlay.label).toBe("overlay");
    expect(base.label).toBe("base (no overlay)");
    // The label makes "delta, not the full base file" explicit, not color-coded.
    expect(overlay.label).not.toBe(base.label);
    // Distinguishable WITHOUT color: distinct, non-empty glyphs.
    expect(overlay.glyph).not.toBe(base.glyph);
    expect(overlay.glyph.length).toBeGreaterThan(0);
    expect(base.glyph.length).toBeGreaterThan(0);
    // CVD-safe accent, never a bare red/green.
    expect(overlay.tone).toBe("cyan");
    expect(["amber", "cyan", "default"]).toContain(base.tone);
  });
});

describe("reimportResultCue (every variant visible + CVD-safe)", () => {
  test("reimported commit nuance: committed vs not-committed vs no-commit, none green", () => {
    const committed = reimportResultCue({ kind: "reimported", new_version: "v2", committed: true, commit_error: null });
    const failed = reimportResultCue({ kind: "reimported", new_version: "v2", committed: false, commit_error: "Author identity unknown" });
    const noCommit = reimportResultCue({ kind: "reimported", new_version: "v2", committed: false, commit_error: null });
    // Only the failed-commit case warns (amber); the others are plain success.
    expect(failed.tone).toBe("amber");
    expect(committed.tone).not.toBe("amber");
    expect(noCommit.tone).not.toBe("amber");
    for (const c of [committed, failed, noCommit]) {
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
  });

  test("every variant carries a non-empty label + glyph and a CVD-safe tone", () => {
    const cues = [
      reimportResultCue({ kind: "reimported", new_version: "v2", committed: true, commit_error: null }),
      reimportResultCue({ kind: "working_copy_dirty" }),
      reimportResultCue({ kind: "broken_source", primary_path: "SKILL.md", raw_bytes: [1], parse_error: "x" }),
      reimportResultCue({ kind: "not_installed" }),
      reimportResultCue({ kind: "install_missing" }),
    ];
    for (const c of cues) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone); // never a bare red/green
    }
  });

  test("the two interactive results are distinguishable by label (not color)", () => {
    const dirty = reimportResultCue({ kind: "working_copy_dirty" });
    const broken = reimportResultCue({ kind: "broken_source", primary_path: "SKILL.md", raw_bytes: [1], parse_error: "x" });
    // Both warn (amber), so color CANNOT disambiguate them — the label + glyph must.
    expect(dirty.label).not.toBe(broken.label);
    expect(dirty.glyph).not.toBe(broken.glyph);
  });
});

describe("gitSummary (text-only, CVD-safe)", () => {
  const base: LibraryStatus = {
    configured: true, is_valid: true, marker_exists: true,
    is_git_repo: true, branch: "main", dirty: false, unpushed: false,
  };
  test("non-git library reads as a plain status", () => {
    expect(gitSummary({ ...base, is_git_repo: false })).toBe("not a git repo");
  });
  test("clean repo shows branch · clean", () => {
    expect(gitSummary(base)).toBe("main · clean");
  });
  test("dirty + unpushed are spelled out in words", () => {
    const s = gitSummary({ ...base, dirty: true, unpushed: true });
    expect(s).toContain("uncommitted changes");
    expect(s).toContain("unpushed commits");
  });
  test("indeterminate git state (nulls) is not asserted as clean", () => {
    const s = gitSummary({ ...base, dirty: null, unpushed: null });
    expect(s).not.toContain("clean");
  });
});

// ── install / drift cues + selectors ────────────────────────────────────────

const report = (
  kind: any,
  name: string,
  target: any,
  status: LibraryDriftReport["status"],
): LibraryDriftReport => ({ kind, name, target, status });

const installed = (target: any, version = "v1"): LibraryInstalledTarget => ({
  target,
  installed_version: version,
  installed_at: "2026-04-30T12:00:00Z",
});

const CVD_TONES = ["amber", "cyan", "default"];

describe("driftByTarget", () => {
  const reports: LibraryDriftReport[] = [
    report("skill", "diagnose", "claude", { kind: "clean" }),
    report("skill", "diagnose", "pi", { kind: "modified", conflicts: ["SKILL.md"] }),
    report("agent", "reviewer", "claude", { kind: "missing", missing: ["AGENTS.md"] }),
  ];
  test("folds the batch into a per-target lookup scoped to one primitive", () => {
    const map = driftByTarget(reports, "skill", "diagnose");
    expect(map.get("claude")).toEqual({ kind: "clean" });
    expect(map.get("pi")).toEqual({ kind: "modified", conflicts: ["SKILL.md"] });
    // a different primitive's report is excluded
    expect(map.has("claude") && map.size).toBe(2);
  });
  test("an unrecorded primitive yields an empty map", () => {
    expect(driftByTarget(reports, "command", "deploy").size).toBe(0);
  });
});

describe("installStateFor", () => {
  const drift = driftByTarget(
    [
      report("skill", "diagnose", "claude", { kind: "clean" }),
      report("skill", "diagnose", "pi", { kind: "modified", conflicts: ["SKILL.md"] }),
      report("skill", "diagnose", "codex", { kind: "missing", missing: ["x"] }),
    ],
    "skill",
    "diagnose",
  );
  const inst = [installed("claude"), installed("pi"), installed("codex")];
  test("a target with no install record is not_installed", () => {
    expect(installStateFor("claude", [], new Map())).toBe("not_installed");
  });
  test("installed + clean drift is clean", () => {
    expect(installStateFor("claude", inst, drift)).toBe("clean");
  });
  test("installed + modified drift is modified", () => {
    expect(installStateFor("pi", inst, drift)).toBe("modified");
  });
  test("installed + missing drift is missing", () => {
    expect(installStateFor("codex", inst, drift)).toBe("missing");
  });
  test("installed with no drift report defaults to clean (defensive)", () => {
    expect(installStateFor("claude", [installed("claude")], new Map())).toBe("clean");
  });
});

describe("stateCue / outcomeCue / uninstallCue (colorblind-safe)", () => {
  test("every state cue carries label + glyph and a CVD-safe tone", () => {
    for (const s of ["not_installed", "clean", "modified", "missing"] as const) {
      const c = stateCue(s);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(CVD_TONES).toContain(c.tone);
    }
    // distinct labels — distinguishable without color
    const labels = (["not_installed", "clean", "modified", "missing"] as const).map((s) => stateCue(s).label);
    expect(new Set(labels).size).toBe(4);
  });

  test("a no-op install outcome has a visible 'already up to date' cue (not a silent no-op)", () => {
    const c = outcomeCue({ kind: "no_op_identical", version: "v1" });
    expect(c.label.toLowerCase()).toContain("up to date");
    expect(c.glyph.length).toBeGreaterThan(0);
  });
  test("a colliding_content outcome cues an overwrite need (amber, not red)", () => {
    const c = outcomeCue({ kind: "colliding_content", version: "v1", conflicts: ["x"] });
    expect(CVD_TONES).toContain(c.tone);
    expect(c.tone).not.toBe("default");
  });
  test("an installed outcome reads as installed", () => {
    expect(outcomeCue({ kind: "installed", version: "v1" }).label).toContain("installed");
  });

  test("uninstall outcomes each have a visible cue incl. the 'was not installed' no-op", () => {
    expect(uninstallCue({ kind: "removed" }).label).toContain("uninstalled");
    expect(uninstallCue({ kind: "not_installed" }).label.toLowerCase()).toContain("was not installed");
    const drifted = uninstallCue({ kind: "drifted", conflicts: ["x"] });
    expect(CVD_TONES).toContain(drifted.tone);
    expect(drifted.tone).not.toBe("default");
  });
});

describe("anyDrift (explorer badge — does any target of a primitive drift)", () => {
  const reports: LibraryDriftReport[] = [
    report("skill", "diagnose", "claude", { kind: "clean" }),
    report("skill", "diagnose", "pi", { kind: "modified", conflicts: ["x"] }),
    report("agent", "reviewer", "claude", { kind: "clean" }),
  ];
  test("true when at least one target is modified/missing", () => {
    expect(anyDrift(reports, "skill", "diagnose")).toBe(true);
  });
  test("false when every recorded target is clean", () => {
    expect(anyDrift(reports, "agent", "reviewer")).toBe(false);
  });
  test("false when the primitive has no records", () => {
    expect(anyDrift(reports, "command", "deploy")).toBe(false);
  });
});

describe("lifecycleCommitCue (post create/rename/duplicate commit state; CVD-safe)", () => {
  test("committed vs not-committed vs no-commit — only the failure warns, none green", () => {
    const committed = lifecycleCommitCue(true, null);
    const failed = lifecycleCommitCue(false, "Author identity unknown");
    const noCommit = lifecycleCommitCue(false, null);
    expect(failed.tone).toBe("amber");
    expect(committed.tone).not.toBe("amber");
    expect(noCommit.tone).not.toBe("amber");
    for (const c of [committed, failed, noCommit]) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
  });
});

describe("renameInstallCaveat (the 'installed copies keep the old name' note)", () => {
  test("null when nothing is installed (no caveat to show)", () => {
    expect(renameInstallCaveat(0)).toBeNull();
    expect(renameInstallCaveat(-1)).toBeNull();
  });
  test("singular vs plural phrasing carries the count", () => {
    expect(renameInstallCaveat(1)).toContain("1 installed copy keeps");
    expect(renameInstallCaveat(3)).toContain("3 installed copies keep");
  });
});

describe("deleteResultCue (never reads as flat success on a bail; CVD-safe)", () => {
  test("a bail (dir NOT removed) warns and says it was not deleted — never a success glyph", () => {
    const bailed = deleteResultCue(false, null);
    expect(bailed.tone).toBe("amber");
    expect(bailed.label.toLowerCase()).toContain("not deleted");
  });
  test("removed-but-commit-failed warns; clean delete is plain success; all CVD-safe", () => {
    const removedNoCommit = deleteResultCue(true, "no identity");
    const removed = deleteResultCue(true, null);
    expect(removedNoCommit.tone).toBe("amber");
    expect(removed.tone).not.toBe("amber");
    for (const c of [removedNoCommit, removed]) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
  });
  test("the bail and the clean-delete cues are distinguishable by LABEL, not just color", () => {
    expect(deleteResultCue(false, null).label).not.toBe(deleteResultCue(true, null).label);
  });
});

describe("importResultCue (every variant visible + CVD-safe)", () => {
  test("imported commit nuance: committed vs not-committed vs no-commit", () => {
    const committed = importResultCue({ kind: "imported", primitive_kind: "skill", name: "x", committed: true, commit_error: null });
    const failed = importResultCue({ kind: "imported", primitive_kind: "skill", name: "x", committed: false, commit_error: "e" });
    const noCommit = importResultCue({ kind: "imported", primitive_kind: "skill", name: "x", committed: false, commit_error: null });
    expect(failed.tone).toBe("amber");
    expect(committed.tone).not.toBe("amber");
    expect(noCommit.tone).not.toBe("amber");
  });
  test("every variant carries a non-empty label + glyph and a CVD-safe tone", () => {
    const cues = [
      importResultCue({ kind: "imported", primitive_kind: "skill", name: "x", committed: true, commit_error: null }),
      importResultCue({ kind: "already_exists", primitive_kind: "command", name: "y" }),
      importResultCue({ kind: "not_classifiable", reason: "outside a known root" }),
    ];
    for (const c of cues) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(["amber", "cyan", "default"]).toContain(c.tone);
    }
  });
  test("the three variants are distinguishable by label (not color)", () => {
    const imported = importResultCue({ kind: "imported", primitive_kind: "skill", name: "x", committed: true, commit_error: null });
    const exists = importResultCue({ kind: "already_exists", primitive_kind: "skill", name: "x" });
    const nope = importResultCue({ kind: "not_classifiable", reason: "r" });
    expect(new Set([imported.label, exists.label, nope.label]).size).toBe(3);
  });
});
