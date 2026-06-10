// Full observability schema for the Command Centre.
//
// Phase 0 builds the COMPLETE observability schema up front so phases 1–4 only
// ever write rows — they never re-migrate (INDEX invariant #1). The "what" of
// every column traces to master spec §14 + ADR-0002 (cost_estimated_usd) +
// Phase 0 (reasoning_tokens, branch_count).
//
// Deliberately EXCLUDED (they belong to Phase 6 — Operations):
//   ops_tasks, ops_schedules, ops_decisions, ops_inbox, system_state,
//   notification_log.
//
// All tables are CREATE TABLE IF NOT EXISTS. Columns the master spec frames as
// additive deltas ([+MA]) are also funneled through the idempotent
// migrateAddColumn() helper, so the same db.ts upgrades a pre-existing DB and
// initializes a fresh one identically.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./paths.ts";

/** Open (creating if needed) a WAL-mode connection. Each thread opens its own. */
export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // WAL lets the ingest worker write while the main thread serves reads
  // (ADR-0001, load-bearing). busy_timeout absorbs the rare writer overlap.
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * Add a column only if it is absent. Returns true if it was added.
 * Idempotent — safe to call on every boot (INDEX invariant #1's mechanism).
 */
export function migrateAddColumn(
  db: Database,
  table: string,
  col: string,
  type: string,
): boolean {
  const cols = db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  if (cols.some((c) => c.name === col)) return false;
  db.run(`ALTER TABLE "${table}" ADD COLUMN ${col} ${type};`);
  return true;
}

const SCHEMA = /* sql */ `
-- One row per agent session. session_id PK; agent is the primary grouping axis.
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  source              TEXT,                                   -- ingest origin: ide | cowork
  agent               TEXT NOT NULL DEFAULT 'claude_code',    -- [+MA] claude_code|codex|pi|antigravity
  fidelity            TEXT NOT NULL DEFAULT 'exact',          -- TOKEN fidelity only: exact|estimated
  cwd                 TEXT,
  git_branch          TEXT,
  model               TEXT,
  started_at          TEXT,
  ended_at            TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_create_tokens INTEGER,
  reasoning_tokens    INTEGER,                                -- nullable; Codex reasoning_output, Antigravity f9
  total_tokens        INTEGER,
  effective_tokens    INTEGER,
  cost_usd            REAL,                                   -- native (Claude/Pi); NULL otherwise. Exact when present.
  cost_estimated_usd  REAL,                                   -- rack-rate (ADR-0002); always 'estimated'. NULL if model unpriced.
  duration_ms         INTEGER,
  error_count         INTEGER,
  rate_limit_hit      INTEGER,
  stop_reason         TEXT,
  branch_count        INTEGER,                                -- Pi tree metadata (distinct branch tips)
  title               TEXT,
  synced_at           TEXT
);
-- The re-parse gate looks sessions up by their source FILE PATH (basename ≠
-- session_id for codex/pi/antigravity), and most list/rollup queries filter by
-- (agent, started_at). Without these the gate lookup and every range scan are
-- full-table scans.
CREATE INDEX IF NOT EXISTS idx_sessions_agent_started ON sessions (agent, started_at);

-- Daily token rollup. [+MA] key gains 'agent': (date, agent, model, source).
CREATE TABLE IF NOT EXISTS token_usage (
  date                TEXT NOT NULL,                          -- YYYY-MM-DD local time
  agent               TEXT NOT NULL DEFAULT 'claude_code',
  model               TEXT NOT NULL DEFAULT '',
  source              TEXT NOT NULL DEFAULT '',
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, agent, model, source)
);

-- One row per tool invocation. [+MA] gains 'agent'; index (agent, tool_name, ts).
CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  agent       TEXT NOT NULL DEFAULT 'claude_code',
  tool_use_id TEXT,
  tool_name   TEXT,
  ts          TEXT,
  duration_ms INTEGER,                                        -- nullable; cap pairing at 10 min
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_name_ts ON tool_calls (agent, tool_name, ts);
-- Per-session DELETE (orchestrator re-parse) + the session-detail drill both
-- filter by session_id; without this they full-scan tool_calls.
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_id);

-- Normalized cross-agent daily burn rollup (master §11.2 + ADR-0002 estimated col).
CREATE TABLE IF NOT EXISTS burn_daily (
  date               TEXT NOT NULL,                           -- YYYY-MM-DD local time
  agent              TEXT NOT NULL,
  tokens             INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,                                    -- native; NULL for tokens-only agents
  cost_estimated_usd REAL,                                    -- rack-rate (ADR-0002); always 'estimated'
  fidelity           TEXT NOT NULL DEFAULT 'exact',
  driver             TEXT,                                    -- shipping|research|review|video|admin
  evidence           TEXT,
  PRIMARY KEY (date, agent)
);

-- Every OTLP log event (master §14). agent defaults claude_code (only OTEL emitter wired in P0).
CREATE TABLE IF NOT EXISTS otel_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name            TEXT,
  agent                 TEXT NOT NULL DEFAULT 'claude_code',
  session_id            TEXT,
  prompt_id             TEXT,
  timestamp             TEXT,
  model                 TEXT,
  tool_name             TEXT,
  tool_success          INTEGER,
  tool_duration_ms      INTEGER,
  tool_error            TEXT,
  cost_usd              REAL,
  api_duration_ms       INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_create_tokens   INTEGER,
  speed                 REAL,
  error_message         TEXT,
  status_code           INTEGER,
  attempt_count         INTEGER,
  skill_name            TEXT,
  skill_source          TEXT,
  prompt_length         INTEGER,
  decision              TEXT,
  decision_source       TEXT,
  request_id            TEXT,
  tool_result_size_bytes INTEGER,
  mcp_server_scope      TEXT,
  plugin_name           TEXT,
  plugin_version        TEXT,
  marketplace_name      TEXT,
  install_trigger       TEXT,
  mcp_server_name       TEXT,
  mcp_tool_name         TEXT,
  attributes            TEXT,                                 -- JSON catch-all: full flattened attr set (nothing lost)
  received_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_events_received ON otel_events (received_at);
CREATE INDEX IF NOT EXISTS idx_otel_events_name ON otel_events (event_name);

-- Every OTLP metric data point. Delta temporality -> SUM(value) is correct.
CREATE TABLE IF NOT EXISTS otel_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT,
  metric_type TEXT,                                           -- counter | gauge | histogram
  value       REAL,
  agent       TEXT NOT NULL DEFAULT 'claude_code',
  session_id  TEXT,
  model       TEXT,
  attributes  TEXT,                                           -- JSON: type/mcp/skill/agent attrs
  timestamp   TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics (metric_name);

-- OTLP trace spans (beta; guard against schema drift). Attributes kept as JSON.
CREATE TABLE IF NOT EXISTS otel_spans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id        TEXT,
  trace_id       TEXT,
  parent_span_id TEXT,
  name           TEXT,
  agent          TEXT NOT NULL DEFAULT 'claude_code',
  session_id     TEXT,
  start_time     TEXT,
  end_time       TEXT,
  duration_ms    INTEGER,
  attributes     TEXT,
  received_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans (trace_id);

-- Append-only system/activity log. Phase 0 writes 'sync_loop_heartbeat'.
CREATE TABLE IF NOT EXISTS activities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,                                   -- heartbeat|sync_loop_heartbeat|loop_detected|...
  detail     TEXT,
  metadata   TEXT,                                            -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_type_created ON activities (event_type, created_at);

-- Realtime in-flight session state (written by a Claude Code hook in later phases).
CREATE TABLE IF NOT EXISTS live_session_state (
  session_id   TEXT PRIMARY KEY,
  state        TEXT,
  current_tool TEXT,
  updated_at   TEXT
);

-- MCP server rollup stats (MCP panel — the Phase 1 centerpiece).
CREATE TABLE IF NOT EXISTS mcp_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server       TEXT,
  tools        INTEGER,
  total_tokens INTEGER,
  error        TEXT,
  measured_at  TEXT
);

-- Per-tool MCP schema token measurement (Phase 5).
CREATE TABLE IF NOT EXISTS mcp_schemas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server       TEXT,
  tool         TEXT,
  schema_json  TEXT,
  tokens       INTEGER,
  collected_at TEXT,
  UNIQUE (server, tool)
);

-- Skills registry (Skills page).
CREATE TABLE IF NOT EXISTS skills (
  name           TEXT PRIMARY KEY,
  environment    TEXT,                                        -- ide:project|ide:global|cowork:plugin|cowork:scheduled
  description    TEXT,
  path           TEXT,
  autonomy_level TEXT,                                        -- auto|review|manual
  user_invocable INTEGER,
  script_count   INTEGER,
  last_modified  TEXT
);
`;

/**
 * Create every observability table and run idempotent column migrations.
 * Safe to run on every boot, on both fresh and pre-existing databases.
 */
export function initSchema(db: Database): void {
  db.run(SCHEMA);

  // [+MA] / ADR-0002 columns, funneled through the idempotent helper so an
  // older DB created before these existed is upgraded in place (no-ops here on
  // a fresh DB since SCHEMA already declares them — proving idempotency).
  migrateAddColumn(db, "sessions", "agent", "TEXT NOT NULL DEFAULT 'claude_code'");
  migrateAddColumn(db, "sessions", "fidelity", "TEXT NOT NULL DEFAULT 'exact'");
  migrateAddColumn(db, "sessions", "reasoning_tokens", "INTEGER");
  migrateAddColumn(db, "sessions", "cost_estimated_usd", "REAL");
  migrateAddColumn(db, "sessions", "branch_count", "INTEGER");
  migrateAddColumn(db, "token_usage", "reasoning_tokens", "INTEGER NOT NULL DEFAULT 0");
  migrateAddColumn(db, "tool_calls", "agent", "TEXT NOT NULL DEFAULT 'claude_code'");
  migrateAddColumn(db, "burn_daily", "cost_estimated_usd", "REAL");

  // The source file path each session was parsed from — the stable key the
  // re-parse gate looks up (basename ≠ session_id for codex/pi/antigravity).
  // Added here (not in SCHEMA) so its index can be created after the column
  // exists on a pre-existing DB. Index, not unique: in the rare two-files-one-id
  // case the gate just degrades to redundant re-parse, never to wrong data.
  migrateAddColumn(db, "sessions", "source_path", "TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_source_path ON sessions (source_path);");
}

let singleton: Database | null = null;

/** Process-wide connection for the current thread (lazy, schema-initialized). */
export function getDb(): Database {
  if (singleton) return singleton;
  singleton = openDb();
  initSchema(singleton);
  return singleton;
}
