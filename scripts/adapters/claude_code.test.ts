// Claude Code adapter — first coverage for the REFERENCE parser. The headline
// hazard (confirmed against 219/236 real session files, ~1.9B phantom tokens):
// Claude Code splits ONE assistant message across multiple JSONL lines, one per
// content block (thinking / text / tool_use), and EACH line repeats the identical
// full `usage` block. The adapter must count that message's tokens ONCE
// (deduped by message.id + requestId, like ccusage), while still pairing the
// tool_use block that lives on the last of those lines.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "./claude_code.ts";
import type { NormalizedEvent } from "./base.ts";

const USAGE = { input_tokens: 2148, output_tokens: 2364, cache_read_input_tokens: 16006, cache_creation_input_tokens: 5616 };

/** One assistant content-block line; the whole split message repeats `usage`. */
function asstBlock(id: string, req: string, ts: string, block: any) {
  return JSON.stringify({
    type: "assistant", sessionId: "sess-1", requestId: req, timestamp: ts,
    cwd: "/tmp/proj", gitBranch: "main",
    message: { id, model: "claude-opus-4-8", stop_reason: "tool_use", usage: USAGE, content: [block] },
  });
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-fixture-"));
  const path = join(dir, "sess-1.jsonl");
  const lines = [
    // ONE message (msg_A / req_A) split across 3 lines — usage repeated each time.
    asstBlock("msg_A", "req_A", "2026-05-29T17:30:38.588Z", { type: "thinking", thinking: "..." }),
    asstBlock("msg_A", "req_A", "2026-05-29T17:30:39.519Z", { type: "text", text: "doing it" }),
    asstBlock("msg_A", "req_A", "2026-05-29T17:30:42.713Z", { type: "tool_use", id: "tu_1", name: "Edit" }),
    // The tool_result for that tool_use (pairs latency, no usage).
    JSON.stringify({ type: "user", sessionId: "sess-1", timestamp: "2026-05-29T17:30:43.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "ok" }] } }),
    // A SECOND, distinct message (msg_B / req_B), single line.
    asstBlock("msg_B", "req_B", "2026-05-29T17:31:00.000Z", { type: "text", text: "done" }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

async function collect(path: string): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of new ClaudeCodeAdapter().parseSession(path)) out.push(ev);
  return out;
}

test("usage counted ONCE per message despite multi-line content-block split", async () => {
  const events = await collect(writeFixture());
  const tokenEvents = events.filter((e) => e.kind === "tokens");
  // 3-line msg_A + 1-line msg_B = 2 distinct messages → 2 token events, not 4.
  expect(tokenEvents.length).toBe(2);
});

test("deduped totals equal a single message's usage, not 3×", async () => {
  const events = await collect(writeFixture());
  const tok = events.filter((e) => e.kind === "tokens") as Extract<NormalizedEvent, { kind: "tokens" }>[];
  const sum = (k: "input" | "output" | "cacheRead" | "cacheCreate") =>
    tok.reduce((a, e) => a + (e.tokens[k] ?? 0), 0);
  // Two messages, each counted once: 2 × each usage field.
  expect(sum("input")).toBe(USAGE.input_tokens * 2);
  expect(sum("output")).toBe(USAGE.output_tokens * 2);
  expect(sum("cacheRead")).toBe(USAGE.cache_read_input_tokens * 2);
  expect(sum("cacheCreate")).toBe(USAGE.cache_creation_input_tokens * 2);
});

test("the tool_use on the message's last split line is still paired", async () => {
  const events = await collect(writeFixture());
  const tools = events.filter((e) => e.kind === "tool") as Extract<NormalizedEvent, { kind: "tool" }>[];
  expect(tools.length).toBe(1);
  expect(tools[0]!.toolName).toBe("Edit");
  expect(tools[0]!.durationMs).not.toBeNull(); // paired with its tool_result
});

test("a line with usage but no id/requestId is still counted (cannot dedupe)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-fixture-noid-"));
  const path = join(dir, "sess-2.jsonl");
  writeFileSync(path, JSON.stringify({
    type: "assistant", sessionId: "sess-2", timestamp: "2026-05-29T18:00:00.000Z",
    message: { model: "claude-opus-4-8", usage: USAGE, content: [{ type: "text", text: "x" }] },
  }) + "\n");
  const tok = (await collect(path)).filter((e) => e.kind === "tokens");
  expect(tok.length).toBe(1);
});
