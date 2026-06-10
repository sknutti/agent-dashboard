// The AgentAdapter contract — the seam every agent plugs into.
//
// Phase 0 ships the CONTRACT only (no concrete adapter). It is deliberately
// designed against all FOUR real field maps (master §10.2) so the interface is
// not a speculative guess — we already have every shape on disk. The interface
// is finalized against the running Claude adapter in Phase 1 (INDEX invariant
// #2), but it must already support, from day one:
//
//   • Optional cost          — only Claude/Pi stamp native USD; Codex/Antigravity don't.
//   • Tree-structured sessions — Pi stores branches as a parentId tree (§10.6);
//                                tokens sum across ALL branches, branch count is metadata.
//   • Multiple source files per session — Antigravity reads tokens from a protobuf
//                                `.db` AND tools from a transcript `.jsonl`; the token
//                                figure is NOT sourced from JSONL at all.
//   • Per-figure fidelity     — `fidelity` here is TOKEN fidelity. Cost fidelity is
//                                implicit (native cost is exact, estimated cost is estimated).
//
// No Phase 0 code constructs a NormalizedEvent; the orchestrator runs an empty
// registry. This file exists so phases 1–4 only fill it in.
//
// ── Finalized in Phase 1 against the running Claude Code adapter (INDEX invariant
//    #2). One refinement was forced by reality: a session-level `nativeCostUsd`
//    (below). Written re-confirmation that the interface still admits the other
//    three field maps (master §10.2) with NO further change:
//      • Codex      — no native cost (session.nativeCostUsd + token.costUsd both
//                     omitted → cost NULL); tokens from the last cumulative
//                     `total_token_usage` → one `tokens` event; `reasoning` segment
//                     carried by TokenCounts.reasoning. ✓ admits.
//      • Pi         — PER-MESSAGE native USD → emit one `tokens` event per assistant
//                     row with `costUsd` set; branchCount on SessionMeta; tokens
//                     summed across all branches by the orchestrator. ✓ admits.
//      • Antigravity— tokens decoded from a sibling protobuf `.db` (not the JSONL):
//                     `sessionGlob()` returns conversation roots, `parseSession`
//                     resolves the `.db` for tokens + transcript for tools; no USD.
//                     The async-iterable contract is source-agnostic. ✓ admits.
//    No tree/branch or multi-file shape needed a signature change — only the
//    whole-session native-cost figure, which Pi also benefits from.

export type AgentId = "claude_code" | "codex" | "pi" | "antigravity";

/** Token fidelity of a figure. Tokens are `exact` for all four agents today. */
export type Fidelity = "exact" | "estimated";

/**
 * Normalized token counts. Every field except input/output is optional because
 * the agents disagree on which splits exist:
 *   - Codex/Antigravity have no `cache_create` concept.
 *   - `reasoning` exists for Codex (`reasoning_output_tokens`) and Antigravity (f9);
 *     it is a first-class segment (prototype gap #2), not folded into output.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  reasoning?: number;
  total?: number;
}

/** Session-level metadata. Tree/branch fields are Pi-specific but live here so
 *  the orchestrator never special-cases an agent. */
export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  /** ISO 8601. `endedAt` absent/null => session still active (re-parse next tick). */
  startedAt?: string;
  endedAt?: string | null;
  stopReason?: string;
  title?: string;
  errorCount?: number;
  rateLimitHit?: boolean;
  /** Pi: distinct branch tips in the parentId tree (§10.6). Metadata only. */
  branchCount?: number;
  /** Ingest origin where it still applies (Claude Code): "ide" | "cowork". */
  source?: string;
  /**
   * Whole-session native USD where the vendor stamps it once per session rather
   * than per message — Claude Code `result.total_cost_usd` (print mode only;
   * absent for interactive sessions → cost stays NULL). The orchestrator's native
   * cost for a session is `nativeCostUsd ?? Σ(token.costUsd)` — so an adapter uses
   * EITHER this (Claude) OR per-message `tokens.costUsd` (Pi), never both.
   * Exact when present; rack-rate `cost_estimated_usd` is computed downstream.
   */
  nativeCostUsd?: number | null;
}

/**
 * A single normalized event emitted by an adapter. Discriminated by `kind`.
 * The orchestrator (§10.5) writes these to `sessions` / `token_usage` /
 * `tool_calls` / `burn_daily`, tagging every row with `agent` + `fidelity`.
 */
export type NormalizedEvent =
  | ({ kind: "session" } & SessionMeta)
  | {
      kind: "tokens";
      model?: string;
      /** ISO 8601. The orchestrator buckets with DATE(ts, 'localtime'). */
      timestamp: string;
      tokens: TokenCounts;
      /** Native USD where the vendor stamps it (Claude/Pi); null/undefined otherwise.
       *  Rack-rate estimated cost is computed downstream (Phase 1), never here. */
      costUsd?: number | null;
    }
  | {
      kind: "tool";
      toolName: string;
      toolUseId?: string;
      /** ISO 8601 of the invocation. */
      ts: string;
      /** Pairing latency; null when unpaired. Each adapter caps an outlier pair at
       *  {@link TOOL_DURATION_CAP_MS} before emitting (the orchestrator does NOT —
       *  the earlier "orchestrator caps" note was wrong). */
      durationMs?: number | null;
      error?: string | null;
    };

/** Outlier cap for a start↔end tool pairing (10 min): a pairing wider than this is
 *  a parse artifact (interleaved/dropped events), not a real call. Single source of
 *  truth — each adapter imports this instead of redefining its own copy. */
export const TOOL_DURATION_CAP_MS = 10 * 60 * 1000;

/**
 * One module per agent. Knows how to find and parse that agent's own logs into
 * the shared {@link NormalizedEvent} shapes. The orchestrator owns all DB writes.
 */
export interface AgentAdapter {
  readonly agentId: AgentId;
  readonly displayName: string;
  /** Token fidelity for this agent's figures. */
  readonly fidelity: Fidelity;
  /** From config/agents.yaml (auto-detected at install). */
  readonly enabled: boolean;

  /**
   * Resolve the set of session sources to parse. Usually file paths, but for
   * Antigravity these are conversation roots whose tokens live in a sibling
   * `.db` and tools in a sibling `.jsonl` — `parseSession` resolves both.
   */
  sessionGlob(): Promise<string[]>;

  /**
   * Parse one session source into normalized events. Async-iterable so large
   * JSONL files stream rather than buffering. The orchestrator filters to
   * sources newer than `synced_at` or with `ended_at IS NULL` before calling.
   */
  parseSession(path: string): AsyncIterable<NormalizedEvent>;

  /** Only Claude Code returns true today (the only wired OTEL emitter). */
  supportsOtel(): boolean;
}

/** An adapter registry. Phase 0 runs an EMPTY one (no-op orchestrator). */
export type AdapterRegistry = readonly AgentAdapter[];
