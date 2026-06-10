// Core observability API (master §16), Claude-data-only in Phase 1 but written
// agent-generic. Mounted on the Hono app by server.ts before the static handler.
//
// Conventions:
//   • All time buckets use DATE(col,'localtime') — local time everywhere (UTC
//     bucketing breaks evening sessions, master §15).
//   • ?range = today | 7d | 30d | 90d (default 7d). ?agent = all | <id>.
//   • OTEL-first / JSONL-fallback (master §12.3): where an OTEL-precise source
//     exists (MCP attribution, native cost) we prefer it when present and fall
//     back to JSONL. With telemetry off, JSONL is the only source — same code path.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { getDb } from "./db.ts";
import { syncSkills } from "./skills.ts";
import { mergeBurnByDate, type BurnRow } from "./burn.ts";
import { loadAgentsConfig, type AgentMeta } from "./agents_config.ts";
import type {
  AgentCardData,
  AgentsResponse,
  BurnResponse,
  SessionRow,
  SessionsResponse,
} from "./wire.ts";

// Agent identity is data-driven from config/agents.yaml (review #17) — no hardcoded
// id/name/path/cost lists here. Cached per server boot (the file changes only on
// install/edit, which restarts the process).
let agentMetaCache: AgentMeta[] | null = null;
function agentMeta(): AgentMeta[] {
  return (agentMetaCache ??= loadAgentsConfig());
}
function agentIds(): string[] {
  return agentMeta().map((m) => m.id);
}
function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// ── DB row shapes for the typed (non-`as any`) reads (review #15) ───────────
// bun:sqlite's query<Row, Params> returns typed rows, so a column typo or a
// shape mismatch is a compile error instead of an `any` that silently flows to
// the wire. Aggregates (SUM/COUNT) always return one row, so `.get(...)!` is safe.
interface CountRow { n: number }
interface AgentTokRow {
  input: number; output: number; cacheRead: number; cacheCreate: number;
  reasoning: number; total: number; sessions: number; errors: number;
  costUsd: number | null; costEstimatedUsd: number | null;
}

/** Local-date lower bound for a range, as a SQL expression (safe constant). */
function rangeStartSql(range: string): string {
  switch (range) {
    case "today":
      return "date('now','localtime')";
    case "30d":
      return "date('now','localtime','-29 days')";
    case "90d":
      return "date('now','localtime','-89 days')";
    default:
      return "date('now','localtime','-6 days')"; // 7d
  }
}

/** Range lower-bound predicate fragment (review #12). Exported for tests. */
export function rangePred(range: string, col = "started_at"): string {
  // The rollup tables (token_usage, burn_daily) store `date` as an ALREADY-LOCAL
  // YYYY-MM-DD — computed via DATE(started_at,'localtime') at rollup time. Wrapping
  // it in DATE(date,'localtime') AGAIN re-applied the local offset and shifted each
  // date back a day in zones west of UTC (Denver: '2026-06-10' → '2026-06-09'),
  // silently dropping the OLDEST day of every range on the Token-usage/Cache/Burn
  // panels. Compare the raw column: correct AND sargable (hits the date index
  // instead of full-scanning).
  if (col === "date") return `date >= ${rangeStartSql(range)}`;
  // Timestamp columns (sessions.started_at, tool_calls.ts, otel.timestamp) hold a
  // UTC instant, so DATE(col,'localtime') buckets to the local day — a single,
  // correct application. Left non-sargable on purpose: 'localtime' is
  // non-deterministic (SQLite rejects it in a generated column / index expression),
  // and a raw-ISO-bound rewrite would depend on every adapter storing an identical
  // lexical timestamp format — fragile for a marginal win on these small tables.
  return `DATE(${col},'localtime') >= ${rangeStartSql(range)}`;
}

/** Validate an agent id from the query; returns null for "all"/invalid. */
function agentFilter(agent: string | undefined): string | null {
  if (!agent || agent === "all") return null;
  return agentIds().includes(agent) ? agent : null;
}

/** Append an `<col> = ?` agent filter to a where[]/params[] pair (no-op for
 *  "all"/invalid, where agentFilter returns null). Collapses ~12 copy-pasted
 *  `if (agent) { where.push(...); params.push(agent); }` blocks (review #21). */
function pushAgent(where: string[], params: any[], agent: string | null, col = "agent"): void {
  if (agent) {
    where.push(`${col} = ?`);
    params.push(agent);
  }
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/** Outcome classification SQL (priority: errored > rate_limited > truncated > unfinished > ok). */
const OUTCOME_CASE = /* sql */ `
  CASE
    WHEN COALESCE(error_count,0) > 0 THEN 'errored'
    WHEN COALESCE(rate_limit_hit,0) = 1 THEN 'rate_limited'
    WHEN stop_reason IN ('max_tokens','length') THEN 'truncated'
    WHEN ended_at IS NULL THEN 'unfinished'
    ELSE 'ok'
  END`;

export function registerApiRoutes(app: Hono): void {
  const db = getDb();

  // ── Summary (KpiRow) ──────────────────────────────────────────────────────
  app.get("/api/summary", (c) => {
    const today = "DATE(started_at,'localtime') = date('now','localtime')";
    const s = db.query(/* sql */ `
      SELECT COUNT(*) AS sessions,
             COALESCE(SUM(total_tokens),0) AS tokens,
             COALESCE(SUM(error_count),0) AS errors
      FROM sessions WHERE ${today}`).get() as any;
    const tools = db.query(/* sql */ `
      SELECT COUNT(*) AS n FROM tool_calls WHERE DATE(ts,'localtime') = date('now','localtime')`).get() as any;
    return c.json({ sessions: s.sessions, tokens: s.tokens, tools: tools.n, errors: s.errors });
  });

  // ── Per-agent cards (ADR-0003) ────────────────────────────────────────────
  app.get("/api/agents", (c) => {
    const range = c.req.query("range") ?? "today";
    const out: AgentCardData[] = agentMeta().map((meta) => {
      const id = meta.id;
      // Detection derives from THIS agent's configured path (was a 3rd hardcoded
      // copy of the paths — wrong the moment a path was overridden in agents.yaml).
      const detected = meta.path ? existsSync(expandHome(meta.path)) : false;
      const tok = db.query<AgentTokRow, [string]>(/* sql */ `
        SELECT COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
               COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_create_tokens),0) cacheCreate,
               COALESCE(SUM(reasoning_tokens),0) reasoning, COALESCE(SUM(total_tokens),0) total,
               COUNT(*) sessions, COALESCE(SUM(error_count),0) errors,
               SUM(cost_usd) costUsd, SUM(cost_estimated_usd) costEstimatedUsd
        FROM sessions WHERE agent = ? AND ${rangePred(range)}`).get(id)!;
      const tools = db.query<CountRow, [string]>(/* sql */ `
        SELECT COUNT(*) n FROM tool_calls WHERE agent = ? AND ${rangePred(range, "ts")}`).get(id)!;
      const billable = tok.input + tok.cacheRead + tok.cacheCreate;
      const otel = db.query<CountRow, [string]>(
        `SELECT COUNT(*) n FROM otel_events WHERE agent = ? AND datetime(received_at) >= datetime('now','-7 days')`,
      ).get(id)!.n > 0;
      // Native cost — OTEL-first / JSONL-fallback (master §12.3). The two sources
      // describe the SAME spend and must NEVER be summed; OTEL wins when present
      // because it is complete, whereas JSONL native is print-mode-only and partial
      // (a single `claude -p` stamps e.g. $0.42 while OTEL holds the day's full $35).
      // Earlier this was JSONL-first, so one print session suppressed the OTEL total.
      const otelNative = otelNativeCost(db, id, range);
      const nativeUsd = otelNative != null ? otelNative : tok.costUsd;
      // Un-windowed last activity: lets the card distinguish "no data ever" (broken
      // / not installed) from "data exists, just outside the current range" — e.g.
      // Pi's Mar–Apr data is invisible at 7d/30d and otherwise reads as broken.
      const lastSessionAt = db.query<{ at: string | null }, [string]>(
        `SELECT MAX(started_at) at FROM sessions WHERE agent = ?`,
      ).get(id)!.at;
      return {
        id,
        name: meta.name,
        order: meta.order,
        detected,
        otel,
        lastSessionAt,
        cost: meta.cost, // from agents.yaml (was a hardcoded id ternary)
        tokens: {
          input: tok.input, output: tok.output, cacheRead: tok.cacheRead,
          cacheCreate: tok.cacheCreate, reasoning: tok.reasoning, total: tok.total,
        },
        cacheRate: billable > 0 ? tok.cacheRead / billable : null,
        sessions: tok.sessions,
        tools: tools.n,
        errors: tok.errors,
        costUsd: nativeUsd, // native: JSONL print-mode, else OTEL cost.usage
        costEstimatedUsd: tok.costEstimatedUsd, // rack-rate
        fidelity: "exact",
      };
    });
    return c.json({ range, agents: out } satisfies AgentsResponse);
  });

  // ── Agent registry (identity metadata, from agents.yaml) ──────────────────
  // The UI hydrates a store from this once at boot and derives every agent name,
  // sort order, and filter list from it (was AGENT_NAMES + ORDER + four hardcoded
  // chip lists). Pure identity — no DB, no range.
  app.get("/api/registry", (c) => {
    return c.json({
      agents: agentMeta().map((m) => ({
        id: m.id,
        name: m.name,
        order: m.order,
        enabled: m.enabled,
        cost: m.cost,
        otel: m.otel,
        detected: m.path ? existsSync(expandHome(m.path)) : false,
      })),
    });
  });

  // ── Sessions list (drill-downs) ───────────────────────────────────────────
  app.get("/api/sessions", (c) => {
    const range = c.req.query("range") ?? "30d";
    const agent = agentFilter(c.req.query("agent"));
    const outcome = c.req.query("outcome");
    const model = c.req.query("model");
    const source = c.req.query("source");
    const q = (c.req.query("q") ?? "").trim();
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const where: string[] = [rangePred(range)];
    const params: any[] = [];
    pushAgent(where, params, agent);
    if (model) { where.push("model = ?"); params.push(model); }
    if (source) { where.push("source = ?"); params.push(source); }
    if (outcome) { where.push(`(${OUTCOME_CASE}) = ?`); params.push(outcome); }
    if (q) { where.push("(title LIKE ? OR cwd LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
    const whereSql = where.join(" AND ");

    const total = db.query<CountRow, any[]>(`SELECT COUNT(*) n FROM sessions WHERE ${whereSql}`).get(...params)!.n;
    const rows = db.query<SessionRow, any[]>(/* sql */ `
      SELECT session_id, agent, model, cwd, git_branch, title, started_at, ended_at,
             total_tokens, effective_tokens, error_count, cost_usd, cost_estimated_usd,
             duration_ms, fidelity, ${OUTCOME_CASE} AS outcome
      FROM sessions WHERE ${whereSql}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return c.json({ total, limit, offset, sessions: rows } satisfies SessionsResponse);
  });

  // ── Session detail (timeline + token breakdown) ───────────────────────────
  app.get("/api/sessions/:id/details", (c) => {
    const id = c.req.param("id");
    const session = db.query(/* sql */ `
      SELECT session_id, agent, model, cwd, git_branch, title, started_at, ended_at,
             input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
             reasoning_tokens, total_tokens, effective_tokens, error_count, rate_limit_hit,
             stop_reason, branch_count, cost_usd, cost_estimated_usd, duration_ms, fidelity,
             ${OUTCOME_CASE} AS outcome
      FROM sessions WHERE session_id = ?`).get(id);
    if (!session) return c.json({ error: "not found" }, 404);
    const tools = db.query(/* sql */ `
      SELECT tool_use_id, tool_name, ts, duration_ms, error
      FROM tool_calls WHERE session_id = ? ORDER BY ts ASC`).all(id);
    return c.json({ session, tools });
  });

  // ── Live sessions (active in last 5 min) ──────────────────────────────────
  app.get("/api/sessions/live", (c) => {
    const rows = db.query(/* sql */ `
      SELECT session_id, agent, model, cwd, git_branch, title, started_at,
             total_tokens, error_count, cost_estimated_usd
      FROM sessions
      WHERE ended_at IS NULL
         OR datetime(ended_at) >= datetime('now','-5 minutes')
      ORDER BY started_at DESC`).all();
    return c.json({ sessions: rows });
  });

  // ── Live raw-JSONL feed (validated affordance: scrollable line feed) ───────
  app.get("/api/sessions/live/:sid/stream", (c) => {
    const sid = c.req.param("sid");
    if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) return c.json({ error: "bad sid" }, 400);
    const file = findSessionFile(sid);
    if (!file) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      // Tail by BYTE offset, reading only the appended range each poll. The old
      // code re-read the ENTIRE file (Bun.file().text() + split) every 1.5s per
      // viewer on the synchronous main thread — a multi-MB transcript stalled the
      // event loop on every tick. `carry` holds a trailing partial line (a session
      // mid-write may append a half line) until its newline arrives next poll.
      let bytePos = 0;
      let carry = "";
      const emit = async (initial: boolean) => {
        const size = statSync(file).size;
        if (size <= bytePos) return;
        const slice = await Bun.file(file).slice(bytePos, size).text();
        bytePos = size;
        const lines = (carry + slice).split("\n");
        carry = lines.pop() ?? ""; // last chunk is "" (ended on \n) or a partial line
        // On connect, only replay the last ~300 complete lines (one full read);
        // subsequent polls read just the new bytes.
        const toEmit = initial && lines.length > 300 ? lines.slice(-300) : lines;
        for (const line of toEmit) {
          if (line.length > 0) await stream.writeSSE({ data: line, event: "line" });
        }
      };
      await emit(true);
      // Poll up to 5 minutes. A keepalive on every idle tick keeps bytes flowing
      // < Bun.serve's 10s idleTimeout, which would otherwise close a quiet session
      // mid-stream (same bug as /api/firehose — see gotchas). The client only
      // listens for `line` events, ignoring these.
      for (let i = 0; i < 200 && !stream.aborted; i++) {
        await stream.sleep(1500);
        try {
          const before = bytePos;
          await emit(false);
          if (bytePos === before) await stream.writeSSE({ data: "", event: "keepalive" });
        } catch {
          break;
        }
      }
    });
  });

  // ── Token usage (stacked daily by agent+model) ────────────────────────────
  app.get("/api/usage/tokens", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range, "date")];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT date, agent, model,
             SUM(input_tokens) input, SUM(output_tokens) output,
             SUM(cache_read_tokens) cacheRead, SUM(cache_create_tokens) cacheCreate,
             SUM(reasoning_tokens) reasoning
      FROM token_usage WHERE ${where.join(" AND ")}
      GROUP BY date, agent, model ORDER BY date ASC`).all(...params);
    const totals = db.query(/* sql */ `
      SELECT COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
             COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_create_tokens),0) cacheCreate,
             COALESCE(SUM(reasoning_tokens),0) reasoning
      FROM token_usage WHERE ${where.join(" AND ")}`).get(...params);
    return c.json({ range, rows, totals });
  });

  // ── Cache efficiency ──────────────────────────────────────────────────────
  app.get("/api/usage/cache", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range, "date")];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const daily = db.query(/* sql */ `
      SELECT date,
             SUM(cache_read_tokens) cacheRead,
             SUM(input_tokens + cache_read_tokens + cache_create_tokens) billable
      FROM token_usage WHERE ${where.join(" AND ")}
      GROUP BY date ORDER BY date ASC`).all(...params) as any[];
    const totalRead = daily.reduce((a, r) => a + (r.cacheRead ?? 0), 0);
    const totalBillable = daily.reduce((a, r) => a + (r.billable ?? 0), 0);
    const trend = daily.map((r) => ({
      date: r.date,
      hitRate: r.billable > 0 ? r.cacheRead / r.billable : null,
    }));
    return c.json({
      range,
      hitRate: totalBillable > 0 ? totalRead / totalBillable : null,
      target: 0.7,
      billableTokens: totalBillable,
      lowSample: totalBillable < 10_000,
      trend,
    });
  });

  // ── Tool latency (p50/p95/max/error, sort by p95 desc) ────────────────────
  app.get("/api/tools/latency", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range, "ts")];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT tool_name, duration_ms, error FROM tool_calls
      WHERE ${where.join(" AND ")}`).all(...params) as any[];
    const byTool = new Map<string, { durs: number[]; calls: number; errors: number }>();
    for (const r of rows) {
      const t = byTool.get(r.tool_name) ?? { durs: [], calls: 0, errors: 0 };
      t.calls += 1;
      if (r.error != null) t.errors += 1;
      if (r.duration_ms != null) t.durs.push(r.duration_ms);
      byTool.set(r.tool_name, t);
    }
    const tools = [...byTool.entries()].map(([tool, t]) => {
      const s = t.durs.slice().sort((a, b) => a - b);
      return {
        tool,
        calls: t.calls,
        paired: s.length,
        errors: t.errors,
        errorRate: t.calls > 0 ? t.errors / t.calls : 0,
        p50: pct(s, 50),
        p95: pct(s, 95),
        max: s.length ? s[s.length - 1] : null,
      };
    });
    tools.sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1));
    return c.json({ range, tools });
  });

  // ── Session outcomes (mutually-exclusive daily buckets) ───────────────────
  app.get("/api/sessions/outcomes", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range)];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT DATE(started_at,'localtime') date, ${OUTCOME_CASE} outcome, COUNT(*) n
      FROM sessions WHERE ${where.join(" AND ")} AND started_at IS NOT NULL
      GROUP BY date, outcome ORDER BY date ASC`).all(...params) as any[];
    // Pivot to one row per day with all five buckets (summing cleanly to total).
    const ORDER = ["errored", "rate_limited", "truncated", "unfinished", "ok"];
    const byDate = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { errored: 0, rate_limited: 0, truncated: 0, unfinished: 0, ok: 0 };
      d[r.outcome] = r.n;
      byDate.set(r.date, d);
    }
    const days = [...byDate.entries()].map(([date, b]) => ({
      date, ...b, total: ORDER.reduce((a, k) => a + (b[k] ?? 0), 0),
    }));
    return c.json({ range, order: ORDER, days });
  });

  // ── MCP: servers (OTEL-first / JSONL-fallback) ────────────────────────────
  app.get("/api/mcp", (c) => {
    const range = c.req.query("range") ?? "7d";
    const calls = mcpCalls(db, range);
    const byServer = new Map<string, { durs: number[]; calls: number; tools: Set<string>; errors: number }>();
    for (const r of calls) {
      const s = byServer.get(r.server) ?? { durs: [], calls: 0, tools: new Set(), errors: 0 };
      s.calls += 1;
      s.tools.add(r.tool);
      if (r.error) s.errors += 1;
      if (r.durationMs != null) s.durs.push(r.durationMs);
      byServer.set(r.server, s);
    }
    const servers = [...byServer.entries()].map(([server, s]) => {
      const sorted = s.durs.slice().sort((a, b) => a - b);
      return {
        server, tools: s.tools.size, calls: s.calls, errors: s.errors,
        avgMs: sorted.length ? Math.round(s.durs.reduce((a, b) => a + b, 0) / sorted.length) : null,
        p95: pct(sorted, 95),
      };
    });
    servers.sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1));
    // `calls.length && …` would put the NUMBER 0 on the wire when empty (the
    // declared type is "otel" | "jsonl"); compare explicitly so source is a string.
    return c.json({ range, servers, source: calls.length > 0 && calls[0]!.otel ? "otel" : "jsonl" });
  });

  // ── MCP: per-tool breakdown (the centerpiece drill-down) ──────────────────
  app.get("/api/mcp/:server/tools", (c) => {
    const range = c.req.query("range") ?? "7d";
    const server = c.req.param("server");
    const calls = mcpCalls(db, range).filter((r) => r.server === server);
    const byTool = new Map<string, { durs: number[]; calls: number; errors: number }>();
    for (const r of calls) {
      const t = byTool.get(r.tool) ?? { durs: [], calls: 0, errors: 0 };
      t.calls += 1;
      if (r.error) t.errors += 1;
      if (r.durationMs != null) t.durs.push(r.durationMs);
      byTool.set(r.tool, t);
    }
    const tools = [...byTool.entries()].map(([tool, t]) => {
      const s = t.durs.slice().sort((a, b) => a - b);
      return {
        tool, calls: t.calls, errors: t.errors,
        errorRate: t.calls > 0 ? t.errors / t.calls : 0,
        p50: pct(s, 50), p95: pct(s, 95), max: s.length ? s[s.length - 1] : null,
      };
    });
    tools.sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1));
    return c.json({ range, server, tools });
  });

  // ── Burn (single-agent in Phase 1; built to take more) ────────────────────
  app.get("/api/burn", (c) => {
    const range = c.req.query("range") === "90d" ? "90d" : "30d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range, "date")];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query<BurnRow & { fidelity: string; driver: string | null; evidence: string | null }, any[]>(/* sql */ `
      SELECT date, agent, tokens, cost_usd, cost_estimated_usd, fidelity, driver, evidence
      FROM burn_daily WHERE ${where.join(" AND ")}
      ORDER BY date ASC`).all(...params);

    // Per-date totals via the pure, unit-tested fold (see scripts/burn.ts).
    // estUsd is null-preserving (all-unpriced day → "—", never "$0"). Native is
    // per-agent: Claude is OTEL-first / JSONL-print fallback (never summed), every
    // other agent's native adds on top. The Claude-only OTEL overlay must NOT bleed
    // into a non-Claude filter, so we pass an empty map unless the filter is
    // all-agents or claude_code.
    const claudeOtelByDate =
      agent === null || agent === "claude_code"
        ? otelNativeByDate(db, range)
        : new Map<string, number>();
    const daily = mergeBurnByDate(rows, claudeOtelByDate);
    const totalTokens = daily.reduce((a, d) => a + d.tokens, 0);
    // Null when EVERY day is unpriced (→ "—"); otherwise the sum of priced days.
    const pricedDays = daily.filter((d) => d.estUsd != null);
    const totalEst = pricedDays.length
      ? pricedDays.reduce((a, d) => a + (d.estUsd ?? 0), 0)
      : null;

    // 7-day moving average of daily total tokens.
    const movingAvg = daily.map((d, i) => {
      const window = daily.slice(Math.max(0, i - 6), i + 1);
      return { date: d.date, avgTokens: Math.round(window.reduce((a, w) => a + w.tokens, 0) / window.length) };
    });

    // Scale equivalents — math kept visible (never hide the arithmetic).
    const scaleEquivalents = [
      { label: "novels", value: +(totalTokens / 100_000).toFixed(1), divisor: 100_000, note: "≈100k tokens per novel" },
      { label: "hours of reading", value: +(totalTokens / 9_000).toFixed(1), divisor: 9_000, note: "≈9k tokens/hour at 150 wpm" },
    ];

    return c.json({
      range, rows, daily, movingAvg, scaleEquivalents,
      totals: { tokens: totalTokens, estimatedUsd: totalEst },
    } satisfies BurnResponse);
  });

  app.patch("/api/burn/:date", async (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "bad date" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { driver?: string; evidence?: string; agent?: string };
    const agent = agentFilter(body.agent) ?? "claude_code";
    db.query(/* sql */ `
      INSERT INTO burn_daily (date, agent, driver, evidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, agent) DO UPDATE SET
        driver = COALESCE(excluded.driver, driver),
        evidence = COALESCE(excluded.evidence, evidence)`)
      .run(date, agent, body.driver ?? null, body.evidence ?? null);
    return c.json({ ok: true, date, agent });
  });

  // ── Project breakdown (sessions rolled up by cwd) ─────────────────────────
  // Master §17 ProjectBreakdownCard. Effective tokens + sessions + tool count by
  // working directory; home-dir collapse + project-name basename are client-side
  // (format.ts) so we never hardcode a username here either.
  app.get("/api/sessions/by-project", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range), "cwd IS NOT NULL"];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT cwd, COUNT(*) sessions,
             COALESCE(SUM(effective_tokens),0) eff, COALESCE(SUM(total_tokens),0) tokens
      FROM sessions WHERE ${where.join(" AND ")}
      GROUP BY cwd`).all(...params) as any[];
    // Tool counts per cwd via a join under the same range/agent filter.
    const toolWhere = [rangePred(range, "t.ts"), "s.cwd IS NOT NULL"];
    const toolParams: any[] = [];
    pushAgent(toolWhere, toolParams, agent, "s.agent");
    const toolRows = db.query(/* sql */ `
      SELECT s.cwd cwd, COUNT(*) n
      FROM tool_calls t JOIN sessions s ON s.session_id = t.session_id
      WHERE ${toolWhere.join(" AND ")}
      GROUP BY s.cwd`).all(...toolParams) as any[];
    const toolByCwd = new Map(toolRows.map((r) => [r.cwd, r.n]));
    const totalEff = rows.reduce((a, r) => a + r.eff, 0);
    const projects = rows
      .map((r) => ({
        cwd: r.cwd, sessions: r.sessions, tokens: r.tokens, eff: r.eff,
        tools: toolByCwd.get(r.cwd) ?? 0,
        share: totalEff > 0 ? r.eff / totalEff : 0,
      }))
      .sort((a, b) => b.eff - a.eff)
      .slice(0, 40);
    return c.json({
      range,
      total: { sessions: rows.reduce((a, r) => a + r.sessions, 0), eff: totalEff },
      projects,
    });
  });

  // ── Agent fan-out (sessions that dispatched subagents) ────────────────────
  // Master §17 AgentFanoutCard. The Agent/Task tool is the subagent proxy —
  // count its calls per session. Title falls back to a session: prefix client-side.
  app.get("/api/tools/agent-fanout", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [rangePred(range, "t.ts"), "t.tool_name IN ('Agent','Task')"];
    const params: any[] = [];
    pushAgent(where, params, agent, "s.agent");
    const rows = db.query(/* sql */ `
      SELECT s.session_id, s.agent, s.title, s.cwd, s.started_at, COUNT(*) agentCalls
      FROM tool_calls t JOIN sessions s ON s.session_id = t.session_id
      WHERE ${where.join(" AND ")}
      GROUP BY s.session_id
      ORDER BY agentCalls DESC, s.started_at DESC
      LIMIT 50`).all(...params) as any[];
    return c.json({ range, totalCalls: rows.reduce((a, r) => a + r.agentCalls, 0), sessions: rows });
  });

  // ── Edit acceptance (accept/reject from tool_decision OTEL events) ────────
  // Master §17 EditAcceptanceCard. Source is the `tool_decision` OTEL event
  // (decision = accept*/reject*); with telemetry just enabled this is near-empty,
  // so the route reports lowSample (N<10) honestly rather than fabricating a rate.
  app.get("/api/tools/edit-decisions", (c) => {
    const range = c.req.query("range") ?? "7d";
    const agent = agentFilter(c.req.query("agent"));
    const EDIT = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
    const where = [
      "event_name = 'tool_decision'",
      `tool_name IN (${EDIT.map(() => "?").join(",")})`,
      rangePred(range, "timestamp"),
    ];
    const params: any[] = [...EDIT];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT tool_name, decision, COUNT(*) n FROM otel_events
      WHERE ${where.join(" AND ")}
      GROUP BY tool_name, decision`).all(...params) as any[];
    const byTool = new Map<string, { accepted: number; rejected: number }>();
    let accepted = 0, rejected = 0;
    for (const r of rows) {
      const isAccept = String(r.decision ?? "").startsWith("accept");
      const t = byTool.get(r.tool_name) ?? { accepted: 0, rejected: 0 };
      if (isAccept) { t.accepted += r.n; accepted += r.n; }
      else { t.rejected += r.n; rejected += r.n; }
      byTool.set(r.tool_name, t);
    }
    const total = accepted + rejected;
    return c.json({
      range, total, accepted, rejected,
      acceptRate: total > 0 ? accepted / total : null,
      lowSample: total < 10,
      byTool: [...byTool.entries()].map(([tool, t]) => ({
        tool, ...t,
        acceptRate: t.accepted + t.rejected > 0 ? t.accepted / (t.accepted + t.rejected) : null,
      })),
    });
  });

  // ── Hook activity (start/complete pairs, FIFO per session, 60s cap) ───────
  // Master §16/§17 HookActivityCard. hook_name lives in the attributes JSON, so
  // per-hook grouping + pairing is done in JS; daily fires use local-time SQL.
  app.get("/api/hooks/activity", (c) => {
    const range = c.req.query("range") ?? "7d";
    const rows = db.query(/* sql */ `
      SELECT event_name, session_id, timestamp, attributes FROM otel_events
      WHERE event_name IN ('hook_execution_start','hook_execution_complete')
        AND ${rangePred(range, "timestamp")}
      ORDER BY timestamp ASC`).all() as any[];
    const pending = new Map<string, number[]>(); // session_id -> FIFO of start ms
    const byHook = new Map<string, number>(); // hook_name -> fires (starts)
    const durations: number[] = [];
    let totalFires = 0;
    for (const r of rows) {
      const t = Date.parse(r.timestamp);
      if (r.event_name === "hook_execution_start") {
        totalFires += 1;
        const hook = parseAttrs(r.attributes).hook_name ?? parseAttrs(r.attributes).hook_event ?? "hook";
        byHook.set(hook, (byHook.get(hook) ?? 0) + 1);
        const q = pending.get(r.session_id) ?? [];
        q.push(t);
        pending.set(r.session_id, q);
      } else {
        const q = pending.get(r.session_id);
        if (q && q.length) {
          const dur = t - q.shift()!;
          if (dur >= 0 && dur <= 60_000) durations.push(dur); // 60s outlier cap
        }
      }
    }
    const daily = db.query(/* sql */ `
      SELECT DATE(timestamp,'localtime') date, COUNT(*) fires FROM otel_events
      WHERE event_name = 'hook_execution_start' AND ${rangePred(range, "timestamp")}
      GROUP BY date ORDER BY date ASC`).all() as any[];
    const sorted = durations.slice().sort((a, b) => a - b);
    return c.json({
      range, totalFires, paired: durations.length,
      avgMs: sorted.length ? Math.round(durations.reduce((a, b) => a + b, 0) / sorted.length) : null,
      p50Ms: pct(sorted, 50),
      hooks: [...byHook.entries()].map(([hook, fires]) => ({ hook, fires })).sort((a, b) => b.fires - a.fires),
      daily,
    });
  });

  // ── Productivity (OTEL delta counters: commits/PRs/lines) ─────────────────
  // Master §16/§17 ProductivityCard. These ARE delta-temporality counters, so
  // SUM(value) is correct (§12.2). lines_of_code splits added/removed by attr.type.
  app.get("/api/activity/productivity", (c) => {
    const range = c.req.query("range") ?? "7d";
    const rows = db.query(/* sql */ `
      SELECT metric_name, value, attributes, DATE(timestamp,'localtime') date
      FROM otel_metrics
      WHERE metric_name IN ('claude_code.commit.count','claude_code.pull_request.count','claude_code.lines_of_code.count')
        AND ${rangePred(range, "timestamp")}`).all() as any[];
    let commits = 0, pullRequests = 0, linesAdded = 0, linesRemoved = 0;
    const byDate = new Map<string, { added: number; removed: number; commits: number; prs: number }>();
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { added: 0, removed: 0, commits: 0, prs: 0 };
      if (r.metric_name === "claude_code.commit.count") { commits += r.value; d.commits += r.value; }
      else if (r.metric_name === "claude_code.pull_request.count") { pullRequests += r.value; d.prs += r.value; }
      else if (parseAttrs(r.attributes).type === "removed") { linesRemoved += r.value; d.removed += r.value; }
      else { linesAdded += r.value; d.added += r.value; }
      byDate.set(r.date, d);
    }
    const daily = [...byDate.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));
    return c.json({
      range, commits, pullRequests, linesAdded, linesRemoved,
      empty: commits === 0 && pullRequests === 0 && linesAdded === 0 && linesRemoved === 0,
      daily,
    });
  });

  // ── Pressure (retry exhaustion + compaction + recent api errors) ──────────
  // Master §16/§17 PressurePanel. Retry threshold from CLAUDE_CODE_MAX_RETRIES
  // (default 10) — surfaced in the response. NaN/≤0 env falls back to 10.
  app.get("/api/system/pressure", (c) => {
    const range = c.req.query("range") ?? "7d";
    const parsed = Number(process.env.CLAUDE_CODE_MAX_RETRIES);
    const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const retryExhaustion = (db.query(/* sql */ `
      SELECT COUNT(*) n FROM otel_events
      WHERE attempt_count >= ? AND ${rangePred(range, "timestamp")}`).get(threshold) as any).n;
    const compaction = (db.query(/* sql */ `
      SELECT COUNT(*) n FROM otel_events
      WHERE event_name LIKE '%compact%' AND ${rangePred(range, "timestamp")}`).get() as any).n;
    const apiErrors = db.query(/* sql */ `
      SELECT timestamp, model, status_code, attempt_count, error_message FROM otel_events
      WHERE (status_code >= 400 OR error_message IS NOT NULL)
        AND ${rangePred(range, "timestamp")}
      ORDER BY timestamp DESC LIMIT 10`).all() as any[];
    return c.json({ range, threshold, retryExhaustion, compaction, apiErrors });
  });

  // ── Patterns (30-day session heatmap + 14-day token series by model) ──────
  // Master §17 Patterns. Heatmap window is FIXED at 30 days (independent of the
  // global range toggle); the client builds the contiguous date axis (browser
  // Date) and maps these sparse per-day rows onto it. Token series is 14-day.
  app.get("/api/activity/patterns", (c) => {
    const agent = agentFilter(c.req.query("agent"));
    const hWhere = ["DATE(started_at,'localtime') >= date('now','localtime','-29 days')", "started_at IS NOT NULL"];
    const hParams: any[] = [];
    if (agent) { hWhere.push("agent = ?"); hParams.push(agent); }
    const rows = db.query(/* sql */ `
      SELECT DATE(started_at,'localtime') date, agent, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok
      FROM sessions WHERE ${hWhere.join(" AND ")}
      GROUP BY date, agent`).all(...hParams) as any[];
    const byDate = new Map<string, { date: string; sessions: number; tokens: number; agents: Record<string, number> }>();
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { date: r.date, sessions: 0, tokens: 0, agents: {} as Record<string, number> };
      d.sessions += r.n;
      d.tokens += r.tok;
      d.agents[r.agent] = (d.agents[r.agent] ?? 0) + r.n;
      byDate.set(r.date, d);
    }
    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const maxSessions = days.reduce((m, d) => Math.max(m, d.sessions), 0);
    // 14-day token series by model (ChartsStrip stacks these client-side).
    const tWhere = ["date >= date('now','localtime','-13 days')"];
    const tParams: any[] = [];
    if (agent) { tWhere.push("agent = ?"); tParams.push(agent); }
    const tokenSeries = db.query(/* sql */ `
      SELECT date, model,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens + reasoning_tokens) tokens
      FROM token_usage WHERE ${tWhere.join(" AND ")}
      GROUP BY date, model HAVING tokens > 0 ORDER BY date ASC`).all(...tParams) as any[];
    return c.json({ window: 30, days, maxSessions, agents: agentIds(), tokenSeries });
  });

  // ── Telemetry firehose (SSE replay of recent OTEL events, then tail) ──────
  // Master §17 OtelPanel. Emits the last ~100 events chronologically, then tails
  // newly-ingested rows by ascending id. Client filters by event_name.
  app.get("/api/firehose", (c) => {
    return streamSSE(c, async (stream) => {
      const recent = db.query(/* sql */ `
        SELECT id, event_name, session_id, model, tool_name, timestamp, received_at
        FROM otel_events ORDER BY id DESC LIMIT 100`).all() as any[];
      let lastId = 0;
      for (const e of recent.reverse()) {
        lastId = Math.max(lastId, e.id);
        await stream.writeSSE({ data: JSON.stringify(e), event: "otel" });
      }
      // Tail new rows. A keepalive every tick keeps the chunked stream flushing
      // so it never crosses Bun.serve's 10s idleTimeout (which would close the
      // socket mid-stream → ERR_INCOMPLETE_CHUNKED_ENCODING + an EventSource
      // reconnect storm that re-replays the backlog).
      for (let i = 0; i < 600 && !stream.aborted; i++) {
        await stream.sleep(1500);
        try {
          const fresh = db.query(/* sql */ `
            SELECT id, event_name, session_id, model, tool_name, timestamp, received_at
            FROM otel_events WHERE id > ? ORDER BY id ASC LIMIT 200`).all(lastId) as any[];
          if (fresh.length) {
            for (const e of fresh) {
              lastId = Math.max(lastId, e.id);
              await stream.writeSSE({ data: JSON.stringify(e), event: "otel" });
            }
          } else {
            await stream.writeSSE({ data: "ping", event: "keepalive" });
          }
        } catch {
          break; // client gone or write failed — end cleanly
        }
      }
    });
  });

  // ── Top skills (invocation count; per-skill attribution needs OTEL) ───────
  // Master §17 TopSkills. The `Skill` tool call is countable from JSONL, but the
  // skill *name* is in tool input (not persisted) — per-skill rows require the
  // skill_name OTEL attribute. We surface the honest invocation count + any
  // attributed rows rather than fabricating a per-skill breakdown.
  app.get("/api/activity/top-skills", (c) => {
    const range = c.req.query("range") ?? "7d";
    const invocations = (db.query(/* sql */ `
      SELECT COUNT(*) n FROM tool_calls WHERE tool_name = 'Skill' AND ${rangePred(range, "ts")}`).get() as any).n;
    const attributed = db.query(/* sql */ `
      SELECT skill_name skill, COUNT(*) uses FROM otel_events
      WHERE skill_name IS NOT NULL AND ${rangePred(range, "timestamp")}
      GROUP BY skill_name ORDER BY uses DESC LIMIT 20`).all() as any[];
    return c.json({ range, invocations, attributed });
  });

  // ── Unified failures (errored / rate-limited / truncated sessions) ────────
  // Master §17 UnifiedFailures. Crashed sessions + their error signal. Same
  // priority semantics as OUTCOME_CASE; no error *message* in JSONL (Claude
  // interactive logs carry none) so we surface count + stop_reason + outcome.
  app.get("/api/activity/failures", (c) => {
    const range = c.req.query("range") ?? "30d";
    const agent = agentFilter(c.req.query("agent"));
    const where = [
      rangePred(range),
      "(COALESCE(error_count,0) > 0 OR COALESCE(rate_limit_hit,0) = 1 OR stop_reason IN ('max_tokens','length'))",
    ];
    const params: any[] = [];
    pushAgent(where, params, agent);
    const rows = db.query(/* sql */ `
      SELECT session_id, agent, model, title, cwd, started_at, error_count, rate_limit_hit,
             stop_reason, ${OUTCOME_CASE} AS outcome
      FROM sessions WHERE ${where.join(" AND ")}
      ORDER BY started_at DESC LIMIT 50`).all(...params) as any[];
    const total = (db.query(/* sql */ `
      SELECT COUNT(*) n FROM sessions WHERE ${where.join(" AND ")}`).get(...params) as any).n;
    return c.json({ range, total, failures: rows });
  });

  // ── Skills registry (filesystem scan of SKILL.md frontmatter) ─────────────
  // Master §16/§17. Lazy-syncs on first read (table empty); POST forces a
  // re-scan; PATCH sets the user-owned autonomy level (preserved across syncs).
  app.get("/api/skills", (c) => {
    if ((db.query("SELECT COUNT(*) n FROM skills").get() as any).n === 0) {
      try { syncSkills(db); } catch { /* report empty rather than 500 */ }
    }
    const environment = c.req.query("environment");
    const userInvocable = c.req.query("user_invocable");
    const where: string[] = [];
    const params: any[] = [];
    if (environment) { where.push("environment = ?"); params.push(environment); }
    if (userInvocable === "1" || userInvocable === "0") { where.push("user_invocable = ?"); params.push(Number(userInvocable)); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.query(/* sql */ `
      SELECT name, environment, description, path, autonomy_level, user_invocable, script_count, last_modified
      FROM skills ${whereSql} ORDER BY environment ASC, name ASC`).all(...params);
    const facets = db.query(/* sql */ `
      SELECT environment, COUNT(*) n FROM skills GROUP BY environment`).all() as any[];
    return c.json({ total: rows.length, skills: rows, facets });
  });

  app.post("/api/skills/sync", (c) => {
    const count = syncSkills(db);
    return c.json({ ok: true, synced: count });
  });

  app.patch("/api/skills/:name/autonomy", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { autonomy_level?: string };
    const level = body.autonomy_level;
    if (!level || !["auto", "review", "manual"].includes(level)) {
      return c.json({ error: "autonomy_level must be auto|review|manual" }, 400);
    }
    const res = db.run("UPDATE skills SET autonomy_level = ? WHERE name = ?", [level, name]);
    if (res.changes === 0) return c.json({ error: "skill not found" }, 404);
    return c.json({ ok: true, name, autonomy_level: level });
  });

  // ── Context health (read-only scan of settings.json + CLAUDE.md, no LLM) ──
  // Master §17 ContextHealthCard. Pure counts — never echoes file contents.
  app.get("/api/context/health", (c) => {
    const home = homedir();
    const settingsPath = join(home, ".claude", "settings.json");
    const claudeMdPath = join(home, ".claude", "CLAUDE.md");

    let settings: any = {};
    let settingsBytes = 0;
    try {
      const raw = readFileSync(settingsPath, "utf8");
      settingsBytes = Buffer.byteLength(raw);
      settings = JSON.parse(raw);
    } catch { /* missing/unparseable → zeros */ }

    // Hooks: sum hooks across every event's matcher groups.
    let hooks = 0;
    for (const groups of Object.values(settings.hooks ?? {})) {
      if (Array.isArray(groups)) for (const g of groups) hooks += Array.isArray((g as any)?.hooks) ? (g as any).hooks.length : 0;
    }
    const perm = settings.permissions ?? {};
    const permissions = {
      allow: Array.isArray(perm.allow) ? perm.allow.length : 0,
      ask: Array.isArray(perm.ask) ? perm.ask.length : 0,
      deny: Array.isArray(perm.deny) ? perm.deny.length : 0,
    };
    const envKeys = Object.keys(settings.env ?? {}).length;

    // MCP servers: top-level mcpServers in settings.json, else ~/.claude.json
    // (count only — never read out the contents).
    let mcpServers = Object.keys(settings.mcpServers ?? {}).length;
    if (mcpServers === 0) {
      try {
        const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
        mcpServers = Object.keys(cfg.mcpServers ?? {}).length;
      } catch { /* none */ }
    }

    // CLAUDE.md: size, lines, and a "directives" proxy (headings + list items).
    let claudeMdBytes = 0, claudeMdLines = 0, directives = 0;
    try {
      const md = readFileSync(claudeMdPath, "utf8");
      claudeMdBytes = Buffer.byteLength(md);
      const lines = md.split("\n");
      claudeMdLines = lines.length;
      directives = lines.filter((l) => /^\s*(#{1,6}\s|[-*]\s|\d+\.\s)/.test(l)).length;
    } catch { /* missing → zeros */ }

    return c.json({
      settings: { exists: settingsBytes > 0, bytes: settingsBytes, hooks, permissions, envKeys, mcpServers },
      claudeMd: { exists: claudeMdBytes > 0, bytes: claudeMdBytes, lines: claudeMdLines, directives },
    });
  });

  // ── MCP schema footprint (per-server tool count; size needs live conn) ────
  // Master §16/§17. We can enumerate servers + their observed tools from
  // telemetry/JSONL, but the per-tool JSON *schema* (the real context cost) is
  // only available from a live MCP handshake — out of this read-only build. We
  // surface the honest tool count and flag schema bytes as unmeasured.
  app.get("/api/mcp/measure", (c) => {
    const range = c.req.query("range") ?? "30d";
    const calls = mcpCalls(db, range);
    const byServer = new Map<string, Set<string>>();
    for (const r of calls) {
      const s = byServer.get(r.server) ?? new Set<string>();
      s.add(r.tool);
      byServer.set(r.server, s);
    }
    const servers = [...byServer.entries()]
      .map(([server, tools]) => ({ server, tools: tools.size, schemaTokens: null as number | null, measured: false }))
      .sort((a, b) => b.tools - a.tools);
    return c.json({
      range, servers,
      note: "Per-tool schema token cost requires a live MCP handshake; this read-only build reports observed tool counts only.",
    });
  });

  // ── Manual sync trigger ───────────────────────────────────────────────────
  app.post("/api/sync", (c) => c.json({ ok: true, note: "sync runs every 120s in the worker" }));
}

/** Parse the flattened OTEL attributes JSON blob; never throws. */
function parseAttrs(s: string | null): Record<string, any> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, any>;
  } catch {
    return {};
  }
}

// ── MCP call extraction with OTEL-first / JSONL-fallback ────────────────────
interface McpCall { server: string; tool: string; durationMs: number | null; error: boolean; otel: boolean }

function mcpCalls(db: Database, range: string): McpCall[] {
  // OTEL-precise: events with mcp_server_name (post OTEL_LOG_TOOL_DETAILS=1).
  const otel = db.query(/* sql */ `
    SELECT mcp_server_name server, mcp_tool_name tool, tool_duration_ms durationMs,
           CASE WHEN tool_success = 0 OR tool_error IS NOT NULL THEN 1 ELSE 0 END error
    FROM otel_events
    WHERE mcp_server_name IS NOT NULL AND ${rangePred(range, "timestamp")}`).all() as any[];
  if (otel.length) {
    return otel.map((r) => ({
      server: r.server, tool: r.tool ?? "(tool)", durationMs: r.durationMs, error: !!r.error, otel: true,
    }));
  }
  // JSONL fallback: parse mcp__<server>__<tool> from tool_calls names.
  const rows = db.query(/* sql */ `
    SELECT tool_name, duration_ms durationMs, error FROM tool_calls
    WHERE tool_name LIKE 'mcp__%' AND ${rangePred(range, "ts")}`).all() as any[];
  return rows.map((r) => {
    const parts = String(r.tool_name).split("__"); // mcp__server__tool
    return {
      server: parts[1] ?? "unknown",
      tool: parts.slice(2).join("__") || "(tool)",
      durationMs: r.durationMs,
      error: r.error != null,
      otel: false,
    };
  });
}

/** OTEL native cost (claude_code.cost.usage, USD) summed over the range, or null. */
function otelNativeCost(db: Database, agent: string, range: string): number | null {
  const row = db.query(/* sql */ `
    SELECT SUM(value) v FROM otel_metrics
    WHERE metric_name = 'claude_code.cost.usage' AND agent = ?
      AND ${rangePred(range, "timestamp")}`).get(agent) as any;
  return row?.v ?? null;
}

/** OTEL native cost per local day over the range (claude_code, the only emitter). */
function otelNativeByDate(db: Database, range: string): Map<string, number> {
  const rows = db.query(/* sql */ `
    SELECT DATE(timestamp,'localtime') date, SUM(value) v FROM otel_metrics
    WHERE metric_name = 'claude_code.cost.usage' AND ${rangePred(range, "timestamp")}
    GROUP BY 1`).all() as any[];
  return new Map(rows.map((r) => [r.date, r.v as number]));
}

/** Resolve a session id to its JSONL path under the projects glob. */
function findSessionFile(sid: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  try {
    const g = new Glob(`*/${sid}.jsonl`);
    for (const p of g.scanSync({ cwd: base, absolute: true, onlyFiles: true })) return p;
  } catch {
    /* fall through */
  }
  return null;
}
