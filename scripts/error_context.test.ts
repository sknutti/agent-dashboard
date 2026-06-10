// Display-parser coverage. The display parse is a SECOND consumer of each agent's
// raw log (distinct from scripts/adapters/*), turning a session file into an
// ordered list of readable messages with errored tool calls flagged and their
// failing input attached. Fixtures mirror the exact shapes the adapter tests
// encode (claude_code/codex/pi .test.ts) so the two consumers can't silently drift.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDisplay,
  windowErrors,
  UnsupportedAgentError,
  type DisplayMessage,
} from "./error_context.ts";

function fixture(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `ec-${name}-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// ── Claude Code ────────────────────────────────────────────────────────────
// One assistant message is split across lines (thinking / text / tool_use), all
// sharing message.id — they must collapse into one readable assistant turn plus
// the tool entry. The tool_result (a synthetic `user` line) folds back onto the
// tool entry, never becoming its own message.
function claudeFixture(): string {
  const asst = (id: string, ts: string, block: any) =>
    JSON.stringify({ type: "assistant", sessionId: "s", timestamp: ts,
      message: { id, model: "claude-opus-4-8", content: [block] } });
  return fixture("claude", [
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "Fix the bug in foo.ts" } }),
    asst("msg_A", "2026-06-01T00:00:01Z", { type: "thinking", thinking: "the match looks off" }),
    asst("msg_A", "2026-06-01T00:00:02Z", { type: "text", text: "I'll edit it" }),
    asst("msg_A", "2026-06-01T00:00:03Z", { type: "tool_use", id: "tu_1", name: "Edit",
      input: { file_path: "foo.ts", old_string: "a", new_string: "b" } }),
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:04Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true,
        content: "String to replace not found in file" }] } }),
    asst("msg_B", "2026-06-01T00:00:05Z", { type: "text", text: "Let me try again" }),
    asst("msg_C", "2026-06-01T00:00:06Z", { type: "tool_use", id: "tu_2", name: "Bash",
      input: { command: "ls" } }),
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:07Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: false, content: "ok" }] } }),
  ]);
}

test("claude: errored tool carries failing input + error text + ±N context", async () => {
  const msgs = await parseDisplay("claude_code", claudeFixture());
  const errs = windowErrors(msgs);
  expect(errs.length).toBe(1);
  const e = errs[0]!;
  expect(e.toolName).toBe("Edit");
  expect(e.toolInput).toContain("foo.ts");
  expect(e.errorText).toContain("String to replace not found");
  // before: the user prompt + the collapsed assistant turn (clamped at i=2).
  expect(e.before.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(e.before[1]!.text).toContain("I'll edit it");
  expect(e.before[1]!.text).toContain("the match looks off"); // thinking folded in
  // after: the next assistant turn + the (successful) Bash tool.
  expect(e.after.map((m) => m.role)).toEqual(["assistant", "tool"]);
  expect(e.after[1]!.isError).toBe(false);
});

// ── Codex ──────────────────────────────────────────────────────────────────
// {type,timestamp,payload} envelope. function_call (response_item) issues the
// tool with its `arguments`; exec_command_end (event_msg) flags exit_code≠0;
// function_call_output (response_item) carries the captured stderr/result text.
function codexFixture(): string {
  const ri = (ts: string, payload: any) => JSON.stringify({ type: "response_item", timestamp: ts, payload });
  const em = (ts: string, payload: any) => JSON.stringify({ type: "event_msg", timestamp: ts, payload });
  return fixture("codex", [
    ri("2026-06-01T00:00:00Z", { type: "message", role: "user",
      content: [{ type: "input_text", text: "run the tests" }] }),
    ri("2026-06-01T00:00:01Z", { type: "function_call", call_id: "c1", name: "shell",
      arguments: '{"command":["bash","-lc","npm test"]}' }),
    em("2026-06-01T00:00:02Z", { type: "exec_command_end", call_id: "c1", exit_code: 1,
      duration: { secs: 0, nanos: 5 } }),
    ri("2026-06-01T00:00:03Z", { type: "function_call_output", call_id: "c1",
      output: "npm ERR! test failed: 3 assertions" }),
    ri("2026-06-01T00:00:04Z", { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "the tests failed" }] }),
  ]);
}

test("codex: exec exit_code≠0 flags the tool, with command + captured output", async () => {
  const msgs = await parseDisplay("codex", codexFixture());
  const errs = windowErrors(msgs);
  expect(errs.length).toBe(1);
  const e = errs[0]!;
  expect(e.toolName).toBe("shell");
  expect(e.toolInput).toContain("npm test");
  expect(e.errorText).toContain("npm ERR!");
  expect(e.before.map((m) => m.role)).toEqual(["user"]);
  expect(e.before[0]!.text).toContain("run the tests");
  expect(e.after.map((m) => m.role)).toEqual(["assistant"]);
});

// ── Pi ───────────────────────────────────────────────────────────────────────
// type:"message" with message.role ∈ {user,assistant,toolResult}; assistant
// content[] holds toolCall{id,name,input}; toolResult{toolCallId,isError,content}.
function piFixture(): string {
  const msg = (ts: string, message: any) => JSON.stringify({ type: "message", id: ts, timestamp: ts, message });
  return fixture("pi", [
    msg("2026-06-01T00:00:00Z", { role: "user", content: "deploy it" }),
    msg("2026-06-01T00:00:01Z", { role: "assistant", content: [
      { type: "text", text: "deploying" },
      { type: "toolCall", id: "t1", name: "deploy", input: { target: "prod" } },
    ] }),
    msg("2026-06-01T00:00:02Z", { role: "toolResult", toolCallId: "t1", toolName: "deploy",
      isError: true, content: "permission denied for target prod" }),
    msg("2026-06-01T00:00:03Z", { role: "assistant", content: [{ type: "text", text: "deploy failed" }] }),
  ]);
}

test("pi: toolResult.isError flags the toolCall, with input + content", async () => {
  const msgs = await parseDisplay("pi", piFixture());
  const errs = windowErrors(msgs);
  expect(errs.length).toBe(1);
  const e = errs[0]!;
  expect(e.toolName).toBe("deploy");
  expect(e.toolInput).toContain("prod");
  expect(e.errorText).toContain("permission denied");
  expect(e.before.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(e.after.map((m) => m.role)).toEqual(["assistant"]);
});

// Real pi toolCall blocks carry the input under `arguments` (OpenAI-style), not
// `input` as the ADR note assumed — verified against real session files. The
// parser must read `arguments` (falling back to `input`) or the failing input is
// blank in the Errors view.
test("pi: toolCall input is read from the real `arguments` key", async () => {
  const path = fixture("pi-args", [
    JSON.stringify({ type: "message", id: "1", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/etc/secret.conf" } },
      ] } }),
    JSON.stringify({ type: "message", id: "2", timestamp: "2026-06-01T00:00:01Z",
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: true,
        content: "ENOENT: no such file or directory" } }),
  ]);
  const e = windowErrors(await parseDisplay("pi", path))[0]!;
  expect(e.toolName).toBe("read");
  expect(e.toolInput).toContain("/etc/secret.conf");
  expect(e.errorText).toContain("ENOENT");
});

// ── windowErrors (pure) ──────────────────────────────────────────────────────
test("window clamps at start and end without crashing", () => {
  const atStart: DisplayMessage[] = [
    { role: "tool", text: "boom", isError: true, toolName: "X", toolInput: "y" },
    { role: "assistant", text: "after", isError: false },
  ];
  const a = windowErrors(atStart);
  expect(a[0]!.before).toEqual([]);
  expect(a[0]!.after.length).toBe(1);

  const atEnd: DisplayMessage[] = [
    { role: "user", text: "hi", isError: false },
    { role: "tool", text: "boom", isError: true, toolName: "X", toolInput: "y" },
  ];
  const b = windowErrors(atEnd);
  expect(b[0]!.before.length).toBe(1);
  expect(b[0]!.after).toEqual([]);
});

test("a session with zero errored tool calls yields no error contexts", async () => {
  const msgs = await parseDisplay("claude_code", fixture("clean", [
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-01T00:00:01Z",
      message: { id: "m", content: [{ type: "tool_use", id: "tu", name: "Read", input: { file: "x" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:02Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu", is_error: false, content: "ok" }] } }),
  ]));
  expect(windowErrors(msgs)).toEqual([]);
});

test("a malformed line is skipped, never throws", async () => {
  const path = fixture("malformed", [
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "before" } }),
    "{ this is not valid json",
    JSON.stringify({ type: "assistant", timestamp: "2026-06-01T00:00:01Z",
      message: { id: "m", content: [{ type: "text", text: "after" }] } }),
  ]);
  const msgs = await parseDisplay("claude_code", path);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("antigravity (no display parser) throws UnsupportedAgentError", async () => {
  await expect(parseDisplay("antigravity", "/dev/null")).rejects.toBeInstanceOf(UnsupportedAgentError);
});
