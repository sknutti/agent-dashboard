// Typed client for the Command Centre API (master §16). Phase 1 wires every core
// panel; all reads are GET JSON, local-time bucketed server-side.
//
// The money-bearing response shapes (AgentCardData, SessionRow, Burn, …) mirror
// scripts/wire.ts, which the server now annotates its handlers against (review
// #15) — so the SERVER can't drift from that contract. These client copies are
// kept in sync by hand (the Vite build is a separate package); when you change a
// response shape, change it in scripts/wire.ts AND here.

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
  name: string;
  order: number;
  detected: boolean;
  otel: boolean;
  /** Un-windowed MAX(started_at): distinguishes "no data ever" from "data exists
   *  outside the current range" (e.g. Pi's older sessions). Null = never seen. */
  lastSessionAt: string | null;
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

// Parsed Errors/Messages views. Mirrors scripts/error_context.ts + wire.ts —
// keep in sync (ADR-0005/0006). `thinking` is the agent's reasoning as its own
// Message; `ts` is the source line's timestamp (empty when the line carries none).
export interface DisplayMessage {
  role: "user" | "assistant" | "thinking" | "tool";
  text: string;
  isError: boolean;
  ts: string;
  toolName?: string;
  toolInput?: string;
}

export interface ErrorContext {
  toolName: string;
  toolInput: string;
  errorText: string;
  before: DisplayMessage[];
  after: DisplayMessage[];
  index: number;
}

export interface SessionErrors {
  supported: boolean;
  outcome: string;
  errors?: ErrorContext[];
  note?: string; // unsupported agent / missing raw log → defer to Messages
  failureNote?: string; // rate-limited / truncated: no Error to anchor
}

// GET /api/sessions/:id/messages (ADR-0006). Mirrors wire.ts SessionMessagesResponse.
// `live:true` → render the raw byte-tail (no messages); `live:false` → the whole
// parsed Transcript. `supported:false` carries a note (unsupported agent / missing log).
export interface SessionMessages {
  supported: boolean;
  live: boolean;
  messages?: DisplayMessage[];
  note?: string;
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
  tools: { tool: string; humanGated: boolean; calls: number; paired: number; errors: number; errorRate: number; p50: number | null; p95: number | null; max: number | null }[];
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
  // estUsd / totals.estimatedUsd are NULL when a day (or all days) are unpriced —
  // ADR-0002: never fabricate "$0". The route really returns null here; the type
  // must say so or a consumer doing `.toFixed()` crashes (was declared `number`).
  daily: { date: string; tokens: number; estUsd: number | null; nativeUsd: number | null }[];
  movingAvg: { date: string; avgTokens: number }[];
  scaleEquivalents: { label: string; value: number; divisor: number; note: string }[];
  totals: { tokens: number; estimatedUsd: number | null };
}

// ── Phase 5 long-tail ───────────────────────────────────────────────────────

export interface ProjectBreakdown {
  range: string;
  total: { sessions: number; eff: number };
  projects: { cwd: string; sessions: number; tokens: number; eff: number; tools: number; share: number }[];
}

export interface AgentFanout {
  range: string;
  totalCalls: number;
  sessions: { session_id: string; agent: string; title: string | null; cwd: string | null; started_at: string | null; agentCalls: number }[];
}

export interface EditDecisions {
  range: string;
  total: number;
  accepted: number;
  rejected: number;
  acceptRate: number | null;
  lowSample: boolean;
  byTool: { tool: string; accepted: number; rejected: number; acceptRate: number | null }[];
}

export interface HookActivity {
  range: string;
  totalFires: number;
  paired: number;
  avgMs: number | null;
  p50Ms: number | null;
  hooks: { hook: string; fires: number }[];
  daily: { date: string; fires: number }[];
}

export interface Productivity {
  range: string;
  commits: number;
  pullRequests: number;
  linesAdded: number;
  linesRemoved: number;
  empty: boolean;
  daily: { date: string; added: number; removed: number; commits: number; prs: number }[];
}

export interface Pressure {
  range: string;
  threshold: number;
  retryExhaustion: number;
  compaction: number;
  apiErrors: { timestamp: string; model: string | null; status_code: number | null; attempt_count: number | null; error_message: string | null }[];
}

export interface Patterns {
  window: number;
  days: { date: string; sessions: number; tokens: number; agents: Record<string, number> }[];
  maxSessions: number;
  agents: AgentId[];
  tokenSeries: { date: string; model: string; tokens: number }[];
}

export interface TopSkills {
  range: string;
  invocations: number;
  attributed: { skill: string; uses: number }[];
}

export interface Failures {
  range: string;
  total: number;
  failures: {
    session_id: string; agent: string; model: string | null; title: string | null;
    cwd: string | null; started_at: string | null; error_count: number | null;
    rate_limit_hit: number | null; stop_reason: string | null; outcome: string;
  }[];
}

export interface OtelEvent {
  id: number;
  event_name: string;
  session_id: string | null;
  model: string | null;
  tool_name: string | null;
  timestamp: string | null;
  received_at: string;
}

// ── Phase 5c skills & MCP ─────────────────────────────────────────────────

export interface SkillRow {
  name: string;
  environment: string;
  description: string | null;
  path: string;
  autonomy_level: string | null;
  user_invocable: number | null;
  script_count: number | null;
  last_modified: string | null;
}

export interface SkillsRegistry {
  total: number;
  skills: SkillRow[];
  facets: { environment: string; n: number }[];
}

export interface ContextHealth {
  settings: {
    exists: boolean; bytes: number; hooks: number;
    permissions: { allow: number; ask: number; deny: number };
    envKeys: number; mcpServers: number;
  };
  claudeMd: { exists: boolean; bytes: number; lines: number; directives: number };
}

export interface McpMeasure {
  range: string;
  servers: { server: string; tools: number; schemaTokens: number | null; measured: boolean }[];
  note: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const getSystemHealth = () => getJson<SystemHealth>("/api/system/health");
export const getSummary = () => getJson<Summary>("/api/summary");
export const getAgents = (range: Range) => getJson<{ range: string; agents: AgentCardData[] }>(`/api/agents?range=${range}`);
export const getSessions = (q: {
  range?: Range; agent?: string; outcome?: string; model?: string; source?: string;
  q?: string; limit?: number; offset?: number;
}) => {
  const p = new URLSearchParams();
  if (q.range) p.set("range", q.range);
  if (q.agent) p.set("agent", q.agent);
  if (q.outcome) p.set("outcome", q.outcome);
  if (q.model) p.set("model", q.model);
  if (q.source) p.set("source", q.source);
  if (q.q) p.set("q", q.q);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.offset) p.set("offset", String(q.offset));
  return getJson<{ total: number; limit: number; offset: number; sessions: SessionRow[] }>(`/api/sessions?${p}`);
};
export const getSessionDetail = (id: string) => getJson<SessionDetail>(`/api/sessions/${id}/details`);
export const getSessionErrors = (id: string) =>
  getJson<SessionErrors>(`/api/sessions/${encodeURIComponent(id)}/errors`);
export const getSessionMessages = (id: string) =>
  getJson<SessionMessages>(`/api/sessions/${encodeURIComponent(id)}/messages`);
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

// Phase 5 long-tail fetchers.
export const getProjectBreakdown = (range: Range, agent?: string) =>
  getJson<ProjectBreakdown>(`/api/sessions/by-project?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getAgentFanout = (range: Range, agent?: string) =>
  getJson<AgentFanout>(`/api/tools/agent-fanout?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getEditDecisions = (range: Range, agent?: string) =>
  getJson<EditDecisions>(`/api/tools/edit-decisions?range=${range}${agent ? `&agent=${agent}` : ""}`);
export const getHookActivity = (range: Range) => getJson<HookActivity>(`/api/hooks/activity?range=${range}`);
export const getProductivity = (range: Range) => getJson<Productivity>(`/api/activity/productivity?range=${range}`);
export const getPressure = (range: Range) => getJson<Pressure>(`/api/system/pressure?range=${range}`);

// Phase 5b activity fetchers.
export const getPatterns = (agent?: string) =>
  getJson<Patterns>(`/api/activity/patterns${agent ? `?agent=${agent}` : ""}`);
export const getTopSkills = (range: Range) => getJson<TopSkills>(`/api/activity/top-skills?range=${range}`);
export const getFailures = (range: Range, agent?: string) =>
  getJson<Failures>(`/api/activity/failures?range=${range}${agent ? `&agent=${agent}` : ""}`);

// Phase 5c skills & MCP fetchers.
export const getSkills = (environment?: string, userInvocable?: string) => {
  const p = new URLSearchParams();
  if (environment) p.set("environment", environment);
  if (userInvocable) p.set("user_invocable", userInvocable);
  return getJson<SkillsRegistry>(`/api/skills${p.toString() ? `?${p}` : ""}`);
};
export const syncSkills = () =>
  fetch("/api/skills/sync", { method: "POST" }).then((r) => r.json() as Promise<{ ok: boolean; synced: number }>);
export const setSkillAutonomy = (name: string, autonomy_level: string) =>
  fetch(`/api/skills/${encodeURIComponent(name)}/autonomy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autonomy_level }),
  }).then((r) => r.json());
export const getContextHealth = () => getJson<ContextHealth>("/api/context/health");
export const getMcpMeasure = (range: Range) => getJson<McpMeasure>(`/api/mcp/measure?range=${range}`);

// ── Prompt Library (read-only, ADR-0007) ───────────────────────────────────
// These mirror the bridge read models in scripts/library_models.ts (derived
// from the real Rust serde structs, NOT the prototype's flattened PrimitiveRow).
// Drift + per-target install records are deferred (Option A / C2), so no drift
// types live here. Kept in sync by hand like the rest of this file.

export type LibraryKind = "skill" | "agent" | "command" | "codex_agent";
export type LibraryTarget = "claude" | "pi" | "codex";

/** Per-Kind primary filename — a tagged union, not a bare string. */
export type PrimaryFilename =
  | { kind: "fixed"; value: string }
  | { kind: "templated"; extension: string };

export interface LibraryKindInfo {
  primary_filename: PrimaryFilename;
  allowed_targets: LibraryTarget[];
  supports_ref_files: boolean;
}
export type LibraryKindInfoTable = Record<LibraryKind, LibraryKindInfo>;

export interface LibraryTargetInfo {
  targets: { target: LibraryTarget; dir_name: string }[];
}

export interface LibraryPrimitiveSummary {
  kind: LibraryKind;
  name: string;
  /** Working copy differs from the pinned version. */
  dirty: boolean;
  author: string | null;
}

/** Working copy content — tagged on `kind` (md kinds vs codex_agent toml). */
export type WorkingContent =
  | { kind: "md"; frontmatter: string; body: string }
  | { kind: "toml"; text: string };

export interface LibraryPrimitiveMetadata {
  allowed_targets: LibraryTarget[];
  created_at: string;
  display_name?: string;
  author?: string;
  source_url?: string;
}

export interface LibraryPrimitiveDetail {
  kind: LibraryKind;
  name: string;
  metadata: LibraryPrimitiveMetadata;
  working: WorkingContent;
  versions: string[];
  current_version: string | null;
}

/** /api/library/status — `configured` is the dashboard-route wrapper around the
 *  bridge's git/marker status; the route always 200s so the UI can branch on it. */
export interface LibraryStatus {
  configured: boolean;
  is_valid: boolean;
  marker_exists: boolean;
  is_git_repo: boolean;
  branch: string | null;
  dirty: boolean | null;
  unpushed: boolean | null;
  /** Set when the bridge itself couldn't answer (binary missing, timeout, bad
   *  output). The route reports this as data (200) so the UI can act on it. */
  unavailable?: { code: string; message: string };
}

export const getLibraryStatus = () => getJson<LibraryStatus>("/api/library/status");
export const getLibraryKindInfo = () => getJson<LibraryKindInfoTable>("/api/library/kind-info");
export const getLibraryTargetInfo = () => getJson<LibraryTargetInfo>("/api/library/target-info");
export const getLibraryPrimitives = () =>
  getJson<LibraryPrimitiveSummary[]>("/api/library/primitives");
export const getLibraryPrimitiveDetail = (kind: string, name: string) =>
  getJson<LibraryPrimitiveDetail>(
    `/api/library/primitives/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
  );
