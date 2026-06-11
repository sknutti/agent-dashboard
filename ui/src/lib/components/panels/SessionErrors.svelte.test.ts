// Component coverage for the parsed Errors view (ADR-0005). Mocks getSessionErrors
// and renders via @testing-library/svelte (jsdom). Named *.svelte.test.ts so the
// runes in the component + resource() compile (see vitest.config.ts).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import SessionErrors from "./SessionErrors.svelte";
import * as api from "../../api";

// vitest.config has no globals → testing-library's auto-cleanup never registers;
// unmount by hand so renders don't accumulate across tests (see Session test).
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SessionErrors", () => {
  test("renders the failing tool input, captured error text, and a ✗ glyph", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: true,
      outcome: "errored",
      errors: [{
        toolName: "Edit",
        toolInput: '{"file_path":"foo.ts","old_string":"x"}',
        errorText: "String to replace not found in file",
        before: [{ role: "user", text: "fix the bug", isError: false, ts: "" }],
        after: [],
        index: 1,
      }],
    });
    render(SessionErrors, { sessionId: "s1" });
    expect(await screen.findByText("Edit")).toBeTruthy();
    expect(await screen.findByText(/foo\.ts/)).toBeTruthy();
    expect(await screen.findByText(/String to replace not found/)).toBeTruthy();
    // Red is never the sole signal — the ✗ glyph is always present (colorblind rule).
    expect(screen.getAllByText("✗").length).toBeGreaterThan(0);
  });

  test("supported:false renders the agent-unavailable note + a Messages affordance", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: false,
      outcome: "errored",
      note: "Parsed error view is unavailable for this agent — open Messages for the raw transcript.",
    });
    render(SessionErrors, { sessionId: "s2" });
    expect(await screen.findByText(/unavailable for this agent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /messages/i })).toBeTruthy();
  });

  test("a command tool input is shown as plain text, not a raw JSON blob", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: true,
      outcome: "errored",
      errors: [{
        toolName: "Bash",
        toolInput: JSON.stringify({ command: 'git add foo.ts && git commit -m "msg"', description: "commit it" }),
        errorText: "exit 1",
        before: [],
        after: [],
        index: 0,
      }],
    });
    render(SessionErrors, { sessionId: "sc" });
    await screen.findByText("Bash");
    // The command is rendered as readable text…
    expect(screen.getByText(/git add foo\.ts && git commit -m "msg"/)).toBeTruthy();
    // …with the JSON wrapper (keys/braces) parsed away, not shown verbatim.
    expect(screen.queryByText(/"command":/)).toBeNull();
  });

  test("a non-command tool input is shown as readable indented JSON", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: true,
      outcome: "errored",
      errors: [{
        toolName: "Edit",
        toolInput: JSON.stringify({ file_path: "foo.ts", old_string: "a" }),
        errorText: "no match",
        before: [],
        after: [],
        index: 0,
      }],
    });
    render(SessionErrors, { sessionId: "se" });
    await screen.findByText("Edit");
    // Pretty-printed (indented) rather than a crushed single line.
    expect(screen.getByText(/"file_path": "foo\.ts"/)).toBeTruthy();
  });

  test("a non-errored Failure renders its one-line failureNote", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: true,
      outcome: "rate_limited",
      errors: [],
      failureNote: "This session hit a provider rate limit — there's no failed tool call to inspect. See Messages.",
    });
    render(SessionErrors, { sessionId: "s3" });
    expect(await screen.findByText(/hit a provider rate limit/)).toBeTruthy();
  });

  test("the expand control grows the visible context window", async () => {
    vi.spyOn(api, "getSessionErrors").mockResolvedValue({
      supported: true,
      outcome: "errored",
      errors: [{
        toolName: "Bash",
        toolInput: "rm -rf /tmp/x",
        errorText: "boom",
        before: [
          { role: "user", text: "CTX_B1", isError: false, ts: "" },
          { role: "assistant", text: "CTX_B2", isError: false, ts: "" },
          { role: "assistant", text: "CTX_B3", isError: false, ts: "" },
        ],
        after: [
          { role: "assistant", text: "CTX_A1", isError: false, ts: "" },
          { role: "assistant", text: "CTX_A2", isError: false, ts: "" },
        ],
        index: 3,
      }],
    });
    render(SessionErrors, { sessionId: "s4" });
    await screen.findByText("Bash");
    // Collapsed: only the rows nearest the failure are shown; the farther ones hide.
    expect(screen.queryByText("CTX_B1")).toBeNull();
    expect(screen.queryByText("CTX_A2")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /more context/i }));
    expect(await screen.findByText("CTX_B1")).toBeTruthy();
    expect(screen.getByText("CTX_A2")).toBeTruthy();
  });
});
