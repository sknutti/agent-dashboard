// Component coverage for the git-derived session-outcome strip. Mocks
// getSessionGitOutcome and renders via @testing-library/svelte (jsdom). The figure
// is a heuristic ESTIMATE, so the strip MUST badge it and must show a clear
// inapplicable state (not a misleading 0) for non-repo / live sessions.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import GitOutcomeStrip from "./GitOutcomeStrip.svelte";
import * as api from "../../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GitOutcomeStrip", () => {
  test("renders commits/LOC/files and badges the figure as an estimate", async () => {
    vi.spyOn(api, "getSessionGitOutcome").mockResolvedValue({
      applicable: true, fidelity: "estimated", method: "branch_window",
      commits: 3, insertions: 120, deletions: 45, filesChanged: 7,
    });
    render(GitOutcomeStrip, { id: "s1" });
    // figures present
    expect(await screen.findByText(/3 commits/)).toBeTruthy();
    expect(await screen.findByText(/120/)).toBeTruthy();
    expect(await screen.findByText(/45/)).toBeTruthy();
    expect(await screen.findByText(/7 files/)).toBeTruthy();
    // and visibly badged as an estimate (never passes as a measurement)
    expect(await screen.findByText(/est/i)).toBeTruthy();
  });

  test("a non-repo session shows a clear state, not zeros", async () => {
    vi.spyOn(api, "getSessionGitOutcome").mockResolvedValue({ applicable: false, reason: "not_a_repo" });
    render(GitOutcomeStrip, { id: "s2" });
    expect(await screen.findByText(/not a git repo/i)).toBeTruthy();
    // no fabricated "0 commits"
    expect(screen.queryByText(/0 commits/)).toBeNull();
  });

  test("a live session shows nothing misleading", async () => {
    vi.spyOn(api, "getSessionGitOutcome").mockResolvedValue({ applicable: false, reason: "live" });
    render(GitOutcomeStrip, { id: "s3" });
    expect(await screen.findByText(/in progress|live/i)).toBeTruthy();
  });
});
