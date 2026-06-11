import { describe, test, expect } from "vitest";
import {
  filterPrimitives,
  groupByKind,
  selectionKey,
  parseSelection,
  dirtyCue,
  gitSummary,
  KIND_ORDER,
} from "./library";
import type { LibraryPrimitiveSummary, LibraryStatus } from "./api";

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
