// Orchestrator — runs in a WORKER THREAD (ADR-0001), owns ALL DB writes.
//
// Phase 0 proved the plumbing with an empty registry. Phase 1 lights up the
// Claude Code adapter: every CC_SYNC_INTERVAL_MS (default 120s), and once on boot,
// fan out over enabled adapters; for each session source newer than `synced_at`
// (or still active: `ended_at IS NULL`), parse normalized events and write
// `sessions` / `tool_calls`, then re-derive the `token_usage` + `burn_daily`
// rollups. Per-adapter try/catch keeps one agent's bad log from blocking others.
//
// Idempotency model (no per-session staging table — INDEX invariant #1):
//   • `sessions` rows are UPSERTed by session_id (totals = Σ token events).
//   • `tool_calls` are DELETEd-then-reinserted per session.
//   • `token_usage` is a pure derivation of `sessions` (DELETE+INSERT…SELECT),
//     bucketed by the session's local START day and final model. `burn_daily` is
//     likewise re-derived but UPSERTed so user driver/evidence overrides survive.
//   Simplification: a session's tokens attribute to its start-day/last-model
//   rather than per-message — correct for ~all real sessions, fully idempotent,
//   schema-clean. Per-message-day precision is a Phase 5 refinement if ever needed.

import { parentPort } from "node:worker_threads";
import { statSync } from "node:fs";
import type { AdapterRegistry, AgentAdapter, AgentId, NormalizedEvent } from "./adapters/base.ts";
import { ClaudeCodeAdapter } from "./adapters/claude_code.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { PiAdapter } from "./adapters/pi.ts";
import { AntigravityAdapter } from "./adapters/antigravity.ts";
import { estimateCostUsd } from "./cost.ts";
import { getDb } from "./db.ts";
import { loadAgentsConfig } from "./agents_config.ts";

const SYNC_INTERVAL_MS = Number(process.env.CC_SYNC_INTERVAL_MS ?? 120_000);
/** A file touched within this window is treated as a live (still-active) session. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

const db = getDb();

// ── Build the registry from config/agents.yaml ──────────────────────────────
// The ONE irreducible code binding: id → adapter constructor (a class can't live
// in YAML). Typed Record<AgentId, …> so the compiler forces every declared agent
// to have a constructor and rejects one for an undeclared id. Everything else
// (path, glob, enabled, name, order, cost) comes from agents_config.ts.
type AdapterOpts = { baseDir?: string; glob?: string; enabled?: boolean };
const ADAPTER_CTORS: Record<AgentId, (o: AdapterOpts) => AgentAdapter> = {
  claude_code: (o) => new ClaudeCodeAdapter(o),
  codex: (o) => new CodexAdapter(o),
  pi: (o) => new PiAdapter(o),
  antigravity: (o) => new AntigravityAdapter(o),
};

function buildRegistry(): AdapterRegistry {
  const out: AgentAdapter[] = [];
  for (const m of loadAgentsConfig()) {
    const ctor = ADAPTER_CTORS[m.id as AgentId];
    if (!ctor) {
      console.warn(`[sync] agents.yaml declares '${m.id}' but no adapter is registered for it — skipping`);
      continue;
    }
    out.push(ctor({ baseDir: m.path, glob: m.glob, enabled: m.enabled }));
  }
  return out;
}

const registry: AdapterRegistry = buildRegistry();

// ── Prepared statements ─────────────────────────────────────────────────────
const upsertSession = db.prepare(/* sql */ `
  INSERT INTO sessions (
    session_id, source, source_path, agent, fidelity, cwd, git_branch, model,
    started_at, ended_at, input_tokens, output_tokens, cache_read_tokens,
    cache_create_tokens, reasoning_tokens, total_tokens, effective_tokens,
    cost_usd, cost_estimated_usd, duration_ms, error_count, rate_limit_hit,
    stop_reason, branch_count, title, synced_at
  ) VALUES (
    $session_id, $source, $source_path, $agent, $fidelity, $cwd, $git_branch, $model,
    $started_at, $ended_at, $input_tokens, $output_tokens, $cache_read_tokens,
    $cache_create_tokens, $reasoning_tokens, $total_tokens, $effective_tokens,
    $cost_usd, $cost_estimated_usd, $duration_ms, $error_count, $rate_limit_hit,
    $stop_reason, $branch_count, $title, $synced_at
  )
  ON CONFLICT(session_id) DO UPDATE SET
    source=excluded.source, source_path=excluded.source_path, agent=excluded.agent,
    fidelity=excluded.fidelity,
    cwd=excluded.cwd, git_branch=excluded.git_branch, model=excluded.model,
    started_at=excluded.started_at, ended_at=excluded.ended_at,
    input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
    cache_read_tokens=excluded.cache_read_tokens,
    cache_create_tokens=excluded.cache_create_tokens,
    reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens,
    effective_tokens=excluded.effective_tokens, cost_usd=excluded.cost_usd,
    cost_estimated_usd=excluded.cost_estimated_usd, duration_ms=excluded.duration_ms,
    error_count=excluded.error_count, rate_limit_hit=excluded.rate_limit_hit,
    stop_reason=excluded.stop_reason, branch_count=excluded.branch_count,
    title=excluded.title, synced_at=excluded.synced_at
`);

const deleteToolCalls = db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`);
const insertToolCall = db.prepare(/* sql */ `
  INSERT INTO tool_calls (session_id, agent, tool_use_id, tool_name, skill_name, ts, duration_ms, error)
  VALUES ($session_id, $agent, $tool_use_id, $tool_name, $skill_name, $ts, $duration_ms, $error)
`);

// Gate lookup keys on the source FILE PATH, not the basename: codex/pi/antigravity
// session_ids never equal their filenames, so a basename key made all three
// re-parse every tick forever (see db.ts idx_sessions_source_path).
const selectSyncState = db.prepare(
  `SELECT synced_at, ended_at FROM sessions WHERE source_path = ?`,
);

// token_usage is a pure derivation of sessions → full rebuild per agent.
const clearTokenUsage = db.prepare(`DELETE FROM token_usage WHERE agent = ?`);
const rebuildTokenUsage = db.prepare(/* sql */ `
  INSERT INTO token_usage
    (date, agent, model, source, input_tokens, output_tokens,
     cache_read_tokens, cache_create_tokens, reasoning_tokens)
  SELECT DATE(started_at, 'localtime'), agent, COALESCE(model, ''), COALESCE(source, ''),
         SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
         SUM(COALESCE(cache_read_tokens, 0)), SUM(COALESCE(cache_create_tokens, 0)),
         SUM(COALESCE(reasoning_tokens, 0))
  FROM sessions
  WHERE agent = ? AND started_at IS NOT NULL
  GROUP BY 1, 2, 3, 4
`);

// burn_daily is re-derived too, but UPSERTed so user driver/evidence survive.
const selectBurnAgg = db.prepare(/* sql */ `
  SELECT DATE(started_at, 'localtime') AS date,
         SUM(COALESCE(total_tokens, 0)) AS tokens,
         SUM(cost_usd) AS cost_usd,
         SUM(cost_estimated_usd) AS cost_estimated_usd
  FROM sessions
  WHERE agent = ? AND started_at IS NOT NULL
  GROUP BY 1
`);
const upsertBurnDaily = db.prepare(/* sql */ `
  INSERT INTO burn_daily (date, agent, tokens, cost_usd, cost_estimated_usd, fidelity)
  VALUES ($date, $agent, $tokens, $cost_usd, $cost_estimated_usd, 'exact')
  ON CONFLICT(date, agent) DO UPDATE SET
    tokens=excluded.tokens, cost_usd=excluded.cost_usd,
    cost_estimated_usd=excluded.cost_estimated_usd, fidelity=excluded.fidelity
`);

const insertHeartbeat = db.prepare(
  `INSERT INTO activities (event_type, detail, metadata, created_at)
   VALUES ('sync_loop_heartbeat', ?, ?, ?)`,
);

// ── Retention sweep ─────────────────────────────────────────────────────────
// Without this, otel_* and activities grow forever (~720 heartbeat rows/day plus
// every telemetry event). The cutoff is computed as an ISO-Z string in JS and
// compared against the RAW column: both received_at and created_at are stored via
// toISOString(), so a raw lexical `< ?` is correct AND uses the received_at index.
// (A naive `< datetime('now','-90 days')` would compare an ISO 'T…Z' string to a
// space-separated 'YYYY-MM-DD HH:MM:SS' and silently match nothing — the #5 bug.)
const RETENTION_DAYS = (() => {
  const n = Number(process.env.CC_RETENTION_DAYS ?? 90);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
})();
const delOtelEvents = db.prepare(`DELETE FROM otel_events WHERE received_at < ?`);
const delOtelMetrics = db.prepare(`DELETE FROM otel_metrics WHERE received_at < ?`);
const delOtelSpans = db.prepare(`DELETE FROM otel_spans WHERE received_at < ?`);
const delActivities = db.prepare(`DELETE FROM activities WHERE created_at < ?`);
const sweepRetention = db.transaction((cutoff: string) => {
  delOtelEvents.run(cutoff);
  delOtelMetrics.run(cutoff);
  delOtelSpans.run(cutoff);
  delActivities.run(cutoff);
});

// Distinguish "this source genuinely has no sessions" from "the directory just
// disappeared / Full Disk Access was revoked": warn once when a previously
// non-empty adapter glob goes empty, instead of silently reporting zero data.
const lastFileCount = new Map<string, number>();

// ── Per-session aggregation + write ─────────────────────────────────────────
interface SessionAgg {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning: number;
  estUsd: number;
  anyPriced: boolean;
  nativeUsd: number;
  anyNative: boolean;
  meta: Extract<NormalizedEvent, { kind: "session" }> | null;
  tools: Extract<NormalizedEvent, { kind: "tool" }>[];
}

function emptyAgg(): SessionAgg {
  return {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0,
    estUsd: 0, anyPriced: false, nativeUsd: 0, anyNative: false,
    meta: null, tools: [],
  };
}

const writeSession = db.transaction(
  (agg: SessionAgg, endedAt: string | null, agent: string, fidelity: string, sourcePath: string) => {
  const m = agg.meta;
  if (!m) return;
  const total = agg.input + agg.output + agg.cacheRead + agg.cacheCreate + agg.reasoning;
  const effective = agg.input + agg.output + agg.cacheCreate + agg.reasoning;
  const startMs = m.startedAt ? Date.parse(m.startedAt) : NaN;
  const lastMs = m.endedAt ? Date.parse(m.endedAt) : NaN;
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(lastMs) && lastMs >= startMs
      ? lastMs - startMs
      : null;

  const nativeCost =
    m.nativeCostUsd != null ? m.nativeCostUsd : agg.anyNative ? agg.nativeUsd : null;

  upsertSession.run({
    $session_id: m.sessionId,
    $source: m.source ?? null,
    $source_path: sourcePath,
    $agent: agent,
    $fidelity: fidelity,
    $cwd: m.cwd ?? null,
    $git_branch: m.gitBranch ?? null,
    $model: m.model ?? null,
    $started_at: m.startedAt ?? null,
    $ended_at: endedAt,
    $input_tokens: agg.input,
    $output_tokens: agg.output,
    $cache_read_tokens: agg.cacheRead,
    $cache_create_tokens: agg.cacheCreate,
    $reasoning_tokens: agg.reasoning || null,
    $total_tokens: total,
    $effective_tokens: effective,
    $cost_usd: nativeCost,
    $cost_estimated_usd: agg.anyPriced ? agg.estUsd : null,
    $duration_ms: durationMs,
    $error_count: m.errorCount ?? 0,
    $rate_limit_hit: m.rateLimitHit ? 1 : 0,
    $stop_reason: m.stopReason ?? null,
    $branch_count: m.branchCount ?? null,
    $title: m.title ?? null,
    $synced_at: new Date().toISOString(),
  });

  deleteToolCalls.run(m.sessionId);
  for (const t of agg.tools) {
    insertToolCall.run({
      $session_id: m.sessionId,
      $agent: agent,
      $tool_use_id: t.toolUseId ?? null,
      $tool_name: t.toolName,
      $skill_name: t.skillName ?? null,
      $ts: t.ts,
      $duration_ms: t.durationMs ?? null,
      $error: t.error ?? null,
    });
  }
});

async function parseAndWrite(adapter: AgentAdapter, path: string, liveActive: boolean): Promise<void> {
  const agg = emptyAgg();
  for await (const ev of adapter.parseSession(path)) {
    if (ev.kind === "tokens") {
      agg.input += ev.tokens.input;
      agg.output += ev.tokens.output;
      agg.cacheRead += ev.tokens.cacheRead ?? 0;
      agg.cacheCreate += ev.tokens.cacheCreate ?? 0;
      agg.reasoning += ev.tokens.reasoning ?? 0;
      const est = estimateCostUsd(ev.model, ev.tokens);
      if (est.priced && est.usd != null) {
        agg.estUsd += est.usd;
        agg.anyPriced = true;
      }
      if (ev.costUsd != null) {
        agg.nativeUsd += ev.costUsd;
        agg.anyNative = true;
      }
    } else if (ev.kind === "tool") {
      agg.tools.push(ev);
    } else if (ev.kind === "session") {
      agg.meta = ev;
    }
  }
  if (!agg.meta) return;
  // Orchestrator owns the live/ended decision: a recently-touched file is still
  // active → ended_at NULL (keeps it in the re-parse set next tick).
  const endedAt = liveActive ? null : (agg.meta.endedAt ?? null);
  writeSession(agg, endedAt, adapter.agentId, adapter.fidelity, path);
}

/** Decide whether a file needs (re)parsing, and whether it's currently live. */
function reparseDecision(path: string): { reparse: boolean; liveActive: boolean } {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { reparse: false, liveActive: false };
  }
  const liveActive = Date.now() - mtimeMs < LIVE_WINDOW_MS;
  const row = selectSyncState.get(path) as { synced_at: string | null; ended_at: string | null } | null;
  if (!row) return { reparse: true, liveActive };
  if (row.ended_at === null) return { reparse: true, liveActive }; // still active
  const syncedMs = row.synced_at ? Date.parse(row.synced_at) : 0;
  return { reparse: mtimeMs > syncedMs, liveActive };
}

async function syncAdapter(adapter: AgentAdapter): Promise<number> {
  const files = await adapter.sessionGlob();
  const prev = lastFileCount.get(adapter.agentId);
  if (files.length === 0 && prev !== undefined && prev > 0) {
    console.warn(`[sync] ${adapter.agentId}: source went from ${prev} files to 0 — directory removed or Full Disk Access revoked? (not the same as 'no sessions')`);
  }
  lastFileCount.set(adapter.agentId, files.length);
  let synced = 0;
  for (const path of files) {
    const { reparse, liveActive } = reparseDecision(path);
    if (!reparse) continue;
    try {
      await parseAndWrite(adapter, path, liveActive);
      synced += 1;
    } catch (err) {
      console.error(`[sync] ${adapter.agentId} file ${path} failed:`, err);
    }
  }
  // Re-derive rollups only when a session actually changed. token_usage/burn_daily
  // are pure derivations of `sessions`; if nothing re-parsed they're already
  // current, and skipping avoids a per-tick DELETE+INSERT against a quiet DB.
  if (synced > 0) rederiveRollups(adapter.agentId);
  return synced;
}

const rederiveRollups = db.transaction((agentId: string) => {
  clearTokenUsage.run(agentId);
  rebuildTokenUsage.run(agentId);
  const rows = selectBurnAgg.all(agentId) as {
    date: string;
    tokens: number;
    cost_usd: number | null;
    cost_estimated_usd: number | null;
  }[];
  for (const r of rows) {
    upsertBurnDaily.run({
      $date: r.date,
      $agent: agentId,
      $tokens: r.tokens,
      $cost_usd: r.cost_usd,
      $cost_estimated_usd: r.cost_estimated_usd,
    });
  }
});

// ── Tick loop (unchanged scaffolding from Phase 0) ──────────────────────────
let tickCount = 0;
/** Reentrancy guard: the interval fires on a fixed clock, but a tick can run
 *  longer than the interval (large history, slow disk). Without this, ticks
 *  overlap and pile up, each re-globbing every file concurrently. */
let tickRunning = false;

async function tick(): Promise<void> {
  if (tickRunning) {
    console.warn(`[sync] tick ${tickCount} still running; skipping this interval`);
    return;
  }
  tickRunning = true;
  const startedMs = Date.now();
  tickCount += 1;
  let synced = 0;
  let sessions = 0;
  try {
    for (const adapter of registry) {
      if (!adapter.enabled) continue;
      try {
        sessions += await syncAdapter(adapter);
        synced += 1;
      } catch (err) {
        console.error(`[sync] adapter ${adapter.agentId} failed:`, err);
      }
    }
  } finally {
    tickRunning = false;
  }

  // Retention sweep ~hourly (every 30 ticks at the 120s default) and on first
  // boot — cheap range-deletes off the received_at/created_at indexes.
  if (tickCount === 1 || tickCount % 30 === 0) {
    try {
      sweepRetention(new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString());
    } catch (err) {
      console.error("[sync] retention sweep failed:", err);
    }
  }

  const elapsedMs = Date.now() - startedMs;
  const now = new Date().toISOString();
  insertHeartbeat.run(
    `tick ${tickCount}: ${synced}/${registry.length} adapters, ${sessions} sessions parsed in ${elapsedMs}ms`,
    JSON.stringify({ tick: tickCount, adapters: registry.length, synced, sessions, elapsedMs }),
    now,
  );
  parentPort?.postMessage({ type: "tick", tick: tickCount, at: now });
}

parentPort?.on("message", (msg: { type?: string }) => {
  if (msg?.type === "stop") {
    db.close();
    process.exit(0);
  }
});

if (process.argv.includes("--once")) {
  await tick();
  db.close();
  process.exit(0);
}

void tick();
setInterval(() => void tick(), SYNC_INTERVAL_MS);
