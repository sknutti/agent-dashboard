// Component coverage for the parsed Messages view (ADR-0006 layout C). Mocks
// getSessionMessages and renders via @testing-library/svelte (jsdom). Named
// *.svelte.test.ts so the runes + resource() compile (see vitest.config.ts).

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import SessionMessages from "./SessionMessages.svelte";
import * as api from "../../api";
import type { DisplayMessage } from "../../api";

// jsdom has no EventSource; the live branch mounts SessionFeed which opens one.
class FakeEventSource {
  onerror: ((e: unknown) => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

const m = (role: DisplayMessage["role"], text: string, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({
  role, text, isError: false, ts: "", ...extra,
});

beforeEach(() => { (globalThis as any).EventSource = FakeEventSource; });
// No globals in vitest.config → unmount by hand (see SessionErrors test).
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SessionMessages", () => {
  test("a LIVE session renders the raw byte-tail (SessionFeed), not cards", async () => {
    vi.spyOn(api, "getSessionMessages").mockResolvedValue({ supported: true, live: true, messages: [] });
    render(SessionMessages, { sessionId: "live1" });
    // SessionFeed's empty state — only it renders this copy.
    expect(await screen.findByText(/raw event feed/i)).toBeTruthy();
  });

  test("an ENDED session renders grouped turns: prompt head + nested entries", async () => {
    vi.spyOn(api, "getSessionMessages").mockResolvedValue({
      supported: true, live: false,
      messages: [
        m("user", "fix the bug in foo.ts"),
        m("thinking", "the match looks off"),
        m("assistant", "I'll edit it"),
        m("tool", "ok", { toolName: "Read", toolInput: '{"file_path":"foo.ts"}' }),
      ],
    });
    render(SessionMessages, { sessionId: "ended1" });
    expect(await screen.findByText("fix the bug in foo.ts")).toBeTruthy(); // prompt head
    expect(screen.getByText("the match looks off")).toBeTruthy(); // thinking entry
    expect(screen.getByText("I'll edit it")).toBeTruthy(); // assistant entry
    expect(screen.getByText("Read")).toBeTruthy(); // tool entry
  });

  test("an errored tool entry pairs red with a ✗ glyph (colorblind rule)", async () => {
    vi.spyOn(api, "getSessionMessages").mockResolvedValue({
      supported: true, live: false,
      messages: [
        m("user", "deploy"),
        m("tool", "permission denied", { toolName: "deploy", toolInput: '{"target":"prod"}', isError: true }),
      ],
    });
    render(SessionMessages, { sessionId: "err1" });
    await screen.findByText("deploy", { selector: ".tool-name" });
    expect(screen.getAllByText("✗").length).toBeGreaterThan(0);
  });

  test("supported:false renders the note (no Messages affordance — this IS Messages)", async () => {
    vi.spyOn(api, "getSessionMessages").mockResolvedValue({
      supported: false, live: false,
      note: "Parsed message view is unavailable for this agent.",
    });
    render(SessionMessages, { sessionId: "uns1" });
    expect(await screen.findByText(/unavailable for this agent/)).toBeTruthy();
  });
});
