// Typed client for the Command Centre API (master §16). Phase 1 wires every core
// panel; all reads are GET JSON, local-time bucketed server-side.

export type Range = "today" | "7d" | "30d" | "90d";
export type AgentId = "claude_code" | "codex" | "pi" | "antigravity";

export interface SystemHealth {
  ok: boolean;
  uptime_s: number;
  last_otel_event_age_s: number | null;
  last_sync_tick_age_s: number | null;
  last_worker_tick_at: string | null;
  rss_bytes: number;
  tz: string;
}

export interface Summary {
  sessions: number;
  tokens: number;
  tools: number;
  errors: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning: number;
  total: number;
}

export interface AgentCardData {
  id: AgentId;
  detected: boolean;
  otel: boolean;
  cost: "native" | "none";
  tokens: TokenCounts;
  cacheRate: number | null;
  sessions: number;
  tools: number;
  errors: number;
  costUsd: number | null; // native
  costEstimatedUsd: number | null; // rack-rate
  fidelity: "exact" | "estimated";
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

export interface SessionDetail {
  session: SessionRow & {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
    reasoning_tokens: number | null;
    rate_limit_hit: number;
    stop_reason: string | null;
    branch_count: number | null;
  };
  tools: { tool_use_id: string | null; tool_name: string; ts: string; duration_ms: number | null; error: string | null }[];
}

export interface LiveSession {
  session_id: string;
  agent: string;
  model: string | null;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  started_at: string | null;
  total_tokens: number | null;
  error_count: number | null;
  cost_estimated_usd: number | null;
}

export interface TokenUsage {
  range: string;
  rows: { date: string; agent: string; model: string; input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number }[];
  totals: { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number };
}

export interface CacheStats {
  range: string;
  hitRate: number | null;
  target: number;
  billableTokens: number;
  lowSample: boolean;
  trend: { date: string; hitRate: number | null }[];
}

export interface ToolLatency {
  range: string;
  tools: { tool: string; calls: number; paired: number; errors: number; errorRate: number; p50: number | null; p95: number | null; max: number | null }[];
}

export interface Outcomes {
  range: string;
  order: string[];
  days: { date: string; errored: number; rate_limited: number; truncated: number; unfinished: number; ok: number; total: number }[];
}

export interface McpServers {
  range: string;
  servers: { server: string; tools: number; calls: number; errors: number; avgMs: number | null; p95: number | null }[];
  source: "otel" | "jsonl";
}

export interface McpTools {
  range: string;
  server: string;
  tools: { tool: string; calls: number; errors: number; errorRate: number; p50: number | null; p95: number | null; max: number | null }[];
}

export interface Burn {
  range: string;
  rows: { date: string; agent: string; tokens: number; cost_usd: number | null; cost_estimated_usd: number | null; fidelity: string; driver: string | null; evidence: string | null }[];
  daily: { date: string; tokens: number; estUsd: number; nativeUsd: number | null }[];
  movingAvg: { date: string; avgTokens: number }[];
  scaleEquivalents: { label: string; value: number; divisor: number; note: string }[];
  totals: { tokens: number; estimatedUsd: number };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const getSystemHealth = () => getJson<SystemHealth>("/api/system/health");
export const getSummary = () => getJson<Summary>("/api/summary");
export const getAgents = (range: Range) => getJson<{ range: string; agents: AgentCardData[] }>(`/api/agents?range=${range}`);
export const getSessions = (q: { range?: Range; agent?: string; outcome?: string; limit?: number }) => {
  const p = new URLSearchParams();
  if (q.range) p.set("range", q.range);
  if (q.agent) p.set("agent", q.agent);
  if (q.outcome) p.set("outcome", q.outcome);
  if (q.limit) p.set("limit", String(q.limit));
  return getJson<{ total: number; limit: number; offset: number; sessions: SessionRow[] }>(`/api/sessions?${p}`);
};
export const getSessionDetail = (id: string) => getJson<SessionDetail>(`/api/sessions/${id}/details`);
export const getLive = () => getJson<{ sessions: LiveSession[] }>("/api/sessions/live");
export const getTokenUsage = (range: Range, agent?: string) =>
  getJson<TokenUsage>(`/api/usage/tokens?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getCache = (range: Range, agent?: string) =>
  getJson<CacheStats>(`/api/usage/cache?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getToolLatency = (range: Range, agent?: string) =>
  getJson<ToolLatency>(`/api/tools/latency?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getOutcomes = (range: Range, agent?: string) =>
  getJson<Outcomes>(`/api/sessions/outcomes?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getMcpServers = (range: Range) => getJson<McpServers>(`/api/mcp?range=${range}`);
export const getMcpTools = (server: string, range: Range) =>
  getJson<McpTools>(`/api/mcp/${encodeURIComponent(server)}/tools?range=${range}`);
export const getBurn = (range: "30d" | "90d", agent?: string) =>
  getJson<Burn>(`/api/burn?range=${range}${agent ? `&agent=${agent}` : ""}`);
