// Pi adapter — the THIRD agent, the one that stresses two seam assumptions the
// first two didn't: tree-structured sessions (parentId branches) and native
// per-MESSAGE USD cost (master §10.2 / §10.6).
//
// Globs ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl (one dir per cwd). Each
// line is a flat record {type, id, parentId, timestamp(ISO), ...} forming a tree:
//   • session                 — {id, cwd, version}; session root, parentId absent.
//   • model_change            — {modelId, provider}; provider/model switch.
//   • thinking_level_change   — {thinkingLevel}; ignored for accounting.
//   • message                 — {message:{role, ...}} where role ∈
//       - assistant   → {model, provider, usage:{input,output,cacheRead,cacheWrite,
//                         totalTokens, cost:{...,total}}, stopReason, content[]}.
//                       content[] holds {type:"toolCall", id, name} blocks.
//       - toolResult  → {toolCallId, toolName, isError, content}.
//       - user        → prompt text (no accounting).
//
// Grounded against all 13 real session files on this machine (2026-06-09):
//
//   • DISJOINT token buckets (the INVERSE of Codex's overlapping ones): validated
//     285/285 assistant rows that
//         totalTokens == input + output + cacheRead + cacheWrite
//     with cacheRead ADDED on top of input (cacheRead>0 in 248 rows, never a subset).
//     So we map the four buckets DIRECTLY — no Codex-style subtraction — onto the
//     schema's disjoint shape: input→input, output→output, cacheRead→cacheRead,
//     cacheWrite→cacheCreate. (Copying codex.ts's `input -= cached` here would
//     UNDERCOUNT. The schema's `total = Σ buckets` then reconstructs exactly.)
//
//   • NATIVE per-message USD: usage.cost.total is the exact billed USD for that
//     assistant turn (sums to $8.35 across all 13 sessions). We emit ONE tokens
//     event per assistant row carrying that costUsd → the orchestrator sums them
//     into cost_usd (native), same dual-cost treatment Claude gets (ADR-0002).
//     Pi is a multi-PROVIDER client: model ids are the underlying provider's
//     (gpt-5.4 / gpt-5.5 / anthropic.claude-opus-4-6-v1 / gemini-3.1-pro-preview),
//     and a single session can switch models mid-stream — so model rides on each
//     per-row tokens event and the rack-rate estimate is computed per row.
//
//   • BRANCH SUMMATION (master §10.6, the headline Pi rule): totals must sum EVERY
//     assistant row — you were billed for abandoned branches too. We get this for
//     free by emitting one event per assistant row keyed by its unique record id;
//     each row is counted exactly once REGARDLESS of branch topology, so we never
//     traverse leaf-paths and never double-count a shared ancestor. NB: on THIS
//     machine all 13 real sessions are linear (zero parentId fan-out), so the
//     branch-safety of this approach is proven by the unit test on a synthetic
//     multi-branch fixture (pi.test.ts), not by the real data. branchCount (distinct
//     tree tips) is recorded as session metadata; it is 1 for a linear chain.
//
// The adapter only PARSES; the orchestrator (sync_agents.ts) owns all DB writes and
// the live/ended decision.

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
import { TOOL_DURATION_CAP_MS } from "./base.ts";

export interface PiAdapterOptions {
  /** Absolute sessions dir; defaults to ~/.pi/agent/sessions. */
  baseDir?: string;
  /** Relative glob under baseDir (one dir per cwd-slug, one file per session). */
  glob?: string;
  /** From config/agents.yaml auto-detection. */
  enabled?: boolean;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function defaultBaseDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** Number coercion that treats null/undefined/NaN as 0. */
function n(x: unknown): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

/** A tool invocation under construction, keyed by toolCallId, resolved at EOF. */
interface PendingTool {
  name: string;
  startTs?: string;
  endTs?: string;
  failed?: boolean;
}

export class PiAdapter implements AgentAdapter {
  readonly agentId: AgentId = "pi";
  readonly displayName = "Pi";
  readonly fidelity: Fidelity = "exact";
  readonly enabled: boolean;

  private readonly baseDir: string;
  private readonly glob: string;

  constructor(opts: PiAdapterOptions = {}) {
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
      // Missing baseDir (Pi not installed) → empty set, never throw.
    }
    return out;
  }

  supportsOtel(): boolean {
    // Pi OTEL is a plugin (`pi install npm:pi-otel` + `/otel start`), opt-in and
    // not yet wired/verified on this machine. Until then the OTEL-first /
    // JSONL-fallback rule (master §12.3) resolves to JSONL for Pi.
    return false;
  }

  async *parseSession(path: string): AsyncIterable<NormalizedEvent> {
    // Fallback session id: trailing UUID of `<ts>_<uuid>.jsonl`.
    const fileStem = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
    const uuidMatch = fileStem.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);

    let sessionId = uuidMatch?.[0] ?? fileStem;
    let cwd: string | undefined;
    let model: string | undefined; // last model seen → session-level attribution
    let startedAt: string | undefined;
    let lastTs: string | undefined;
    let lastStopReason: string | undefined;

    // Branch topology. A "tip" is a MESSAGE that is never anyone's parent.
    // Only `message` records are conversation turns; the control records
    // (session / model_change / thinking_level_change) form a disconnected
    // preamble — the real chain starts at a model_change with a null parent, and
    // the `session` record is an island, so counting any non-message node as a
    // tip over-reports by one on every linear session. We collect parentId refs
    // from ALL records (a message can be a control node's parent) but only treat
    // message ids as tip candidates.
    const messageIds = new Set<string>();
    const parentIds = new Set<string>();

    // toolCallId → invocation, resolved into tool events at EOF.
    const tools = new Map<string, PendingTool>();

    // Buffered per-row token events (one per assistant turn), flushed at EOF after
    // metadata (model/ids) is fully known. Order doesn't matter — the orchestrator
    // sums them.
    const tokenEvents: Extract<NormalizedEvent, { kind: "tokens" }>[] = [];

    let errorCount = 0;

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

      const ts: string | undefined = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
      trackTs(ts);
      if (typeof rec.id === "string" && rec.type === "message") messageIds.add(rec.id);
      if (typeof rec.parentId === "string") parentIds.add(rec.parentId);

      switch (rec.type) {
        case "session": {
          if (typeof rec.id === "string") sessionId = rec.id;
          if (typeof rec.cwd === "string") cwd = rec.cwd;
          break;
        }

        case "model_change": {
          // Provider-qualified model id (e.g. "gpt-5.4"); the per-message model on
          // assistant rows is authoritative, but keep this as a fallback.
          if (typeof rec.modelId === "string") model = rec.modelId;
          break;
        }

        case "message": {
          const m = rec.message;
          if (!m || typeof m !== "object") break;

          if (m.role === "assistant") {
            if (typeof m.model === "string") model = m.model;
            if (typeof m.stopReason === "string") lastStopReason = m.stopReason;

            const u = m.usage;
            if (u && typeof u === "object") {
              // DISJOINT buckets — direct map, NO subtraction (see header).
              const cost = u.cost && typeof u.cost === "object" ? u.cost : undefined;
              tokenEvents.push({
                kind: "tokens",
                model: typeof m.model === "string" ? m.model : model,
                timestamp: ts ?? lastTs ?? startedAt ?? new Date(0).toISOString(),
                tokens: {
                  input: n(u.input),
                  output: n(u.output),
                  cacheRead: n(u.cacheRead),
                  cacheCreate: n(u.cacheWrite),
                },
                // Native per-message USD; present on every real assistant row
                // (0 for a no-token turn). null only if the field is absent.
                costUsd: cost && cost.total != null ? n(cost.total) : null,
              });
            }

            // Tool invocations issued by this assistant turn.
            if (Array.isArray(m.content)) {
              for (const block of m.content) {
                if (block?.type === "toolCall" && typeof block.id === "string") {
                  const prev = tools.get(block.id);
                  tools.set(block.id, {
                    ...prev,
                    name: typeof block.name === "string" ? block.name : prev?.name ?? "unknown",
                    startTs: prev?.startTs ?? ts,
                  });
                }
              }
            }
          } else if (m.role === "toolResult") {
            const id = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
            const isError = m.isError === true;
            if (isError) errorCount += 1;
            if (id) {
              const prev = tools.get(id);
              tools.set(id, {
                ...prev,
                name: typeof m.toolName === "string" ? m.toolName : prev?.name ?? "unknown",
                startTs: prev?.startTs,
                endTs: ts,
                failed: isError,
              });
            }
          }
          break;
        }
      }
    }

    // Flush token events (one per assistant row → branch-summed by construction).
    for (const ev of tokenEvents) yield ev;

    // Resolve buffered tool calls. Latency = result.ts − issuing-assistant.ts
    // (capped); unpaired calls/results still emit with null latency.
    for (const [id, t] of tools) {
      let durationMs: number | null = null;
      if (t.startTs && t.endTs) {
        const start = Date.parse(t.startTs);
        const end = Date.parse(t.endTs);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          durationMs = Math.min(end - start, TOOL_DURATION_CAP_MS);
        }
      }
      yield {
        kind: "tool",
        toolName: t.name,
        toolUseId: id,
        ts: t.startTs ?? t.endTs ?? lastTs ?? startedAt ?? new Date(0).toISOString(),
        durationMs,
        error: t.failed ? "tool_error" : null,
      };
    }

    // Distinct tree tips: message ids never referenced as a parent. ≥1 for any
    // session with at least one message (linear chain → exactly 1).
    let branchCount = 0;
    for (const id of messageIds) if (!parentIds.has(id)) branchCount += 1;
    if (branchCount === 0) branchCount = 1;

    yield {
      kind: "session",
      sessionId,
      cwd,
      model,
      startedAt,
      endedAt: lastTs ?? null,
      stopReason: lastStopReason,
      errorCount,
      branchCount,
      source: "cli",
      // No title (Pi has no ai-title line). Native cost rides on per-row tokens.
    };
  }
}
