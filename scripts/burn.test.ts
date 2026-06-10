import { expect, test, describe } from "bun:test";
import { mergeBurnByDate, type BurnRow } from "./burn.ts";

const row = (p: Partial<BurnRow> & { date: string; agent: string }): BurnRow => ({
  tokens: 0,
  cost_usd: null,
  cost_estimated_usd: null,
  ...p,
});

describe("mergeBurnByDate", () => {
  test("OTEL native overlay wins over a partial print-mode JSONL cost (the headline bug)", () => {
    // A `claude -p` print session stamped $0.42 into burn_daily; OTEL holds the
    // day's full $35. The old fold returned $0.42; the correct answer is $35.
    const rows = [row({ date: "2026-06-10", agent: "claude_code", tokens: 1000, cost_usd: 0.42 })];
    const [d] = mergeBurnByDate(rows, new Map([["2026-06-10", 35]]));
    expect(d!.nativeUsd).toBe(35);
  });

  test("Pi native does NOT suppress Claude's OTEL overlay on the same date", () => {
    // agent=all: Pi spent $0.01 and Claude has $35 of OTEL. Old code saw a
    // non-null day total and dropped the OTEL → $0.01. Correct = 35.01.
    const rows = [
      row({ date: "2026-06-10", agent: "pi", tokens: 500, cost_usd: 0.01 }),
      row({ date: "2026-06-10", agent: "claude_code", tokens: 1000, cost_usd: 0.42 }),
    ];
    const [d] = mergeBurnByDate(rows, new Map([["2026-06-10", 35]]));
    expect(d!.nativeUsd).toBeCloseTo(35.01, 10);
  });

  test("Pi native is preserved when there is no Claude OTEL", () => {
    const rows = [row({ date: "2026-06-10", agent: "pi", tokens: 500, cost_usd: 8.35 })];
    const [d] = mergeBurnByDate(rows, new Map());
    expect(d!.nativeUsd).toBe(8.35);
  });

  test("Claude print-mode JSONL is used when OTEL is absent (telemetry off)", () => {
    const rows = [row({ date: "2026-06-10", agent: "claude_code", tokens: 1000, cost_usd: 0.42 })];
    const [d] = mergeBurnByDate(rows, new Map());
    expect(d!.nativeUsd).toBe(0.42);
  });

  test("native stays null when no source has it (→ renders '—', never $0)", () => {
    const rows = [row({ date: "2026-06-10", agent: "antigravity", tokens: 1000 })];
    const [d] = mergeBurnByDate(rows, new Map());
    expect(d!.nativeUsd).toBeNull();
  });

  test("estimated is additive across agents and null-preserving", () => {
    const rows = [
      row({ date: "2026-06-10", agent: "codex", tokens: 100, cost_estimated_usd: 1.5 }),
      row({ date: "2026-06-10", agent: "pi", tokens: 200, cost_estimated_usd: 2.25 }),
      row({ date: "2026-06-11", agent: "antigravity", tokens: 300 }), // unpriced
    ];
    const out = mergeBurnByDate(rows, new Map());
    expect(out.find((d) => d.date === "2026-06-10")!.estUsd).toBeCloseTo(3.75, 10);
    expect(out.find((d) => d.date === "2026-06-11")!.estUsd).toBeNull();
  });

  test("a date with OTEL native but no burn_daily row still surfaces", () => {
    const out = mergeBurnByDate([], new Map([["2026-06-09", 12.5]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-06-09", tokens: 0, nativeUsd: 12.5, estUsd: null });
  });

  test("tokens sum across agents per date; output is date-sorted", () => {
    const rows = [
      row({ date: "2026-06-11", agent: "pi", tokens: 5 }),
      row({ date: "2026-06-10", agent: "codex", tokens: 3 }),
      row({ date: "2026-06-10", agent: "claude_code", tokens: 7 }),
    ];
    const out = mergeBurnByDate(rows, new Map());
    expect(out.map((d) => d.date)).toEqual(["2026-06-10", "2026-06-11"]);
    expect(out[0]!.tokens).toBe(10);
  });
});
