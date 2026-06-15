// The per-day git-output cell shown in Burn when a day is expanded. Pairs with the
// row's estimated cost. ESTIMATED + hash-deduped; mocks getBurnDayOutput.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import DayOutputStrip from "./DayOutputStrip.svelte";
import * as api from "../../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DayOutputStrip", () => {
  test("renders deduped commits/LOC/files for the day, badged estimated", async () => {
    vi.spyOn(api, "getBurnDayOutput").mockResolvedValue({
      date: "2026-06-12", sessions: 11, commits: 51,
      insertions: 18015, deletions: 384, filesChanged: 60,
      fidelity: "estimated", deduped: true,
    });
    render(DayOutputStrip, { date: "2026-06-12" });
    expect(await screen.findByText(/51 commits/)).toBeTruthy();
    expect(await screen.findByText(/60 files/)).toBeTruthy();
    expect(await screen.findByText(/est/i)).toBeTruthy();
  });

  test("a day with no ended sessions shows a worded state, not 0 commits", async () => {
    vi.spyOn(api, "getBurnDayOutput").mockResolvedValue({
      date: "2020-01-01", sessions: 0, commits: 0, insertions: 0, deletions: 0,
      filesChanged: 0, fidelity: "estimated", deduped: true,
    });
    render(DayOutputStrip, { date: "2020-01-01" });
    expect(await screen.findByText(/no ended sessions/i)).toBeTruthy();
    expect(screen.queryByText(/0 commits/)).toBeNull();
  });
});
