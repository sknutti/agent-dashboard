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

// GET /api/search — content search (mirrors scripts/wire.ts SearchResponse).
// Distinct from getSessions' metadata `q`: this MATCHes transcript text.
export interface SearchResult {
  session_id: string;
  agent: string;
  title: string | null;
  cwd: string | null;
  started_at: string | null;
  snippet: string;
}
export interface SearchResponse {
  q: string;
  results: SearchResult[];
  error?: string;
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
export const searchContent = (q: string) =>
  getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
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

// ── Prompt Library working files (editor slice) ─────────────────────────────
// Mirror core's working_files.rs serde (scripts/library_models.ts). Binary files
// carry size only — the editor renders a placeholder, never a textarea.

export type WorkingFileRole = "primary" | "ref";

export interface WorkingFileEntry {
  path: string;
  role: WorkingFileRole;
  is_text: boolean;
  size_bytes: number;
}

export type WorkingFileBytes =
  | { kind: "text"; text: string; ext: string | null }
  | { kind: "binary"; size: number };

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

/** One content-search match — mirrors core's `find::FindHit` (scripts/
 *  library_models.ts `SearchResult`). Each hit is one matching line in one
 *  primitive's working-copy PRIMARY file (ref files excluded in-core).
 *  `line_number` is 1-based; `line_text` is truncated with `…` past 500 chars. */
export interface LibrarySearchResult {
  kind: LibraryKind;
  name: string;
  line_number: number;
  line_text: string;
}

export const searchLibrary = (q: string) =>
  getJson<LibrarySearchResult[]>(`/api/library/search?q=${encodeURIComponent(q)}`);

// ── Prompt Library install / drift (write-flow slice, ADR-0008) ─────────────
// Mirror the bridge write models in scripts/library_models.ts (real Rust serde).
// Every per-target outcome is tagged on `kind`; `colliding_content` / `drifted`
// are NORMAL results the UI prompts on (two-phase confirm), NOT errors.

export type LibraryTargetOutcome =
  | { kind: "installed"; version: string }
  | { kind: "no_op_identical"; version: string }
  | { kind: "colliding_content"; version: string; conflicts: string[] };

export interface LibraryTargetResult {
  target: LibraryTarget;
  outcome: LibraryTargetOutcome;
}

export type LibraryInstallFailureKind =
  | { kind: "occupied_by_unexpected_kind"; path: string; expected: string; actual: string }
  | { kind: "io"; path: string; message: string }
  | { kind: "other"; message: string };

export interface LibraryTargetFailure {
  target: LibraryTarget;
  reason: LibraryInstallFailureKind;
}

export interface LibraryInstallSummary {
  successes: LibraryTargetResult[];
  failures: LibraryTargetFailure[];
}

export type LibraryUninstallOutcome =
  | { kind: "removed" }
  | { kind: "not_installed" }
  | { kind: "drifted"; conflicts: string[] };

export interface LibraryTargetUninstallResult {
  target: LibraryTarget;
  outcome: LibraryUninstallOutcome;
}

export interface LibraryUninstallSummary {
  successes: LibraryTargetUninstallResult[];
  failures: LibraryTargetFailure[];
}

export type LibraryDriftStatus =
  | { kind: "clean" }
  | { kind: "modified"; conflicts: string[] }
  | { kind: "missing"; missing: string[] };

export interface LibraryDriftReport {
  kind: LibraryKind;
  name: string;
  target: LibraryTarget;
  status: LibraryDriftStatus;
}

export interface LibraryInstalledTarget {
  target: LibraryTarget;
  installed_version: string;
  installed_at: string;
}

/** Outcome of a reimport-from-drift: pull a drifted install's on-disk bytes back
 *  into the library as a new version. Every variant is a RESULT the UI routes on
 *  (it rides HTTP 200 as data, not an error). Only `reimported` carries the
 *  non-fatal commit contract (the new version tree is git-tracked). */
export type LibraryReimportResult =
  | { kind: "reimported"; new_version: string; committed: boolean; commit_error: string | null }
  | { kind: "working_copy_dirty" }
  | { kind: "broken_source"; primary_path: string; raw_bytes: number[]; parse_error: string }
  | { kind: "not_installed" }
  | { kind: "install_missing" };

export interface LibraryImportResult {
  imported: number;
}

/** A library write that failed with a route-local `{code, message}` — carries the
 *  code so the UI can render the right route-local message (never the shell). */
export class LibraryApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LibraryApiError";
    this.code = code;
  }
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const obj = (data ?? {}) as Record<string, unknown>;
    const code = typeof obj.code === "string" ? obj.code : `http_${res.status}`;
    const message = typeof obj.message === "string" ? obj.message : `${path} -> ${res.status}`;
    throw new LibraryApiError(code, message);
  }
  return data as T;
}

const primPath = (kind: string, name: string) =>
  `/api/library/primitives/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

export const getInstallsForPrimitive = (kind: string, name: string) =>
  getJson<LibraryInstalledTarget[]>(`${primPath(kind, name)}/installs`);
/** Per-primitive drift — authoritative for the detail rows + post-write reload (D8). */
export const getDrift = (kind: string, name: string) =>
  getJson<LibraryDriftReport[]>(`${primPath(kind, name)}/drift`);
/** Whole-ledger drift — feeds explorer badges on the 30s poll. */
export const getDriftBatch = () => getJson<LibraryDriftReport[]>("/api/library/drift");

export const installPrimitive = (
  kind: string,
  name: string,
  opts: { targets: LibraryTarget[]; force?: boolean },
) => sendJson<LibraryInstallSummary>(`${primPath(kind, name)}/install`, "POST", opts);

export const uninstallPrimitive = (
  kind: string,
  name: string,
  opts: { targets: LibraryTarget[]; force?: boolean },
) => sendJson<LibraryUninstallSummary>(`${primPath(kind, name)}/install`, "DELETE", opts);

export const acknowledgeDrift = (kind: string, name: string, target: LibraryTarget) =>
  sendJson<Record<string, never>>(`${primPath(kind, name)}/acknowledge-drift`, "POST", { target });

/** Reimport a drifted install's on-disk bytes into the library as a new version
 *  (the INVERSE of install). All five LibraryReimportResult variants ride 200 as
 *  data the caller routes on: `working_copy_dirty` → confirm + retry with
 *  `discard_working`; `broken_source` → fix sheet + retry with `fixed_primary_text`. */
export const reimportInstall = (
  kind: string,
  name: string,
  opts: {
    source_target: LibraryTarget;
    version_label: string;
    notes?: string;
    discard_working?: boolean;
    fixed_primary_text?: string;
  },
) => sendJson<LibraryReimportResult>(`${primPath(kind, name)}/reimport`, "POST", opts);

export const importInstalls = () =>
  sendJson<LibraryImportResult>("/api/library/import-installs", "POST", {});

// ── Prompt Library working-file editor fetchers (editor slice) ──────────────
// Reads (list/read) use getJson; writes use sendJson so a route-local error code
// (working_file_exists / library_invalid_working_path / …) rides LibraryApiError
// to a route-local inline message — never the shell. The content read's ref path
// rides a query param (a path segment can't carry "/" for nested refs).

const wfPath = (kind: string, name: string) => `${primPath(kind, name)}/working-files`;

export const getWorkingFiles = (kind: string, name: string) =>
  getJson<WorkingFileEntry[]>(wfPath(kind, name));

export const readWorkingFile = (kind: string, name: string, path: string) =>
  getJson<WorkingFileBytes>(`${wfPath(kind, name)}/content?path=${encodeURIComponent(path)}`);

/** Save the PRIMARY file (parse-validated in-core before write). */
export const saveWorking = (kind: string, name: string, content: string) =>
  sendJson<Record<string, never>>(`${primPath(kind, name)}/working`, "POST", { content });

export const createWorkingFile = (kind: string, name: string, path: string, content: string) =>
  sendJson<Record<string, never>>(wfPath(kind, name), "POST", { path, content });

export const saveWorkingFile = (kind: string, name: string, path: string, content: string) =>
  sendJson<Record<string, never>>(wfPath(kind, name), "PUT", { path, content });

export const renameWorkingFile = (kind: string, name: string, oldPath: string, newPath: string) =>
  sendJson<Record<string, never>>(`${wfPath(kind, name)}/rename`, "PUT", {
    old_path: oldPath,
    new_path: newPath,
  });

export const deleteWorkingFile = (kind: string, name: string, path: string) =>
  sendJson<Record<string, never>>(wfPath(kind, name), "DELETE", { path });

// ── Prompt Library versioning / publishing fetchers (versioning slice) ──────
// Mirror scripts/library_models.ts. publish/set-current return a PublishResult
// even on a commit failure (the version mutation already succeeded — Decision
// 1+3); the UI renders `committed`/`commit_error` as a colorblind-safe cue, not
// an error. revert is a working-copy rewind (returns {}). read is a GET.

/** Per-version metadata (`version.yaml`). `notes` is optional (None on Rust). */
export interface LibraryVersionMetadata {
  created_at: string;
  notes?: string;
}

/** A frozen version's primary content + metadata, for the inspector. */
export interface LibraryPrimitiveVersionView {
  working: WorkingContent;
  metadata: LibraryVersionMetadata;
}

/** Outcome of a publish / set-current: the version mutation already succeeded;
 *  this reports the advisory git commit only. `commit_error` is git's legible
 *  remediation message, null when the commit succeeded OR was a no-op. */
export interface LibraryPublishResult {
  committed: boolean;
  commit_error: string | null;
}

/** Snapshot the working copy as a new immutable version, then commit. A
 *  re-published label → LibraryApiError("library_version_exists"). */
export const publishVersion = (kind: string, name: string, versionLabel: string, notes?: string) =>
  sendJson<LibraryPublishResult>(`${primPath(kind, name)}/versions`, "POST", {
    version_label: versionLabel,
    notes: notes ?? null,
  });

/** Move the current pointer (what a FUTURE install reads). Unknown label →
 *  LibraryApiError("library_version_not_found"). Working copy untouched. */
export const setCurrentVersion = (kind: string, name: string, versionLabel: string) =>
  sendJson<LibraryPublishResult>(`${primPath(kind, name)}/current-version`, "POST", {
    version_label: versionLabel,
  });

/** Rewind `working/` to a frozen version (overwrite + delete orphans). A
 *  library-content op, NOT a re-install; does not commit. */
export const revertToVersion = (kind: string, name: string, versionLabel: string) =>
  sendJson<Record<string, never>>(`${primPath(kind, name)}/revert`, "POST", {
    version_label: versionLabel,
  });

/** Read a frozen version's primary content + metadata for the inspector. */
export const readPrimitiveVersion = (kind: string, name: string, label: string) =>
  getJson<LibraryPrimitiveVersionView>(
    `${primPath(kind, name)}/versions/${encodeURIComponent(label)}`,
  );

// ── Prompt Library target-overlay fetchers (target-overlays slice) ──────────
// Reads (read merged view / list) use getJson; writes use sendJson so a route-
// local error (library_target_not_allowed / library_parse_error) rides
// LibraryApiError to an inline message, never the shell. The target rides a path
// segment (a closed enum value — no "/"). write/remove act on the PRIMARY overlay
// only (the reference surface); they never commit (working/targets/ is gitignored).

/** The merged primary for a (primitive, target) pair + whether an overlay file
 *  shadows the base. `has_overlay:false` ⇒ the view IS the base (read-only +
 *  "Add overlay"); `true` ⇒ the overlay exists and the tab is editable. */
export interface LibraryTargetView {
  working: WorkingContent;
  has_overlay: boolean;
}

/** One target's overlay surface — the relative paths under working/targets/. */
export interface LibraryOverlayList {
  target: LibraryTarget;
  paths: string[];
}

/** Read the merged primary for a target. A target outside allowed_targets →
 *  LibraryApiError("library_target_not_allowed"). */
export const readPrimitiveTarget = (kind: string, name: string, target: LibraryTarget) =>
  getJson<LibraryTargetView>(
    `${primPath(kind, name)}/targets/${encodeURIComponent(target)}`,
  );

/** Write the PRIMARY overlay for a target (parse-validated in-core before the
 *  atomic write; malformed → library_parse_error, disk unchanged). */
export const writeOverlay = (kind: string, name: string, target: LibraryTarget, content: string) =>
  sendJson<Record<string, never>>(
    `${primPath(kind, name)}/targets/${encodeURIComponent(target)}/overlay`,
    "PUT",
    { content },
  );

/** Remove the PRIMARY overlay for a target (idempotent; the merged view reverts
 *  to the base passthrough). */
export const removeOverlay = (kind: string, name: string, target: LibraryTarget) =>
  sendJson<Record<string, never>>(
    `${primPath(kind, name)}/targets/${encodeURIComponent(target)}/overlay`,
    "DELETE",
  );

/** List every target's overlay surface (one entry per target carrying ≥1 file). */
export const listOverlays = (kind: string, name: string) =>
  getJson<LibraryOverlayList[]>(`${primPath(kind, name)}/overlays`);

// ── Prompt Library metadata-editing fetcher (metadata-editing slice) ────────
// Edit the three editable fields (allowed_targets / display_name / author) and
// COMMIT — unlike overlays, metadata.yaml is git-tracked, so the result carries
// the same non-fatal {committed, commit_error} contract as publish (Slice 4).
// Dropping a target that still has overlay files → LibraryApiError(
// "library_target_removed_with_overlays") (409); the UI confirms and re-issues
// with discard_orphan_overlays:true. A kind-illegal target →
// LibraryApiError("library_target_not_allowed_for_kind") — but the form's
// checkboxes are constrained to the kind matrix, so that's defense-in-depth.

/** The editable subset sent to update_metadata. `display_name`/`author` send
 *  null to clear (the bridge collapses ""/null → drop the field). */
export interface LibraryMetadataUpdate {
  allowed_targets: LibraryTarget[];
  display_name: string | null;
  author: string | null;
  discard_orphan_overlays?: boolean;
}

/** The outcome of an update_metadata: the freshly-written metadata + the
 *  advisory git commit result (same non-fatal contract as LibraryPublishResult). */
export interface LibraryMetadataUpdateResult {
  metadata: LibraryPrimitiveMetadata;
  committed: boolean;
  commit_error: string | null;
}

/** Replace a primitive's editable metadata, then commit. Dropping a target with
 *  overlay files → LibraryApiError("library_target_removed_with_overlays")
 *  unless `discard_orphan_overlays` is set. */
export const updateMetadata = (kind: string, name: string, body: LibraryMetadataUpdate) =>
  sendJson<LibraryMetadataUpdateResult>(`${primPath(kind, name)}/metadata`, "PUT", body);

// ── Prompt Library lifecycle fetchers (lifecycle slice) ─────────────────────
// Structural CRUD over the library. create/delete/rename/duplicate/import edit
// the git-tracked tree, so each carries the non-fatal {committed, commit_error}
// contract (the library write already landed; the commit is advisory — render it
// as a colorblind-safe cue, never an error). A name collision →
// LibraryApiError("library_primitive_exists") (409). `delete`'s result rides 200
// as DATA the UI inspects — a bail (uninstall failures, dir untouched) is NOT an
// error. `forget` touches only installs.json (no commit). The clock is
// server-stamped route-side; the UI never sends created_at.

/** Outcome of a delete_primitive: the per-target force-uninstall summary the UI
 *  inspects, plus whether the dir was removed and the advisory commit. A bail
 *  (uninstall `failures` non-empty) → library_dir_removed:false, committed:false;
 *  the library survives and the UI surfaces the failures instead of success. */
export interface LibraryDeletePrimitiveResult {
  uninstall: LibraryUninstallSummary;
  library_dir_removed: boolean;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of a rename_primitive: how many installs.json records were rewritten
 *  to the new name (the "N installed copies keep the old name until reinstalled"
 *  caveat) + the advisory commit. */
export interface LibraryRenameResult {
  install_records_updated: number;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of a duplicate_primitive: the new name + the advisory commit. */
export interface LibraryDuplicateResult {
  new_name: string;
  committed: boolean;
  commit_error: string | null;
}

/** Outcome of an import_primitive_from_path (the local-path classify flavor, NOT
 *  url import). Every variant rides 200 as data the UI routes on. Only `imported`
 *  wrote a git-tracked tree, so only it carries commit fields; `not_classifiable`
 *  points the user at the bootstrap wizard. */
export type LibraryImportFromPathResult =
  | {
      kind: "imported";
      primitive_kind: LibraryKind;
      name: string;
      committed: boolean;
      commit_error: string | null;
    }
  | { kind: "already_exists"; primitive_kind: LibraryKind; name: string }
  | { kind: "not_classifiable"; reason: string };

/** Outcome of a forget_primitive: whether any installs.json record was dropped
 *  (idempotent — false when nothing matched). */
export interface LibraryForgetResult {
  removed: boolean;
}

/** Scaffold a new (blank) primitive, then commit. A name collision →
 *  LibraryApiError("library_primitive_exists") (409); a malformed name →
 *  "library_invalid_name" (422). Returns the advisory commit result. */
// --- URL import (Slice 10b) ------------------------------------------------
export interface LibraryRefFile {
  rel_path: string;
  /** Raw bytes as a JSON number array (the Vec<u8> wire convention). */
  content: number[];
}
export interface LibraryFetchedPrimitive {
  content: string;
  suggested_name: string;
  author: string | null;
  source_url: string;
  ref_files: LibraryRefFile[];
}

/** Fetch a primitive from a GitHub URL (the second egress). A network READ; the
 *  preview is reviewed before a separate create writes it. Disallowed/oversize/
 *  rate-limited fetches ride LibraryApiError (`library_unsupported_source_url` /
 *  `library_github_rate_limited` / `library_fetch_failed` / `library_bundle_invalid`). */
export const fetchPrimitiveFromUrl = (url: string) =>
  sendJson<LibraryFetchedPrimitive>("/api/library/import/fetch", "POST", { url });

/** Create a primitive — optionally SEEDED from a fetched preview (Slice 10b).
 *  Absent `imported` → the empty scaffold (byte-for-byte unchanged). */
export const createPrimitive = (
  kind: LibraryKind,
  name: string,
  imported?: LibraryFetchedPrimitive | null,
) =>
  sendJson<LibraryPublishResult>(
    "/api/library/primitives",
    "POST",
    imported ? { kind, name, imported } : { kind, name },
  );

/** Wipe a primitive — force-uninstall every target, rm -rf the dir, drop records,
 *  commit. The result rides 200 as data: inspect `library_dir_removed` +
 *  `uninstall.failures` before reporting success (a bail leaves the library). */
export const deletePrimitive = (kind: string, name: string) =>
  sendJson<LibraryDeletePrimitiveResult>(primPath(kind, name), "DELETE");

/** Rename a primitive's library dir + migrate its install records, then commit.
 *  A new_name collision → 409; a missing source → 404. */
export const renamePrimitive = (kind: string, name: string, newName: string) =>
  sendJson<LibraryRenameResult>(`${primPath(kind, name)}/rename`, "POST", { new_name: newName });

/** Duplicate a primitive's working copy (no versions/installs carried), then
 *  commit. A new_name collision → 409. */
export const duplicatePrimitive = (kind: string, name: string, newName: string) =>
  sendJson<LibraryDuplicateResult>(`${primPath(kind, name)}/duplicate`, "POST", { new_name: newName });

/** Import a primitive from a local path already under a recognized install root
 *  (the drag-drop fast path, NOT url import). The tagged result routes the UI:
 *  imported → reload+select; already_exists → "already in the library";
 *  not_classifiable → "not auto-importable" (→ bootstrap). */
export const importFromPath = (sourcePath: string) =>
  sendJson<LibraryImportFromPathResult>("/api/library/import-from-path", "POST", {
    source_path: sourcePath,
  });

/** Drop a primitive's installs.json records (the Reconcile "mark removed" action
 *  for a primitive whose library dir is already gone). No commit. */
export const forgetPrimitive = (kind: string, name: string) =>
  sendJson<LibraryForgetResult>(`${primPath(kind, name)}/forget`, "POST", {});

// ── bootstrap discovery wizard (bootstrap slice) ─────────────────────────────
// The first-run scan→review→execute flow. The HTTP bodies are the PARSED shapes
// (library_models.ts validated the bridge output), so `crossReferenced` is
// camelCase + flattened and each action carries its verbatim `raw` for re-send.

export type LibraryBootstrapClassification = "new" | "already_imported" | "drifted";

export interface LibraryBootstrapGroup {
  kind: LibraryKind;
  name: string;
  classification: LibraryBootstrapClassification;
}

export interface LibraryBootstrapSummary {
  new: number;
  already_imported: number;
  drifted: number;
  needs_manual_review: number;
}

export interface LibraryCrossReferenced {
  groups: LibraryBootstrapGroup[];
  needs_manual_review: { kind: LibraryKind; name: string }[];
  symlinked: number;
  unclassified: number;
  summary: LibraryBootstrapSummary;
}

/** One executable action. `raw` is the verbatim action object the bridge
 *  re-deserializes — the wizard re-sends it untouched (filtering = which `raw`s
 *  to include). */
export interface LibraryBootstrapAction {
  kind: LibraryKind;
  name: string;
  raw: Record<string, unknown>;
}

export interface LibraryBootstrapPlan {
  creates: LibraryBootstrapAction[];
  reimports: LibraryBootstrapAction[];
}

export interface LibraryBootstrapScanResult {
  crossReferenced: LibraryCrossReferenced;
  plan: LibraryBootstrapPlan;
}

export interface LibraryBootstrapSession {
  formatVersion: number;
  startedAt: string;
  raw: Record<string, unknown>;
}

export interface LibraryBootstrapSkippedItem {
  kind: LibraryKind;
  name: string;
  source_target: LibraryTarget;
  reason: "WorkingCopyDirty" | "InstallMissing";
}

export interface LibraryBootstrapExecuteSummary {
  backup_path: string | null;
  created: number;
  reimported: number;
  skipped: number;
  skipped_items: LibraryBootstrapSkippedItem[];
  committed: boolean | null;
  commit_error: string | null;
}

/** The raw plan/resume shapes re-sent to execute — the action objects' verbatim
 *  `raw`, never the lifted display view. */
export interface LibraryBootstrapExecuteBody {
  plan: { creates: Record<string, unknown>[]; reimports: Record<string, unknown>[] };
  resume?: Record<string, unknown> | null;
  excluded_ids: string[];
}

/** Scan the machine + cross-reference the library, returning the full
 *  classification + the derived executable plan (one bridge call). */
export const bootstrapScan = () =>
  getJson<LibraryBootstrapScanResult>("/api/library/bootstrap/scan");

/** Load the resumable bootstrap session (a prior partial run's checkpoint), or
 *  null on the first run. */
export const readBootstrapSession = () =>
  getJson<{ session: LibraryBootstrapSession | null }>("/api/library/bootstrap/session").then(
    (r) => r.session,
  );

/** Execute a (frontend-filtered) bootstrap plan. A partial run's skipped_items
 *  ride 200 as data; the session persists for Resume. */
export const bootstrapExecute = (body: LibraryBootstrapExecuteBody) =>
  sendJson<LibraryBootstrapExecuteSummary>("/api/library/bootstrap/execute", "POST", body);

/** Clear the bootstrap session (Discard / start over). Idempotent. */
export const clearBootstrapSession = () =>
  sendJson<Record<string, never>>("/api/library/bootstrap/session", "DELETE");

// --- Git remote sync (Slice 8) ---------------------------------------------
// push/pull are the only calls that egress. The PAT is write-only: it leaves the
// browser ONLY in setRemotePat's body and is NEVER read back (status returns the
// redacted form). Every fetcher rides sendJson so a precondition code
// (remote_not_configured / no_pat_stored / invalid_remote_url / git_failed)
// surfaces as a typed LibraryApiError the panel maps to an inline message.

export interface LibraryRemoteStatus {
  remote_url: string | null;
  /** The redacted PAT (e.g. `ghp_••••••••6789`) — never the raw token. */
  pat_redacted: string | null;
}
export interface LibraryScanFinding {
  path: string;
  line: number;
  kind: string;
  /** The verbatim offending bytes — shown so the user sees what tripped the gate. */
  matched: string;
}
export type LibraryPullResult =
  | { outcome: "ok" }
  | { outcome: "conflict"; conflict_count: number };
export type LibraryPullContinue =
  | { outcome: "done" }
  | { outcome: "still_conflicted"; conflict_count: number };
export type LibraryConflictKind = "current_txt" | "metadata_yaml" | "version_file" | "other";
export interface LibraryConflictEntry {
  path: string;
  kind: LibraryConflictKind;
}
export type LibraryConflictSide = "local" | "remote";

/** Remote URL + redacted PAT for the sync panel. */
export const getGitStatus = () => sendJson<LibraryRemoteStatus>("/api/library/git/status", "GET");
/** Validate + normalize the URL, wire `origin`, and persist it. Bad URL →
 *  LibraryApiError("invalid_remote_url"); no library → "library_unconfigured". */
export const configureRemote = (url: string) =>
  sendJson<{ remote_url: string }>("/api/library/git/remote", "POST", { url });
/** Store the PAT (write-only — never echoed back). Empty → "empty_pat". */
export const setRemotePat = (pat: string) =>
  sendJson<Record<string, never>>("/api/library/git/pat", "PUT", { pat });
/** Remove the stored PAT. Idempotent. */
export const deleteRemotePat = () =>
  sendJson<Record<string, never>>("/api/library/git/pat", "DELETE");
/** The secret-scan gate — run BEFORE push; the UI surfaces every finding. */
export const scanBeforePush = () =>
  sendJson<LibraryScanFinding[]>("/api/library/git/scan-before-push", "GET");
/** Commits ahead of the upstream — the "Push N" badge. */
export const getUnpushedCount = () =>
  sendJson<{ count: number }>("/api/library/git/unpushed-count", "GET");
/** Push (egress). no_pat_stored / remote_not_configured / git_failed are errors. */
export const gitPush = () => sendJson<Record<string, never>>("/api/library/git/push", "POST");
/** Pull --rebase (egress). A conflict rides 200 as `{outcome:"conflict",…}`. */
export const gitPull = () => sendJson<LibraryPullResult>("/api/library/git/pull", "POST");
/** Whether a rebase is paused awaiting conflict resolution. */
export const isPullPaused = () => sendJson<{ paused: boolean }>("/api/library/git/paused", "GET");
/** The classified conflict paths for the resolver. */
export const listPullConflicts = () =>
  sendJson<LibraryConflictEntry[]>("/api/library/git/conflicts", "GET");
/** One side of a conflicted file as text (`content` null if that side deleted it). */
export const readConflictBlob = (path: string, side: LibraryConflictSide) =>
  sendJson<{ content: string | null }>(
    `/api/library/git/conflicts/blob?path=${encodeURIComponent(path)}&side=${side}`,
    "GET",
  );
/** Stage the chosen side for `path`. */
export const resolveConflict = (path: string, side: LibraryConflictSide) =>
  sendJson<Record<string, never>>("/api/library/git/conflicts/resolve", "POST", { path, side });
/** Continue the rebase. `done` or `still_conflicted` (the resolver loops). */
export const continuePull = () =>
  sendJson<LibraryPullContinue>("/api/library/git/pull/continue", "POST");
/** Abort the rebase — unwind to the pre-pull state. */
export const abortPull = () => sendJson<Record<string, never>>("/api/library/git/pull/abort", "POST");
