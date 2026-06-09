// Pi adapter — branch-summation is the headline Pi rule (master §10.6) and the
// real hazard (double-counting / path-traversal). No real session on this machine
// branches, so this fixture is the ONLY thing that exercises it. The structure:
//
//   s0 (session)
//   └─ u1 (user)
//      └─ a1 (assistant: 100 in / 10 out, $0.01, issues tool c1)
//         └─ tr1 (toolResult for c1)
//            ├─ b1 (assistant: 200 in / 20 out, $0.02)   ← abandoned branch
//            └─ b2 (assistant: 300 in / 30 out, $0.03)   ← kept branch
//
// Correct (billed) total sums a1 + b1 + b2. A naive "latest linear path" would sum
// only a1 + b2 and under-report. branchCount = tips {b1, b2} = 2.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "./pi.ts";
import type { NormalizedEvent } from "./base.ts";

function asstRow(id: string, parentId: string, ts: string, input: number, output: number, cost: number, extra: any = {}) {
  return JSON.stringify({
    type: "message", id, parentId, timestamp: ts,
    message: {
      role: "assistant", model: "gpt-5.4", provider: "openai-codex", stopReason: "stop",
      usage: {
        input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      ...extra,
    },
  });
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-fixture-"));
  const path = join(dir, "2026-01-01T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s0", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/proj" }),
    JSON.stringify({ type: "message", id: "u1", parentId: "s0", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } }),
    asstRow("a1", "u1", "2026-01-01T00:00:02.000Z", 100, 10, 0.01, {
      content: [{ type: "toolCall", id: "c1", name: "read" }],
    }),
    JSON.stringify({ type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: "ok" } }),
    asstRow("b1", "tr1", "2026-01-01T00:00:04.000Z", 200, 20, 0.02), // abandoned branch
    asstRow("b2", "tr1", "2026-01-01T00:00:05.000Z", 300, 30, 0.03), // kept branch
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

async function collect(path: string): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of new PiAdapter().parseSession(path)) out.push(ev);
  return out;
}

test("sums tokens across ALL branches, not the latest path", async () => {
  const events = await collect(writeFixture());
  const tokenEvents = events.filter((e): e is Extract<NormalizedEvent, { kind: "tokens" }> => e.kind === "tokens");

  // One event per assistant row (a1, b1, b2) — branch position is irrelevant.
  expect(tokenEvents.length).toBe(3);

  const input = tokenEvents.reduce((s, e) => s + e.tokens.input, 0);
  const output = tokenEvents.reduce((s, e) => s + e.tokens.output, 0);
  const native = tokenEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0);

  // 100 + 200 + 300 — NOT 400 (a1 + b2 latest-path), NOT 300 (b2 only).
  expect(input).toBe(600);
  expect(output).toBe(60);
  expect(native).toBeCloseTo(0.06, 10);
});

test("branchCount = distinct tree tips", async () => {
  const events = await collect(writeFixture());
  const session = events.find((e): e is Extract<NormalizedEvent, { kind: "session" }> => e.kind === "session");
  expect(session?.branchCount).toBe(2); // tips: b1, b2
  expect(session?.sessionId).toBe("s0");
  expect(session?.cwd).toBe("/tmp/proj");
  expect(session?.model).toBe("gpt-5.4");
});

test("pairs tool latency and counts errors from toolResult.isError", async () => {
  const events = await collect(writeFixture());
  const tools = events.filter((e): e is Extract<NormalizedEvent, { kind: "tool" }> => e.kind === "tool");
  expect(tools.length).toBe(1);
  const t = tools[0]!;
  expect(t.toolName).toBe("read");
  expect(t.durationMs).toBe(1000); // a1 ts → tr1 ts = 1s
  expect(t.error).toBeNull();

  const session = events.find((e): e is Extract<NormalizedEvent, { kind: "session" }> => e.kind === "session");
  expect(session?.errorCount).toBe(0);
});

test("linear session with control-record preamble has branchCount 1 (not 2)", async () => {
  // Mirrors real Pi files: a `session` island + a model_change(null parent) +
  // thinking_level_change precede the message chain. None of these control records
  // may be counted as a branch tip, or every linear session over-reports as 2.
  const dir = mkdtempSync(join(tmpdir(), "pi-linear-"));
  const path = join(dir, "2026-01-03T00-00-00-000Z_99999999-8888-7777-6666-555555555555.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "sess-island", timestamp: "2026-01-03T00:00:00.000Z", cwd: "/tmp/p3" }),
    JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: "2026-01-03T00:00:00.100Z", provider: "openai-codex", modelId: "gpt-5.4" }),
    JSON.stringify({ type: "thinking_level_change", id: "tlc1", parentId: "mc1", timestamp: "2026-01-03T00:00:00.200Z", thinkingLevel: "medium" }),
    JSON.stringify({ type: "message", id: "m1", parentId: "tlc1", timestamp: "2026-01-03T00:00:01.000Z", message: { role: "user", content: "hi" } }),
    asstRow("m2", "m1", "2026-01-03T00:00:02.000Z", 50, 5, 0.005),
  ].join("\n") + "\n");

  const events = await collect(path);
  const session = events.find((e): e is Extract<NormalizedEvent, { kind: "session" }> => e.kind === "session");
  expect(session?.branchCount).toBe(1); // only tip is message m2; the island/control records don't count
  expect(session?.sessionId).toBe("sess-island");
});

test("disjoint buckets map directly — cacheRead added on top of input, no subtraction", async () => {
  // A single assistant row with cacheRead > 0; verifies we DON'T subtract it from
  // input (the Codex normalization), which would corrupt Pi's already-disjoint data.
  const dir = mkdtempSync(join(tmpdir(), "pi-cache-"));
  const path = join(dir, "2026-01-02T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "s9", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/tmp/p2" }),
    JSON.stringify({
      type: "message", id: "a9", parentId: "s9", timestamp: "2026-01-02T00:00:01.000Z",
      message: {
        role: "assistant", model: "gpt-5.4", stopReason: "stop",
        usage: { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 7, totalTokens: 6107, cost: { total: 0.5 } },
      },
    }),
  ].join("\n") + "\n");

  const events = await collect(path);
  const tok = events.find((e): e is Extract<NormalizedEvent, { kind: "tokens" }> => e.kind === "tokens")!;
  expect(tok.tokens.input).toBe(1000);       // NOT 1000 - 5000 = -4000
  expect(tok.tokens.cacheRead).toBe(5000);
  expect(tok.tokens.cacheCreate).toBe(7);    // cacheWrite → cacheCreate (priced 1.25×)
  expect(tok.tokens.output).toBe(100);
});
