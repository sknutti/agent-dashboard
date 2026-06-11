// Phase 5 click-source rewiring (ADR-0005): each entry point routes to the right
// session tab. FailuresPanel row → Errors; SessionsTablePanel errored pill →
// Errors (stopPropagation, so the row's Messages nav doesn't also fire); the
// AgentCard errors drill (DrillSheet) → Errors tab + closes the drawer, while
// other drills keep their in-drawer detail. Named *.svelte.test.ts for runes.

import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import FailuresPanel from "./FailuresPanel.svelte";
import SessionsTablePanel from "./SessionsTablePanel.svelte";
import DrillSheet from "./DrillSheet.svelte";
import * as api from "../../api";
import * as router from "../../router.svelte";
import { drill, closeDrill } from "../../stores.svelte";

// jsdom implements neither the Web Animations API (Sheet.svelte calls
// element.animate) — stub it so the drawer can mount.
(Element.prototype as any).animate ??= () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });

afterEach(() => { cleanup(); vi.restoreAllMocks(); closeDrill(); drill.ctx = null; });

function failure(id: string, outcome: string) {
  return { session_id: id, agent: "claude_code", model: null, title: `title-${id}`, cwd: null,
    started_at: null, error_count: outcome === "errored" ? 1 : 0, rate_limit_hit: 0,
    stop_reason: null, outcome };
}
function sessionRow(id: string, outcome: string) {
  return { session_id: id, agent: "claude_code", model: null, cwd: null, git_branch: null,
    title: `title-${id}`, started_at: null, ended_at: null, total_tokens: 100, effective_tokens: 100,
    error_count: outcome === "errored" ? 1 : 0, cost_usd: null, cost_estimated_usd: null,
    duration_ms: null, fidelity: "exact", outcome };
}

describe("FailuresPanel", () => {
  test("a failure row navigates to the Errors tab", async () => {
    vi.spyOn(api, "getFailures").mockResolvedValue({ range: "7d", total: 1, failures: [failure("f1", "errored")] } as any);
    const nav = vi.spyOn(router, "navigate").mockImplementation(() => {});
    render(FailuresPanel);
    await fireEvent.click(await screen.findByTitle("Open session"));
    expect(nav).toHaveBeenCalledWith("/session/f1", "?tab=errors");
  });
});

describe("SessionsTablePanel errored pill", () => {
  beforeEach(() => {
    vi.spyOn(api, "getSessions").mockResolvedValue({
      total: 2, limit: 25, offset: 0, sessions: [sessionRow("e1", "errored"), sessionRow("ok1", "ok")],
    } as any);
  });

  test("clicking the errored pill goes to Errors and does NOT also fire the row's Messages nav", async () => {
    const nav = vi.spyOn(router, "navigate").mockImplementation(() => {});
    render(SessionsTablePanel);
    const pill = await screen.findByRole("button", { name: /view parsed errors/i });
    await fireEvent.click(pill);
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith("/session/e1", "?tab=errors");
  });

  test("clicking a non-errored row keeps the default Messages navigation", async () => {
    const nav = vi.spyOn(router, "navigate").mockImplementation(() => {});
    render(SessionsTablePanel);
    // The ok row's whole-row button (its accessible name includes its title).
    const row = await screen.findByRole("button", { name: /title-ok1/ });
    await fireEvent.click(row);
    expect(nav).toHaveBeenCalledWith("/session/ok1");
    expect(nav).not.toHaveBeenCalledWith("/session/ok1", "?tab=errors");
  });
});

describe("DrillSheet errors drill", () => {
  test("an errored-drill row navigates to the Errors tab AND closes the drawer", async () => {
    vi.spyOn(api, "getSessions").mockResolvedValue({ total: 1, limit: 100, offset: 0, sessions: [sessionRow("d1", "errored")] } as any);
    const nav = vi.spyOn(router, "navigate").mockImplementation(() => {});
    drill.ctx = { title: "Errors", outcome: "errored" };
    drill.open = true;
    render(DrillSheet);
    await fireEvent.click(await screen.findByText("title-d1"));
    expect(nav).toHaveBeenCalledWith("/session/d1", "?tab=errors");
    expect(drill.open).toBe(false); // drawer closed
  });

  test("a non-errors drill row keeps in-drawer detail (no navigation)", async () => {
    vi.spyOn(api, "getSessions").mockResolvedValue({ total: 1, limit: 100, offset: 0, sessions: [sessionRow("t1", "ok")] } as any);
    const detail = vi.spyOn(api, "getSessionDetail").mockResolvedValue({ session: sessionRow("t1", "ok"), tools: [] } as any);
    const nav = vi.spyOn(router, "navigate").mockImplementation(() => {});
    drill.ctx = { title: "Tokens" }; // no outcome → not the errors drill
    drill.open = true;
    render(DrillSheet);
    await fireEvent.click(await screen.findByText("title-t1"));
    expect(detail).toHaveBeenCalledWith("t1"); // opened in-drawer detail
    expect(nav).not.toHaveBeenCalled();
    expect(drill.open).toBe(true); // drawer stays open
  });
});
