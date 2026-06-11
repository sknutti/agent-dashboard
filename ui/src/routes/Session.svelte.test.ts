// The session page is tabbed Errors | Messages (ADR-0005). The active tab is read
// from the URL query (?tab=errors deep-links to Errors; anything else → Messages),
// and only the active tab's panel is mounted. Named *.svelte.test.ts for runes.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import Session from "./Session.svelte";
import * as api from "../lib/api";
import { navigate } from "../lib/router.svelte";

// jsdom has no EventSource; SessionFeed opens one on mount. Stub it so the
// Messages tab can mount without throwing.
class FakeEventSource {
  onerror: ((e: unknown) => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  (globalThis as any).EventSource = FakeEventSource;
  vi.spyOn(api, "getSessionDetail").mockResolvedValue({
    session: { session_id: "x", agent: "claude_code", model: null, cwd: null, git_branch: null,
      title: "T", started_at: null, ended_at: null, total_tokens: 0, effective_tokens: 0,
      error_count: 1, cost_usd: null, cost_estimated_usd: null, duration_ms: null, fidelity: "exact",
      outcome: "errored", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_create_tokens: 0, reasoning_tokens: 0, rate_limit_hit: 0, stop_reason: null, branch_count: null },
    tools: [],
  } as any);
  vi.spyOn(api, "getSessionErrors").mockResolvedValue({ supported: true, outcome: "errored", errors: [] });
  // The Messages tab now mounts SessionMessages (ADR-0006), which fetches the
  // parsed Transcript — mock it so the panel renders without a real fetch.
  vi.spyOn(api, "getSessionMessages").mockResolvedValue({
    supported: true, live: false,
    messages: [{ role: "user", text: "hello from the transcript", isError: false, ts: "" }],
  });
});

// Globals aren't enabled in vitest.config, so testing-library's auto-cleanup
// (which hooks a global afterEach) never registers — unmount renders by hand or
// they accumulate and cross-contaminate the shared router state between tests.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Session page tabs", () => {
  test("?tab=errors selects the Errors tab", async () => {
    navigate("/session/x", "?tab=errors");
    render(Session, { id: "x" });
    const errorsTab = await screen.findByRole("tab", { name: /errors/i });
    expect(errorsTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /messages/i }).getAttribute("aria-selected")).toBe("false");
  });

  test("a normal navigation (no query) defaults to Messages", async () => {
    navigate("/session/x", "");
    render(Session, { id: "x" });
    const messagesTab = await screen.findByRole("tab", { name: /messages/i });
    expect(messagesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /errors/i }).getAttribute("aria-selected")).toBe("false");
  });

  test("the Messages tab mounts the parsed SessionMessages panel", async () => {
    navigate("/session/x", "?tab=messages");
    render(Session, { id: "x" });
    // The parsed Transcript's prompt text renders — proves SessionMessages (not the
    // old raw SessionFeed) is mounted on the Messages tab.
    expect(await screen.findByText("hello from the transcript")).toBeTruthy();
  });
});
