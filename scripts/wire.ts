// Shared API wire contracts (targeted slice of review #15).
//
// These are the response shapes for the drift-prone, money-bearing routes — the
// boundary where api.ts (client expectation) and routes.ts (server reality) had
// silently disagreed (Burn.estUsd was typed `number` while the route returns
// `null`; McpServers.source emitted the literal `0`). routes.ts now annotates
// these handlers against this contract, so the SERVER can no longer drift from
// it (the review's "the only layer that matters"). ui/src/lib/api.ts mirrors
// these — keep the two in sync; this file is the source of truth for the server.

import type { BurnRow, BurnDay } from "./burn.ts";

// Single canonical union lives in adapters/base.ts; re-exported here so the wire
// layer and base agree by construction (review #17 — was a 2nd hand-kept copy).
export type { AgentId } from "./adapters/base.ts";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning: number;
  total: number;
}

export interface AgentCardData {
  id: string;
  name: string;
  order: number;
  detected: boolean;
  otel: boolean;
  lastSessionAt: string | null;
  cost: "native" | "none";
  tokens: TokenCounts;
  cacheRate: number | null;
  sessions: number;
  tools: number;
  errors: number;
  costUsd: number | null; // native (exact)
  costEstimatedUsd: number | null; // rack-rate (estimated)
  fidelity: "exact" | "estimated";
}

export interface AgentsResponse {
  range: string;
  agents: AgentCardData[];
}

export interface SessionRow {
  session_id: string;
  agent: string;
  model: string | null;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  effective_tokens: number | null;
  error_count: number | null;
  cost_usd: number | null;
  cost_estimated_usd: number | null;
  duration_ms: number | null;
  fidelity: string;
  outcome: string;
}

export interface SessionsResponse {
  total: number;
  limit: number;
  offset: number;
  sessions: SessionRow[];
}

export interface BurnResponse {
  range: string;
  rows: (BurnRow & { fidelity: string; driver: string | null; evidence: string | null })[];
  daily: BurnDay[];
  movingAvg: { date: string; avgTokens: number }[];
  scaleEquivalents: { label: string; value: number; divisor: number; note: string }[];
  totals: { tokens: number; estimatedUsd: number | null };
}
