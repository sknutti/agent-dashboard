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
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { getDb } from "./db.ts";

const AGENT_IDS = ["claude_code", "codex", "pi", "antigravity"] as const;

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

/** `DATE(col,'localtime') >= <rangeStart>` predicate fragment. */
function rangePred(range: string, col = "started_at"): string {
  return `DATE(${col},'localtime') >= ${rangeStartSql(range)}`;
}

/** Validate an agent id from the query; returns null for "all"/invalid. */
function agentFilter(agent: string | undefined): string | null {
  if (!agent || agent === "all") return null;
  return (AGENT_IDS as readonly string[]).includes(agent) ? agent : null;
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
    const detected: Record<string, boolean> = {
      claude_code: existsSync(join(homedir(), ".claude", "projects")),
      codex: existsSync(join(homedir(), ".codex", "sessions")),
      pi: existsSync(join(homedir(), ".pi", "agent", "sessions")),
      antigravity: existsSync(join(homedir(), ".gemini", "antigravity-cli")),
    };
    const out = AGENT_IDS.map((id) => {
      const tok = db.query(/* sql */ `
        SELECT COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
               COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_create_tokens),0) cacheCreate,
               COALESCE(SUM(reasoning_tokens),0) reasoning, COALESCE(SUM(total_tokens),0) total,
               COUNT(*) sessions, COALESCE(SUM(error_count),0) errors,
               SUM(cost_usd) costUsd, SUM(cost_estimated_usd) costEstimatedUsd
        FROM sessions WHERE agent = ? AND ${rangePred(range)}`).get(id) as any;
      const tools = db.query(/* sql */ `
        SELECT COUNT(*) n FROM tool_calls WHERE agent = ? AND ${rangePred(range, "ts")}`).get(id) as any;
      const billable = tok.input + tok.cacheRead + tok.cacheCreate;
      const otel = (db.query(
        `SELECT COUNT(*) n FROM otel_events WHERE agent = ? AND received_at >= datetime('now','-7 days')`,
      ).get(id) as any).n > 0;
      // Native cost — OTEL-first / JSONL-fallback (master §12.3). Interactive JSONL
      // carries no native cost, so the `claude_code.cost.usage` metric supplies it
      // (delta temporality → SUM is correct). JSONL print-mode cost wins if present.
      const otelNative = otelNativeCost(db, id, range);
      const nativeUsd = tok.costUsd != null ? tok.costUsd : otelNative;
      return {
        id,
        detected: detected[id],
        otel,
        cost: id === "claude_code" || id === "pi" ? "native" : "none",
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
    return c.json({ range, agents: out });
  });

  // ── Sessions list (drill-downs) ───────────────────────────────────────────
  app.get("/api/sessions", (c) => {
    const range = c.req.query("range") ?? "30d";
    const agent = agentFilter(c.req.query("agent"));
    const outcome = c.req.query("outcome");
    const model = c.req.query("model");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const where: string[] = [rangePred(range)];
    const params: any[] = [];
    if (agent) { where.push("agent = ?"); params.push(agent); }
    if (model) { where.push("model = ?"); params.push(model); }
    if (outcome) { where.push(`(${OUTCOME_CASE}) = ?`); params.push(outcome); }
    const whereSql = where.join(" AND ");

    const total = (db.query(`SELECT COUNT(*) n FROM sessions WHERE ${whereSql}`).get(...params) as any).n;
    const rows = db.query(/* sql */ `
      SELECT session_id, agent, model, cwd, git_branch, title, started_at, ended_at,
             total_tokens, effective_tokens, error_count, cost_usd, cost_estimated_usd,
             duration_ms, fidelity, ${OUTCOME_CASE} AS outcome
      FROM sessions WHERE ${whereSql}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return c.json({ total, limit, offset, sessions: rows });
  });

  // ── Session detail (timeline + token breakdown) ───────────────────────────
  app.get("/api/sessions/:id/details", (c) => {
    const id = c.req.param("id");
    const session = db.query(/* sql */ `
      SELECT session_id, agent, model, cwd, git_branch, title, started_at, ended_at,
             input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
             reasoning_tokens, total_tokens, effective_tokens, error_count, rate_limit_hit,
             stop_reason, cost_usd, cost_estimated_usd, duration_ms, fidelity,
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
         OR ended_at >= datetime('now','-5 minutes')
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
      // Emit the last ~300 lines, then tail appended lines until disconnect.
      let offset = 0;
      const emitFrom = async (tailOnly: boolean) => {
        const text = await Bun.file(file).text();
        const all = text.split("\n").filter((l) => l.length > 0);
        const start = tailOnly ? 0 : Math.max(0, all.length - 300);
        for (let i = offset > 0 ? offset : start; i < all.length; i++) {
          await stream.writeSSE({ data: all[i]!, event: "line" });
        }
        offset = all.length;
      };
      await emitFrom(false);
      // Poll for growth (mtime-cheap) up to 5 minutes.
      for (let i = 0; i < 200 && !stream.aborted; i++) {
        await stream.sleep(1500);
        try {
          if (statSync(file).size > 0) await emitFrom(true);
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
    if (agent) { where.push("agent = ?"); params.push(agent); }
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
    if (agent) { where.push("agent = ?"); params.push(agent); }
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
    if (agent) { where.push("agent = ?"); params.push(agent); }
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
    if (agent) { where.push("agent = ?"); params.push(agent); }
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
    return c.json({ range, servers, source: calls.length && calls[0]!.otel ? "otel" : "jsonl" });
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
    if (agent) { where.push("agent = ?"); params.push(agent); }
    const rows = db.query(/* sql */ `
      SELECT date, agent, tokens, cost_usd, cost_estimated_usd, fidelity, driver, evidence
      FROM burn_daily WHERE ${where.join(" AND ")}
      ORDER BY date ASC`).all(...params) as any[];

    // Per-date totals (cross-agent; one agent today, built to take more).
    const byDate = new Map<string, { tokens: number; estUsd: number; nativeUsd: number | null }>();
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { tokens: 0, estUsd: 0, nativeUsd: null };
      d.tokens += r.tokens ?? 0;
      d.estUsd += r.cost_estimated_usd ?? 0;
      if (r.cost_usd != null) d.nativeUsd = (d.nativeUsd ?? 0) + r.cost_usd;
      byDate.set(r.date, d);
    }
    // OTEL-first native cost overlay (master §12.3): interactive burn_daily has no
    // native cost; the `claude_code.cost.usage` metric supplies it where telemetry
    // was on. This metric is Claude-specific, so it must NOT bleed into a non-Claude
    // filter (e.g. Codex/Antigravity have no native cost). Apply it only to the
    // all-agents total or an explicit Claude filter. (Latent since Phase 1, when
    // Claude was the only agent and the filter was a no-op.)
    if (agent === null || agent === "claude_code") {
      const otelNative = otelNativeByDate(db, range);
      for (const [date, v] of otelNative) {
        const d = byDate.get(date) ?? { tokens: 0, estUsd: 0, nativeUsd: null };
        if (d.nativeUsd == null) d.nativeUsd = v;
        byDate.set(date, d);
      }
    }
    const daily = [...byDate.entries()].map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date));
    const totalTokens = daily.reduce((a, d) => a + d.tokens, 0);
    const totalEst = daily.reduce((a, d) => a + d.estUsd, 0);

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
    });
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

  // ── Manual sync trigger ───────────────────────────────────────────────────
  app.post("/api/sync", (c) => c.json({ ok: true, note: "sync runs every 120s in the worker" }));
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
