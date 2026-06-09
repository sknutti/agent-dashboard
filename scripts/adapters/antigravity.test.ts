// Antigravity adapter — the protobuf token reader and the two-source (.db tokens +
// transcript tools) merge are the novel, fragile parts. No .proto exists, so the
// wire reader is hand-ported; these fixtures pin the field map (input = f1+f2+f6,
// reasoning = f9, output = f10, model at 1.19) and the f3 == f9+f10 invariant, then
// drive a full parseSession over a synthetic conversation `.db` + transcript to
// prove the merge, the tool-latency pairing, and the empty-conversation skip.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AntigravityAdapter, decodeGen } from "./antigravity.ts";
import type { NormalizedEvent } from "./base.ts";

// ── Minimal protobuf encoder (mirror of the reader under test) ──────────────────
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return out;
}
function vField(fn: number, value: number): number[] {
  return [...varint(fn * 8 + 0), ...varint(value)];
}
function lenField(fn: number, bytes: number[]): number[] {
  return [...varint(fn * 8 + 2), ...varint(bytes.length), ...bytes];
}
function strField(fn: number, s: string): number[] {
  return lenField(fn, [...new TextEncoder().encode(s)]);
}

/** Build one gen_metadata BLOB: top→f1→{ f4=usage, f19=model }. */
function genBlob(
  f: { f1?: number; f2?: number; f3?: number; f6?: number; f9?: number; f10?: number; model?: string },
): Uint8Array {
  const usage: number[] = [];
  if (f.f1 !== undefined) usage.push(...vField(1, f.f1));
  if (f.f2 !== undefined) usage.push(...vField(2, f.f2));
  if (f.f3 !== undefined) usage.push(...vField(3, f.f3));
  if (f.f6 !== undefined) usage.push(...vField(6, f.f6));
  if (f.f9 !== undefined) usage.push(...vField(9, f.f9));
  if (f.f10 !== undefined) usage.push(...vField(10, f.f10));
  const f1msg = [...lenField(4, usage), ...(f.model ? strField(19, f.model) : [])];
  return new Uint8Array(lenField(1, f1msg));
}

// ── decodeGen: the field map ────────────────────────────────────────────────────
test("decodeGen maps input = f1+f2+f6, reasoning = f9, output = f10, + model", () => {
  const g = decodeGen(genBlob({ f1: 1020, f2: 5000, f6: 24, f3: 300, f9: 250, f10: 50, model: "gemini-3-flash-a" }));
  expect(g).not.toBeNull();
  expect(g!.input).toBe(1020 + 5000 + 24);
  expect(g!.reasoning).toBe(250);
  expect(g!.output).toBe(50);
  // f3 == f9 + f10 invariant ⇒ schema total (input + output + reasoning) == input + f3.
  expect(g!.output + g!.reasoning).toBe(300);
  expect(g!.model).toBe("gemini-3-flash-a");
});

test("decodeGen falls back to output = f3 (no reasoning) when the f9/f10 split is absent", () => {
  const g = decodeGen(genBlob({ f1: 1020, f2: 100, f6: 24, f3: 80 }));
  expect(g!.output).toBe(80);
  expect(g!.reasoning).toBe(0);
});

test("decodeGen skips a generation missing f2 or f3 (empty/aborted row)", () => {
  expect(decodeGen(genBlob({ f1: 1020, f6: 24 }))).toBeNull(); // no f2, no f3
  expect(decodeGen(genBlob({ f2: 100 }))).toBeNull(); // no f3
});

// ── Full parseSession: two-source merge over a synthetic .db + transcript ────────
function writeConversation(): { baseDir: string; dbPath: string; convId: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "antigravity-cli-"));
  const convId = "11111111-2222-3333-4444-555555555555";

  // conversations/<id>.db — 2 real generations + 1 empty row + a trajectory cwd.
  mkdirSync(join(baseDir, "conversations"), { recursive: true });
  const dbPath = join(baseDir, "conversations", `${convId}.db`);
  const db = new Database(dbPath);
  db.run("CREATE TABLE gen_metadata (idx integer, data blob, size integer)");
  const ins = db.query("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  const g1 = genBlob({ f1: 1020, f2: 5000, f6: 24, f3: 300, f9: 250, f10: 50, model: "gemini-3-flash-a" });
  const g2 = genBlob({ f1: 1020, f2: 2000, f6: 24, f3: 100, f9: 80, f10: 20, model: "gemini-3-flash-a" });
  ins.run(0, g1, g1.length);
  ins.run(1, g2, g2.length);
  ins.run(2, null as any, 0); // empty/aborted generation → skipped
  db.run("CREATE TABLE trajectory_metadata_blob (data blob)");
  db.query("INSERT INTO trajectory_metadata_blob (data) VALUES (?)").run(
    new Uint8Array(strField(2, "file:///tmp/my%20proj")),
  );
  db.close();

  // brain/<id>/.system_generated/logs/transcript_full.jsonl — 2 tool calls.
  const logDir = join(baseDir, "brain", convId, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const lines = [
    { step_index: 0, type: "USER_INPUT", status: "DONE", created_at: "2026-01-01T00:00:00Z" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-01-01T00:00:01Z", tool_calls: [{ name: "list_dir", args: {} }] },
    { step_index: 2, type: "LIST_DIRECTORY", status: "DONE", created_at: "2026-01-01T00:00:03Z" }, // closes list_dir → 2000ms
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-01-01T00:00:04Z", tool_calls: [{ name: "view_file", args: {} }] },
    { step_index: 4, type: "VIEW_FILE", status: "DONE", created_at: "2026-01-01T00:00:05Z" }, // closes view_file → 1000ms
  ];
  writeFileSync(join(logDir, "transcript_full.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { baseDir, dbPath, convId };
}

async function collect(adapter: AntigravityAdapter, path: string): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of adapter.parseSession(path)) out.push(ev);
  return out;
}

test("parseSession merges .db tokens with transcript tools under one session", async () => {
  const { baseDir, dbPath, convId } = writeConversation();
  const adapter = new AntigravityAdapter({ baseDir });

  const events = await collect(adapter, dbPath);
  const tokens = events.filter((e) => e.kind === "tokens") as Extract<NormalizedEvent, { kind: "tokens" }>[];
  const tools = events.filter((e) => e.kind === "tool") as Extract<NormalizedEvent, { kind: "tool" }>[];
  const session = events.find((e) => e.kind === "session") as Extract<NormalizedEvent, { kind: "session" }>;

  // Tokens: two decoded generations (the null row skipped). Totals are EXACT.
  expect(tokens).toHaveLength(2);
  const input = tokens.reduce((s, t) => s + t.tokens.input, 0);
  const output = tokens.reduce((s, t) => s + t.tokens.output, 0);
  const reasoning = tokens.reduce((s, t) => s + (t.tokens.reasoning ?? 0), 0);
  expect(input).toBe((1020 + 5000 + 24) + (1020 + 2000 + 24));
  expect(output).toBe(50 + 20);
  expect(reasoning).toBe(250 + 80);
  // Grand total == input + Σf3 (the extractor's anchor).
  expect(input + output + reasoning).toBe(input + 300 + 100);
  expect(tokens.every((t) => t.costUsd == null)).toBe(true); // no native USD
  expect(tokens.every((t) => t.model === "gemini-3-flash-a")).toBe(true);

  // Tools: paired with the NEXT step's time → latency = the created_at delta.
  expect(tools.map((t) => t.toolName).sort()).toEqual(["list_dir", "view_file"]);
  const listDir = tools.find((t) => t.toolName === "list_dir")!;
  const viewFile = tools.find((t) => t.toolName === "view_file")!;
  expect(listDir.durationMs).toBe(2000);
  expect(viewFile.durationMs).toBe(1000);

  // Session: conv-id, decoded cwd (URI-decoded), pinned model, time window.
  expect(session.sessionId).toBe(convId);
  expect(session.cwd).toBe("/tmp/my proj");
  expect(session.model).toBe("gemini-3-flash-a");
  expect(session.startedAt).toBe("2026-01-01T00:00:00Z");
  expect(session.endedAt).toBe("2026-01-01T00:00:05Z");
});

test("parseSession emits nothing for an empty conversation (no tokens, no transcript)", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "antigravity-cli-"));
  const convId = "deadbeef-0000-0000-0000-000000000000";
  mkdirSync(join(baseDir, "conversations"), { recursive: true });
  const dbPath = join(baseDir, "conversations", `${convId}.db`);
  const db = new Database(dbPath);
  db.run("CREATE TABLE gen_metadata (idx integer, data blob, size integer)"); // zero rows
  db.close();

  const events = await collect(new AntigravityAdapter({ baseDir }), dbPath);
  expect(events).toHaveLength(0); // no session row written
});
