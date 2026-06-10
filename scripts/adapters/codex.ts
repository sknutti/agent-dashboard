// Codex adapter — the second agent, first real exercise of the seam (master §10.2).
//
// Globs $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (date-bucketed, one file
// per session). Streams each file line-by-line. Records are flat
// `{type, timestamp, payload}` envelopes with type ∈ {session_meta, turn_context,
// response_item, event_msg}; the meaning is in payload.type.
//
// Grounded against all 306 real session files on this machine (2026-06-09):
//   • session_meta.payload: id (session id), cwd, source, cli_version, model_provider.
//   • turn_context.payload: cwd, model (e.g. "gpt-5.5"/"gpt-5.4"), timezone.
//   • event_msg/token_count.payload.info.total_token_usage — CUMULATIVE; the LAST
//     non-null one in the file is the session total. Its buckets OVERLAP, unlike
//     Claude's disjoint usage (validated 300/300 files):
//         total_tokens == input_tokens + output_tokens
//         cached_input_tokens ⊆ input_tokens
//         reasoning_output_tokens ⊆ output_tokens
//     We NORMALIZE to the disjoint row shape the schema + cost engine assume
//     (input -= cached, output -= reasoning, cacheRead = cached, reasoning kept),
//     so total reconstructs exactly and no token is double-priced. (First non-null
//     can lag: the very first token_count record carries `info: null`.)
//   • response_item/function_call ↔ function_call_output by call_id → tool latency;
//     custom_tool_call ↔ custom_tool_call_output likewise (e.g. apply_patch).
//   • event_msg/exec_command_end carries the real `duration` {secs,nanos} and
//     `exit_code` for shell tools — preferred for latency; exit_code≠0 flags error.
//
// Codex has NO native USD (cost_usd stays NULL); the rack-rate estimate (cost.ts)
// is its only money figure (ADR-0002). No cache-create concept. The adapter only
// PARSES; the orchestrator (sync_agents.ts) owns all DB writes and live/ended.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import type {
  AgentAdapter,
  AgentId,
  Fidelity,
  NormalizedEvent,
} from "./base.ts";

/** A paired duration longer than this is an orphan from a crashed session. */
const TOOL_DURATION_CAP_MS = 10 * 60 * 1000;

export interface CodexAdapterOptions {
  /** Absolute sessions dir; defaults to $CODEX_HOME/sessions (~/.codex/sessions). */
  baseDir?: string;
  /** Relative glob under baseDir; master spec uses the recursive date-bucket glob. */
  glob?: string;
  /** From config/agents.yaml auto-detection. */
  enabled?: boolean;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Default sessions dir, honouring $CODEX_HOME (Codex's own override). */
function defaultBaseDir(): string {
  const home = process.env.CODEX_HOME;
  return home ? join(expandHome(home), "sessions") : join(homedir(), ".codex", "sessions");
}

/** Number coercion that treats null/undefined/NaN as 0. */
function n(x: unknown): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

/** A tool invocation under construction, keyed by call_id, resolved at EOF. */
interface PendingTool {
  name: string;
  startTs: string;
  endTs?: string;
  /** Precise duration from exec_command_end {secs,nanos}, when present. */
  execDurationMs?: number;
  exitCode?: number;
  failed?: boolean;
}

export class CodexAdapter implements AgentAdapter {
  readonly agentId: AgentId = "codex";
  readonly displayName = "Codex";
  readonly fidelity: Fidelity = "exact";
  readonly enabled: boolean;

  private readonly baseDir: string;
  private readonly glob: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.baseDir = opts.baseDir ? expandHome(opts.baseDir) : defaultBaseDir();
    this.glob = opts.glob ?? "**/*.jsonl";
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
      // Missing baseDir (Codex not installed) → empty set, never throw.
    }
    return out;
  }

  supportsOtel(): boolean {
    // Codex OTEL is opt-in (`[otel]` in ~/.codex/config.toml) and version-dependent;
    // JSONL is the always-on baseline. Until the wizard wires + verifies it, the
    // OTEL-first/JSONL-fallback rule (master §12.3) resolves to JSONL for Codex.
    return false;
  }

  async *parseSession(path: string): AsyncIterable<NormalizedEvent> {
    // Fallback session id: the trailing UUID of `rollout-<ts>-<uuid>.jsonl`.
    const fileStem = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
    const uuidMatch = fileStem.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);

    let sessionId = uuidMatch?.[0] ?? fileStem;
    let cwd: string | undefined;
    let model: string | undefined;
    let source: string | undefined;
    let startedAt: string | undefined;
    let lastTs: string | undefined;
    let sawTaskComplete = false;

    // Per-model token attribution. total_token_usage is CUMULATIVE; we attribute
    // each record's DELTA to the model active at that point (the running
    // turn_context model). Emitting one tokens event per model lets the cost engine
    // price each segment at its own rate — a mid-session `/model` switch otherwise
    // prices the whole session at the LAST model (or NULLs it if that model is
    // unpriced). For a single-model session the deltas telescope to the last
    // cumulative, so output is byte-identical to the old single-event path.
    interface RawAcc { input: number; cached: number; output: number; reasoning: number }
    const perModel = new Map<string, RawAcc>();
    let prevInput = 0, prevCached = 0, prevOutput = 0, prevReasoning = 0;
    let anyUsage = false;
    let usageTs: string | undefined;

    // call_id → tool invocation, resolved into events at EOF.
    const tools = new Map<string, PendingTool>();

    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    const trackTs = (ts: unknown) => {
      if (typeof ts !== "string") return;
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // skip a malformed line, never drop the session
      }
      trackTs(rec.timestamp);
      const p = rec.payload ?? {};

      switch (rec.type) {
        case "session_meta": {
          if (typeof p.id === "string") sessionId = p.id;
          if (typeof p.cwd === "string") cwd = p.cwd;
          if (typeof p.source === "string") source = p.source;
          break;
        }

        case "turn_context": {
          if (typeof p.model === "string") model = p.model;
          if (typeof p.cwd === "string" && !cwd) cwd = p.cwd;
          break;
        }

        case "event_msg": {
          switch (p.type) {
            case "token_count": {
              const usage = p.info?.total_token_usage;
              // The first token_count carries `info: null`; only keep real ones.
              if (usage && typeof usage === "object") {
                const inT = n(usage.input_tokens), ca = n(usage.cached_input_tokens);
                const outT = n(usage.output_tokens), re = n(usage.reasoning_output_tokens);
                // Cumulative → this record's delta. A counter RESET (cumulative
                // drops, e.g. after compaction) starts a fresh epoch: treat the
                // current values as the delta rather than going negative.
                const reset = inT + outT < prevInput + prevOutput;
                const acc = perModel.get(model ?? "") ?? { input: 0, cached: 0, output: 0, reasoning: 0 };
                acc.input += Math.max(0, reset ? inT : inT - prevInput);
                acc.cached += Math.max(0, reset ? ca : ca - prevCached);
                acc.output += Math.max(0, reset ? outT : outT - prevOutput);
                acc.reasoning += Math.max(0, reset ? re : re - prevReasoning);
                perModel.set(model ?? "", acc);
                prevInput = inT; prevCached = ca; prevOutput = outT; prevReasoning = re;
                anyUsage = true;
                usageTs = typeof rec.timestamp === "string" ? rec.timestamp : usageTs;
              }
              break;
            }
            case "exec_command_end": {
              const id = p.call_id;
              if (typeof id === "string") {
                const t: PendingTool = tools.get(id) ?? { name: "exec_command", startTs: rec.timestamp };
                if (typeof p.exit_code === "number") t.exitCode = p.exit_code;
                const d = p.duration;
                if (d && typeof d === "object") {
                  t.execDurationMs = n(d.secs) * 1000 + n(d.nanos) / 1e6;
                }
                tools.set(id, t);
              }
              break;
            }
            case "task_complete": {
              sawTaskComplete = true;
              break;
            }
          }
          break;
        }

        case "response_item": {
          switch (p.type) {
            case "function_call":
            case "custom_tool_call": {
              const id = p.call_id;
              if (typeof id === "string") {
                const prev = tools.get(id);
                const name = typeof p.name === "string" ? p.name : prev?.name ?? "unknown";
                tools.set(id, {
                  ...prev,
                  name,
                  startTs: prev?.startTs ?? (typeof rec.timestamp === "string" ? rec.timestamp : ""),
                  // apply_patch reports failure inline via `status`.
                  failed: prev?.failed || p.status === "failed",
                });
              }
              break;
            }
            case "function_call_output":
            case "custom_tool_call_output": {
              const id = p.call_id;
              if (typeof id === "string") {
                const t: PendingTool = tools.get(id) ?? { name: "unknown", startTs: rec.timestamp };
                if (typeof rec.timestamp === "string") t.endTs = rec.timestamp;
                tools.set(id, t);
              }
              break;
            }
          }
          break;
        }
      }
    }

    // Emit one token event PER model, each normalized to disjoint buckets so the
    // schema's `total = Σ buckets` holds and each segment is priced at its own
    // model (cost.ts is called per token event by the orchestrator). For a
    // single-model session this is exactly one event identical to before.
    const tsForUsage = usageTs ?? lastTs ?? startedAt ?? new Date(0).toISOString();
    if (anyUsage) {
      for (const [key, acc] of perModel) {
        if (acc.input + acc.cached + acc.output + acc.reasoning === 0) continue;
        yield {
          kind: "tokens",
          model: key || undefined,
          timestamp: tsForUsage,
          tokens: {
            input: Math.max(0, acc.input - acc.cached),
            output: Math.max(0, acc.output - acc.reasoning),
            cacheRead: acc.cached,
            reasoning: acc.reasoning,
            // No cacheCreate: Codex has no cache-create concept.
          },
          costUsd: null, // Codex never stamps native USD → rack-rate estimate only.
        };
      }
    }

    // Resolve buffered tool calls into events. Prefer exec_command_end's precise
    // duration; else the function_call↔output timestamp gap (capped).
    let errorCount = 0;
    for (const [id, t] of tools) {
      let durationMs: number | null = null;
      if (typeof t.execDurationMs === "number") {
        durationMs = Math.min(t.execDurationMs, TOOL_DURATION_CAP_MS);
      } else if (t.endTs) {
        const start = Date.parse(t.startTs);
        const end = Date.parse(t.endTs);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          durationMs = Math.min(end - start, TOOL_DURATION_CAP_MS);
        }
      }
      const isError = t.failed === true || (t.exitCode != null && t.exitCode !== 0);
      if (isError) errorCount += 1;
      yield {
        kind: "tool",
        toolName: t.name,
        toolUseId: id,
        ts: t.startTs || lastTs || startedAt || new Date(0).toISOString(),
        durationMs,
        error: isError ? `exit_code ${t.exitCode ?? "fail"}` : null,
      };
    }

    // Session metadata. endedAt = last activity; the orchestrator nulls it for
    // files touched within the live window (still-active sessions).
    yield {
      kind: "session",
      sessionId,
      cwd,
      model,
      startedAt,
      endedAt: lastTs ?? null,
      stopReason: sawTaskComplete ? "task_complete" : undefined,
      errorCount,
      source: source ?? "cli",
      // No title (Codex has no ai-title line) and no native cost.
    };
  }
}
