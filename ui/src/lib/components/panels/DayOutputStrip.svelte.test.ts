// The per-day git-output cell shown in Burn. Now PROP-driven (fed by BurnPanel's
// single batch getBurnOutput fetch — no per-row network). ESTIMATED + hash-deduped.

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import DayOutputStrip from "./DayOutputStrip.svelte";
import type { DayOutputRow } from "../../api";

afterEach(() => { cleanup(); });

const row = (over: Partial<DayOutputRow> = {}): DayOutputRow => ({
  date: "2026-06-12", sessions: 11, commits: 51, insertions: 18015,
  deletions: 384, filesChanged: 60, fidelity: "estimated", ...over,
});

describe("DayOutputStrip", () => {
  test("renders deduped commits/LOC/files, badged estimated", () => {
    render(DayOutputStrip, { outcome: row() });
    expect(screen.getByText(/51 commits/)).toBeTruthy();
    expect(screen.getByText(/60 files/)).toBeTruthy();
    expect(screen.getByText(/est/i)).toBeTruthy();
  });

  test("a day with no ended sessions shows a worded state, not 0 commits", () => {
    render(DayOutputStrip, { outcome: row({ sessions: 0, commits: 0, insertions: 0, deletions: 0, filesChanged: 0 }) });
    expect(screen.getByText(/no ended sessions/i)).toBeTruthy();
    expect(screen.queryByText(/0 commits/)).toBeNull();
  });

  test("no data for the day renders nothing", () => {
    const { container } = render(DayOutputStrip, { outcome: undefined });
    expect(container.textContent?.trim()).toBe("");
  });
});
