// Codex adapter — first coverage. Codex emits CUMULATIVE total_token_usage; the
// adapter attributes each record's delta to the model active at that point so a
// mid-session `/model` switch is priced per-segment (master §10.2 + ADR-0002).
// Two anchors: (1) a single-model session must be byte-identical to the old
// single-event path (the 306 real sessions never switch models — this is the
// regression guard); (2) a model switch must split tokens across two events whose
// sum equals the final cumulative (no token gained or lost).

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "./codex.ts";
import type { NormalizedEvent } from "./base.ts";

function turnContext(ts: string, model: string) {
  return JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });
}
function tokenCount(ts: string, u: { input: number; cached: number; output: number; reasoning: number }) {
  return JSON.stringify({
    type: "event_msg", timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: u.input, cached_input_tokens: u.cached,
          output_tokens: u.output, reasoning_output_tokens: u.reasoning,
        },
      },
    },
  });
}

function writeFixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-fixture-"));
  const path = join(dir, "rollout-2026-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  const head = JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "sess-cx", cwd: "/tmp/p", source: "cli" } });
  writeFileSync(path, [head, ...lines].join("\n") + "\n");
  return path;
}

async function tokensOf(path: string) {
  const out: Extract<NormalizedEvent, { kind: "tokens" }>[] = [];
  for await (const ev of new CodexAdapter().parseSession(path)) if (ev.kind === "tokens") out.push(ev);
  return out;
}

test("single model: ONE event, last cumulative normalized to disjoint buckets (regression)", async () => {
  const path = writeFixture([
    turnContext("2026-01-01T00:00:01Z", "gpt-5.5"),
    tokenCount("2026-01-01T00:00:02Z", { input: 1000, cached: 200, output: 500, reasoning: 100 }),
    tokenCount("2026-01-01T00:00:03Z", { input: 1500, cached: 300, output: 800, reasoning: 150 }), // cumulative
  ]);
  const toks = await tokensOf(path);
  expect(toks).toHaveLength(1);
  expect(toks[0]!.model).toBe("gpt-5.5");
  // Last cumulative (1500/300/800/150) → disjoint: input 1200, output 650, cacheRead 300, reasoning 150.
  expect(toks[0]!.tokens).toEqual({ input: 1200, output: 650, cacheRead: 300, reasoning: 150 });
});

test("mid-session model switch: per-model events, summing to the final cumulative", async () => {
  const path = writeFixture([
    turnContext("2026-01-01T00:00:01Z", "gpt-5.5"),
    tokenCount("2026-01-01T00:00:02Z", { input: 1000, cached: 200, output: 500, reasoning: 100 }), // all under 5.5
    turnContext("2026-01-01T00:00:03Z", "gpt-5.4"),
    tokenCount("2026-01-01T00:00:04Z", { input: 1500, cached: 300, output: 800, reasoning: 150 }), // delta under 5.4
  ]);
  const toks = await tokensOf(path);
  expect(toks).toHaveLength(2);
  const by = Object.fromEntries(toks.map((t) => [t.model, t.tokens]));
  // gpt-5.5: raw 1000/200/500/100 → input 800, output 400, cacheRead 200, reasoning 100.
  expect(by["gpt-5.5"]).toEqual({ input: 800, output: 400, cacheRead: 200, reasoning: 100 });
  // gpt-5.4: delta 500/100/300/50 → input 400, output 250, cacheRead 100, reasoning 50.
  expect(by["gpt-5.4"]).toEqual({ input: 400, output: 250, cacheRead: 100, reasoning: 50 });
  // No token gained or lost: per-model sum == the final cumulative normalized.
  const sum = (k: "input" | "output" | "cacheRead" | "reasoning") => toks.reduce((a, t) => a + (t.tokens[k] ?? 0), 0);
  expect(sum("input")).toBe(1200);
  expect(sum("output")).toBe(650);
  expect(sum("cacheRead")).toBe(300);
  expect(sum("reasoning")).toBe(150);
});

test("counter reset (cumulative drops) starts a fresh epoch instead of going negative", async () => {
  const path = writeFixture([
    turnContext("2026-01-01T00:00:01Z", "gpt-5.5"),
    tokenCount("2026-01-01T00:00:02Z", { input: 1000, cached: 0, output: 500, reasoning: 0 }),
    // compaction reset: cumulative drops, then climbs from the new baseline.
    tokenCount("2026-01-01T00:00:03Z", { input: 300, cached: 0, output: 100, reasoning: 0 }),
  ]);
  const toks = await tokensOf(path);
  expect(toks).toHaveLength(1);
  // Pre-reset 1000/500 + post-reset epoch 300/100 = input 1300, output 600 (not 300/100, not negative).
  expect(toks[0]!.tokens.input).toBe(1300);
  expect(toks[0]!.tokens.output).toBe(600);
});
