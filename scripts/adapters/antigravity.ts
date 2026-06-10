// Antigravity adapter — the FOURTH and hardest agent, saved for last because it
// breaks the most seam assumptions at once (master §10.2 / §15):
//
//   • Tokens live in a PROTOBUF BLOB inside a SQLite `.db`, NOT in JSONL. We read
//     the wire format directly (no .proto) — a ~40-line varint/length-delimited
//     reader ported byte-for-byte from the validated Python extractor
//     (docs/antigravity_token_extractor.py).
//   • Tools/latency live in a SEPARATE transcript JSONL. One session merges TWO
//     sources, joined on the conversation id — the seam's hardest case and the
//     reason base.ts's "multiple source files per session" requirement exists.
//   • No OTEL (Antigravity ships only to Google; do NOT enable its toggle).
//   • No native USD. Tokens are EXACT (decoded); cost is tokens-only.
//
// Data root: ~/.gemini/antigravity-cli/ (NOT ~/.gemini/antigravity/). Per conv id:
//   tokens ← conversations/<conv-id>.db, table `gen_metadata` (one BLOB row/gen),
//   tools  ← brain/<conv-id>/.system_generated/logs/transcript_full.jsonl,
//   cwd    ← conversations/<conv-id>.db, trajectory_metadata_blob (file://… URI).
//
// ── Glob the `.db`, not the transcript (deliberate departure from the phase doc's
//    literal transcript glob). The `.db` is the canonical "a conversation exists"
//    signal (every conv has exactly one; its basename IS the conv-id → a clean
//    session id) AND the token source (the headline deliverable). Globbing the
//    transcript instead would (a) collide — every file is named `transcript_full`,
//    so the orchestrator's basename-keyed re-parse gate can't tell sessions apart —
//    and (b) lose any conversation whose `.db` carries tokens but has no transcript.
//    The transcript is resolved as a sibling; absent/empty → tools degrade to none.
//    NB: the orchestrator's re-parse gate keys on the file basename (`<conv>.db`),
//    which never equals our session_id (`<conv>`), so antigravity re-parses every
//    tick. Harmless at this volume (2–3 sub-MB files); see memory/gotchas.
//
// ── Token field map (reverse-engineered 2026-06-08, re-confirmed on this machine).
//    Usage submessage at protobuf path top→field 1→field 4:
//      f1 = system-prompt tokens (~1020, fixed)   ┐
//      f2 = input/context tokens (variable)       ├─ input = f1 + f2 + f6
//      f6 = fixed input overhead (~24)            ┘
//      f3 = total output  (invariant f3 == f9 + f10, proven 89/89 on this machine)
//      f9  → reasoning (label inferred — prototype gap #2; first-class segment)
//      f10 → response output
//    We surface the SOLID figures (input total, grand total) as the verification
//    anchor and split output into f10 (output) + f9 (reasoning) so the schema's
//    disjoint buckets reconstruct the same total = input + f3. f1-as-cache and the
//    f9/f10 labels are INFERRED — we don't over-claim them, but reasoning is a
//    first-class segment for Antigravity exactly as it is for Codex.
//    Model id ← top→field 1→field 19 (e.g. "gemini-3-flash-a"); pinned but UNPRICED
//    (no Gemini rate in prices.yaml, by the never-guess rule), so the rack-rate
//    estimate is NULL — Antigravity is "model known, money-blind", not "model unknown".
//
// The adapter only PARSES; the orchestrator (sync_agents.ts) owns all DB writes and
// the live/ended decision.

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import type {
  AgentAdapter,
  AgentId,
  Fidelity,
  NormalizedEvent,
} from "./base.ts";
import { TOOL_DURATION_CAP_MS } from "./base.ts";

export interface AntigravityAdapterOptions {
  /** Absolute data root; defaults to ~/.gemini/antigravity-cli. */
  baseDir?: string;
  /** Relative glob under baseDir. The session index is the conversation `.db`. */
  glob?: string;
  /** From config/agents.yaml auto-detection. */
  enabled?: boolean;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function defaultBaseDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

// ── Protobuf wire reader (port of docs/antigravity_token_extractor.py) ──────────
// We only ever read small token varints + short strings, but varint decode uses
// multiplication (not <<) so a value past 31 bits can't silently wrap in JS.

type WireField = [wireType: number, value: number | Uint8Array];
type Parsed = Map<number, WireField[]>;

function readVarint(b: Uint8Array, i: number): [number, number] {
  let shift = 1;
  let val = 0;
  while (i < b.length) {
    const x = b[i]!;
    i += 1;
    val += (x & 0x7f) * shift;
    if (!(x & 0x80)) return [val, i];
    shift *= 128;
  }
  return [val, i];
}

function parseProto(b: Uint8Array): Parsed {
  const out: Parsed = new Map();
  let i = 0;
  const n = b.length;
  while (i < n) {
    const [tag, ti] = readVarint(b, i);
    i = ti;
    if (i > n) break;
    const fn = Math.floor(tag / 8);
    const wt = tag & 7;
    let v: number | Uint8Array;
    if (wt === 0) {
      [v, i] = readVarint(b, i);
    } else if (wt === 2) {
      let ln: number;
      [ln, i] = readVarint(b, i);
      v = b.subarray(i, i + ln);
      i += ln;
    } else if (wt === 1) {
      v = b.subarray(i, i + 8);
      i += 8;
    } else if (wt === 5) {
      v = b.subarray(i, i + 4);
      i += 4;
    } else {
      break; // unknown/illegal wire type → stop (defensive, per-row try/catch above)
    }
    const arr = out.get(fn);
    if (arr) arr.push([wt, v]);
    else out.set(fn, [[wt, v]]);
  }
  return out;
}

/** First length-delimited submessage at `fn`, recursively parsed. */
function sub(p: Parsed, fn: number): Parsed {
  for (const [wt, v] of p.get(fn) ?? []) {
    if (wt === 2 && v instanceof Uint8Array) return parseProto(v);
  }
  return new Map();
}

/** First varint value at `fn`, or undefined. */
function vint(p: Parsed, fn: number): number | undefined {
  for (const [wt, v] of p.get(fn) ?? []) {
    if (wt === 0 && typeof v === "number") return v;
  }
  return undefined;
}

/** First length-delimited value at `fn` decoded as UTF-8, or undefined. */
function vstr(p: Parsed, fn: number): string | undefined {
  for (const [wt, v] of p.get(fn) ?? []) {
    if (wt === 2 && v instanceof Uint8Array) return new TextDecoder().decode(v);
  }
  return undefined;
}

/** Per-generation token mapping from the usage submessage (top→f1→f4). */
export interface GenTokens {
  input: number;
  output: number;
  reasoning: number;
  model?: string;
}

/**
 * Decode one `gen_metadata.data` BLOB. Returns null for rows the validated
 * extractor skips (f2 or f3 absent — empty/aborted generation).
 * Exported for the unit test (golden fixtures).
 */
export function decodeGen(blob: Uint8Array): GenTokens | null {
  const top = sub(parseProto(blob), 1);
  const usage = sub(top, 4);
  const f1 = vint(usage, 1);
  const f2 = vint(usage, 2);
  const f3 = vint(usage, 3);
  const f6 = vint(usage, 6);
  const f9 = vint(usage, 9);
  const f10 = vint(usage, 10);
  if (f2 === undefined || f3 === undefined) return null;
  const input = (f1 ?? 0) + f2 + (f6 ?? 0);
  // Disjoint split: reasoning = f9, output = f10; total = input + f3 holds because
  // f3 == f9 + f10. If the split is absent, keep output = f3 (no reasoning claim).
  const reasoning = f9 ?? 0;
  const output = f9 !== undefined && f10 !== undefined ? f10 : f3;
  return { input, output, reasoning, model: vstr(top, 19) };
}

/** Recursively find the first decodable string matching `pred` anywhere in `p`. */
function findString(p: Parsed, pred: (s: string) => boolean, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  for (const fields of p.values()) {
    for (const [wt, v] of fields) {
      if (wt !== 2 || !(v instanceof Uint8Array)) continue;
      const s = new TextDecoder().decode(v);
      if (pred(s)) return s;
      // A length-delimited field may be a string OR a nested message; recurse.
      const found = findString(parseProto(v), pred, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** A tool invocation under construction; latency resolved as the next step's time. */
interface PendingTool {
  name: string;
  startTs: string;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly agentId: AgentId = "antigravity";
  readonly displayName = "Antigravity";
  readonly fidelity: Fidelity = "exact"; // tokens are DECODED, not estimated
  readonly enabled: boolean;

  private readonly baseDir: string;
  private readonly glob: string;

  constructor(opts: AntigravityAdapterOptions = {}) {
    this.baseDir = opts.baseDir ? expandHome(opts.baseDir) : defaultBaseDir();
    this.glob = opts.glob ?? "conversations/*.db";
    this.enabled = opts.enabled ?? true;
  }

  async sessionGlob(): Promise<string[]> {
    const out: string[] = [];
    try {
      const g = new Glob(this.glob);
      for await (const path of g.scan({ cwd: this.baseDir, absolute: true, onlyFiles: true })) {
        out.push(path);
      }
    } catch {
      // Missing baseDir (Antigravity not installed) → empty set, never throw.
    }
    return out;
  }

  supportsOtel(): boolean {
    // Antigravity has NO usable local OTLP — it ships telemetry only to Google
    // (Sentry, hardcoded antigravity-unleash.goog). Never enabled. JSONL/.db only.
    return false;
  }

  /**
   * `path` is a conversation `.db` (the session index). Tokens come from it; tools
   * from the sibling transcript JSONL; both are merged under one session keyed by
   * the conversation id. An empty conversation (no tokens AND no tools) yields
   * nothing — no session row is written.
   */
  async *parseSession(path: string): AsyncIterable<NormalizedEvent> {
    const convId = basename(path).replace(/\.db$/, "");
    // baseDir = .../antigravity-cli  (path = .../antigravity-cli/conversations/<id>.db)
    const root = dirname(dirname(path));
    const transcriptPath = join(
      root, "brain", convId, ".system_generated", "logs", "transcript_full.jsonl",
    );

    // ── 1. Transcript: tools/latency + the authoritative session time window. ──
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    const toolEvents: Extract<NormalizedEvent, { kind: "tool" }>[] = [];
    let pending: PendingTool[] = [];

    const trackTs = (ts: string) => {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    };

    const closePending = (endTs: string) => {
      for (const t of pending) {
        let durationMs: number | null = null;
        const start = Date.parse(t.startTs);
        const end = Date.parse(endTs);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          durationMs = Math.min(end - start, TOOL_DURATION_CAP_MS);
        }
        toolEvents.push({ kind: "tool", toolName: t.name, ts: t.startTs, durationMs, error: null });
      }
      pending = [];
    };

    try {
      const rl = createInterface({
        input: createReadStream(transcriptPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // skip a malformed line, never drop the session
        }
        const ts: string | undefined = typeof rec.created_at === "string" ? rec.created_at : undefined;
        if (ts) trackTs(ts);
        // A PLANNER_RESPONSE issues tool_calls; the very next step is the execution,
        // whose created_at closes the pending call(s) → latency. Close-before-push so
        // a tool's latency is (next step's time − issue time).
        if (ts && pending.length) closePending(ts);
        if (Array.isArray(rec.tool_calls)) {
          for (const tc of rec.tool_calls) {
            const name = typeof tc?.name === "string" ? tc.name : "unknown";
            pending.push({ name, startTs: ts ?? endedAt ?? startedAt ?? new Date(0).toISOString() });
          }
        }
      }
    } catch {
      // No transcript (e.g. aborted conv) → tools-only degrades to no tools. Fine.
    }
    // Any tool still pending at EOF had no following step → null latency.
    for (const t of pending) {
      toolEvents.push({ kind: "tool", toolName: t.name, ts: t.startTs, durationMs: null, error: null });
    }

    // Fallback time window for a transcript-less conversation: the .db mtime, a
    // single bucket (Antigravity is low-volume). The transcript is the authoritative
    // window when present; without it BOTH the token events AND the session meta must
    // still get a timestamp, or started_at lands NULL and the whole session is
    // excluded from every rollup and range predicate despite having decoded tokens.
    let fileTs: string | undefined;
    const fileMtime = (): string => {
      if (fileTs === undefined) {
        try { fileTs = statSync(path).mtime.toISOString(); } catch { fileTs = new Date(0).toISOString(); }
      }
      return fileTs;
    };

    // ── 2. Tokens: decode the gen_metadata protobuf rows; cwd from trajectory. ──
    const tokenEvents: Extract<NormalizedEvent, { kind: "tokens" }>[] = [];
    let model: string | undefined;
    let cwd: string | undefined;
    try {
      // Antigravity's conversation DBs are WAL-mode and may be live. Open via the
      // `immutable=1` URI: no locks taken, no -wal/-shm created, the file is treated
      // as read-only — the only mode that reliably reads another app's WAL DB without
      // mutating it. (A plain `{readonly:true}` open throws SQLITE_CANTOPEN on WAL.)
      const db = new Database(`file:${encodeURI(path)}?immutable=1`);
      try {
        // cwd: first file:// URI anywhere in the trajectory metadata protobuf.
        try {
          const meta = db.query("SELECT data FROM trajectory_metadata_blob LIMIT 1").get() as
            | { data: Uint8Array }
            | null;
          if (meta?.data) {
            const uri = findString(parseProto(meta.data), (s) => s.startsWith("file://"));
            if (uri) cwd = decodeURIComponent(uri.replace(/^file:\/\//, "")) || undefined;
          }
        } catch {
          /* trajectory blob absent/garbled → cwd stays undefined (best-effort). */
        }

        // Token events bucket by the transcript start when present, else the .db mtime.
        const tokenTs = startedAt ?? fileMtime();

        const rows = db.query("SELECT data FROM gen_metadata ORDER BY idx").all() as {
          data: Uint8Array | null;
        }[];
        for (const row of rows) {
          if (!row.data) continue;
          let gen: GenTokens | null;
          try {
            gen = decodeGen(row.data);
          } catch {
            continue; // defensive per-row: a corrupt BLOB skips one generation only
          }
          if (!gen) continue;
          if (gen.model) model = gen.model;
          tokenEvents.push({
            kind: "tokens",
            model: gen.model ?? model,
            timestamp: tokenTs,
            tokens: { input: gen.input, output: gen.output, reasoning: gen.reasoning },
            costUsd: null, // no native USD for Antigravity (tokens-only)
          });
        }
      } finally {
        db.close();
      }
    } catch {
      // Can't open the .db → tokens-only path is empty; tools (if any) still emit.
    }

    // ── 3. Empty conversation (no tokens AND no tools) → emit nothing. ──────────
    if (tokenEvents.length === 0 && toolEvents.length === 0) return;

    for (const ev of tokenEvents) yield ev;
    for (const ev of toolEvents) yield ev;

    yield {
      kind: "session",
      sessionId: convId,
      cwd,
      model, // gemini-3-flash-a: pinned but unpriced → estimated cost NULL
      // Fall back to the .db mtime so a transcript-less conversation (tokens but no
      // transcript) still gets a non-NULL start day and appears in rollups/ranges.
      startedAt: startedAt ?? fileMtime(),
      endedAt: endedAt ?? fileMtime(),
      source: "cli",
      // No branchCount (Antigravity is linear), no native cost, no rate-limit signal.
    };
  }
}
