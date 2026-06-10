// Claude Code adapter — the REFERENCE JSONL parser (master §15, §10.2).
//
// Globs ~/.claude/projects/*/*.jsonl (one file per interactive session; subagent
// transcripts nested deeper under <proj>/<sid>/subagents/ are Phase 5 scope and
// excluded by the `*/*.jsonl` depth). Streams each file line-by-line so a 16k-line
// session never buffers whole.
//
// Grounded against real session files on this machine (see .claude/memory/gotchas.md):
//   • assistant lines: `.message.usage` (input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens), `.message.model`,
//     `.message.content[]` blocks (text | thinking | tool_use), `.timestamp`,
//     `.cwd`, `.gitBranch`, `.message.stop_reason`. Claude has NO separate
//     reasoning-token count (thinking folds into output) → reasoning stays absent.
//   • user lines: `.message.content[]` tool_result blocks
//     `{tool_use_id, is_error, content}`.
//   • `ai-title` lines: `.aiTitle` → session title.
//   • native cost: `result.total_cost_usd` only in `claude -p` print mode; absent
//     (null key) for interactive sessions → cost_usd NULL, OTEL supplies it instead.
//
// The adapter only PARSES; the orchestrator (sync_agents.ts) owns all DB writes,
// decides live/ended from file mtime, and computes rack-rate estimated cost.

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

export interface ClaudeAdapterOptions {
  /** Absolute projects dir; defaults to ~/.claude/projects. */
  baseDir?: string;
  /** Relative glob under baseDir; master spec uses the two-segment session glob. */
  glob?: string;
  /** From config/agents.yaml auto-detection. */
  enabled?: boolean;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Number coercion that treats null/undefined/NaN as 0. */
function n(x: unknown): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId: AgentId = "claude_code";
  readonly displayName = "Claude Code";
  readonly fidelity: Fidelity = "exact";
  readonly enabled: boolean;

  private readonly baseDir: string;
  private readonly glob: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.baseDir = expandHome(opts.baseDir ?? "~/.claude/projects");
    this.glob = opts.glob ?? "*/*.jsonl";
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
      // Missing baseDir (agent not installed) → empty set, never throw.
    }
    return out;
  }

  supportsOtel(): boolean {
    return true; // the only wired OTEL emitter today
  }

  async *parseSession(path: string): AsyncIterable<NormalizedEvent> {
    // Session id = filename stem (UUID); confirmed against `.sessionId` on lines.
    const fileStem = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;

    // Session-level metadata, refined as we read.
    let sessionId = fileStem;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let startedAt: string | undefined;
    let lastTs: string | undefined;
    let stopReason: string | undefined;
    let errorCount = 0;
    let rateLimitHit = false;
    let nativeCostUsd: number | null | undefined;

    // Claude Code splits ONE assistant message (one API response) across multiple
    // JSONL lines — one per content block (thinking / text / tool_use) — and each
    // line repeats the IDENTICAL full `usage` block. Summing every line 2–3×
    // over-counts tokens (and rack-rate cost). Emit usage once per unique message,
    // keyed by (message.id, requestId) like ccusage. Content-block/tool processing
    // still runs on every line — only the token emission is deduped.
    const seenUsageKeys = new Set<string>();
    // tool_use id → invocation, awaiting its tool_result for latency pairing.
    const pendingTools = new Map<string, { name: string; skillName: string | null; ts: string }>();
    // tool events are emitted on pairing; unpaired ones are flushed at EOF.
    const toolEvents: NormalizedEvent[] = [];

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

      if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
      trackTs(rec.timestamp);

      // Whole-session native cost (print mode only; usually a null key).
      if (typeof rec.total_cost_usd === "number") nativeCostUsd = rec.total_cost_usd;

      switch (rec.type) {
        case "assistant": {
          const msg = rec.message ?? {};
          if (typeof rec.cwd === "string") cwd = rec.cwd;
          if (typeof rec.gitBranch === "string") gitBranch = rec.gitBranch;
          if (typeof msg.model === "string" && msg.model !== "<synthetic>") model = msg.model;
          if (typeof msg.stop_reason === "string") stopReason = msg.stop_reason;

          const u = msg.usage;
          // Dedupe: skip if we've already counted this message's usage. A line
          // with usage but no stable id (id+requestId both absent) can't be
          // deduped, so it is always counted (matches ccusage).
          const usageKey =
            typeof msg.id === "string" || typeof rec.requestId === "string"
              ? `${msg.id ?? ""}|${rec.requestId ?? ""}`
              : null;
          const firstSeenUsage = usageKey === null || !seenUsageKeys.has(usageKey);
          if (usageKey !== null) seenUsageKeys.add(usageKey);
          if (u && typeof rec.timestamp === "string" && firstSeenUsage) {
            yield {
              kind: "tokens",
              model: typeof msg.model === "string" ? msg.model : model,
              timestamp: rec.timestamp,
              tokens: {
                input: n(u.input_tokens),
                output: n(u.output_tokens),
                cacheRead: n(u.cache_read_input_tokens),
                cacheCreate: n(u.cache_creation_input_tokens),
                // Claude folds reasoning into output → no reasoning segment.
              },
              costUsd: null, // interactive JSONL never stamps per-message cost
            };
          }

          const content = Array.isArray(msg.content) ? msg.content : [];
          for (const block of content) {
            if (block?.type === "tool_use" && typeof block.id === "string" && typeof rec.timestamp === "string") {
              const name = typeof block.name === "string" ? block.name : "unknown";
              // The Skill tool carries the invoked skill's name in its input; lift it
              // so per-skill attribution works straight from JSONL (no OTEL needed).
              const skillName =
                name === "Skill" && typeof block.input?.skill === "string" ? block.input.skill : null;
              pendingTools.set(block.id, { name, skillName, ts: rec.timestamp });
            }
          }
          break;
        }

        case "user": {
          const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
          for (const block of content) {
            if (block?.type !== "tool_result") continue;
            const useId = block.tool_use_id;
            const use = typeof useId === "string" ? pendingTools.get(useId) : undefined;
            const isError = block.is_error === true;
            if (isError) errorCount += 1;
            if (use) {
              pendingTools.delete(useId);
              const start = Date.parse(use.ts);
              const end = Date.parse(rec.timestamp ?? "");
              let durationMs: number | null = null;
              if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
                durationMs = Math.min(end - start, TOOL_DURATION_CAP_MS);
              }
              toolEvents.push({
                kind: "tool",
                toolName: use.name,
                toolUseId: useId,
                skillName: use.skillName,
                ts: use.ts,
                durationMs,
                error: isError ? extractErrorText(block.content) : null,
              });
            }
          }
          break;
        }

        case "ai-title": {
          if (typeof rec.aiTitle === "string") title = rec.aiTitle;
          break;
        }

        case "api-error":
        case "system": {
          const text = JSON.stringify(rec).toLowerCase();
          if (text.includes("rate limit") || text.includes("rate_limit")) rateLimitHit = true;
          break;
        }
      }
    }

    // Emit paired tool events (latency known). Unpaired tool_use blocks (no result
    // yet — e.g. a live session) are emitted with null duration so the call still
    // shows up; the orchestrator caps/handles nulls.
    for (const ev of toolEvents) yield ev;
    for (const [id, use] of pendingTools) {
      yield { kind: "tool", toolName: use.name, toolUseId: id, skillName: use.skillName, ts: use.ts, durationMs: null, error: null };
    }

    // Finally the session metadata event (carries the running totals' context).
    // endedAt = last activity timestamp; the orchestrator nulls it for files whose
    // mtime is within the live window (still-active sessions).
    yield {
      kind: "session",
      sessionId,
      cwd,
      gitBranch,
      model,
      startedAt,
      endedAt: lastTs ?? null,
      stopReason,
      title,
      errorCount,
      rateLimitHit,
      source: "ide",
      nativeCostUsd,
    };
  }
}

/** Pull a short error string out of a tool_result content (string or block array). */
function extractErrorText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    const first = content.find((b: any) => typeof b?.text === "string");
    if (first) return String(first.text).slice(0, 500);
  }
  return "error";
}
