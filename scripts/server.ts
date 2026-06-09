// Command Centre server — the single always-on process (ADR-0001).
//
// One Bun process, bound to 127.0.0.1 ONLY (privacy: zero outbound, zero LAN
// exposure). Hono routes /api/* + the OTLP /v1/* ingest endpoints; the Svelte
// SPA in ui/dist is served as static with client-route fallback. Heavy JSONL
// ingest runs in a worker thread (sync_agents.ts) that opens its own WAL
// connection; this main thread only reads + serves.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { getDb } from "./db.ts";
import { ingestLogs, ingestMetrics, ingestTraces, type IngestResult } from "./otel.ts";
import { registerApiRoutes } from "./routes.ts";
import { PORT, UI_DIST, tzName } from "./paths.ts";

const STARTED_AT = Date.now();

// Initialize the schema on the main thread BEFORE the worker opens its own
// connection, so we never race two connections on CREATE TABLE.
const db = getDb();

// ── Ingest worker ─────────────────────────────────────────────────────────
const worker = new Worker(fileURLToPath(new URL("./sync_agents.ts", import.meta.url)));
let lastWorkerTickAt: string | null = null;
worker.on("message", (msg: { type?: string; at?: string }) => {
  if (msg?.type === "tick" && msg.at) lastWorkerTickAt = msg.at;
});
worker.on("error", (err) => console.error("[worker] error:", err));
worker.unref(); // don't keep the process alive on the worker alone

// ── App ─────────────────────────────────────────────────────────────────────
const app = new Hono();

/** Read MAX(col) as an epoch-age in seconds, or null if no rows. */
function ageSeconds(sql: string): number | null {
  const row = db.query(sql).get() as { latest: string | null } | null;
  if (!row?.latest) return null;
  const t = Date.parse(row.latest);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

app.get("/api/health", (c) => c.json({ ok: true, status: "ok" }));

app.get("/api/system/health", (c) => {
  const otelAge = ageSeconds(
    `SELECT MAX(received_at) AS latest FROM (
       SELECT received_at FROM otel_events
       UNION ALL SELECT received_at FROM otel_metrics
       UNION ALL SELECT received_at FROM otel_spans)`,
  );
  const syncAge = ageSeconds(
    `SELECT MAX(created_at) AS latest FROM activities WHERE event_type = 'sync_loop_heartbeat'`,
  );
  const mem = process.memoryUsage();
  return c.json({
    ok: true,
    uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
    last_otel_event_age_s: otelAge,
    last_sync_tick_age_s: syncAge,
    last_worker_tick_at: lastWorkerTickAt,
    rss_bytes: mem.rss,
    tz: tzName(),
  });
});

// ── OTLP/HTTP JSON ingest — ALWAYS 200, even on parse failure (master §15) ──
function otelHandler(ingest: (db: any, body: any) => IngestResult) {
  return async (c: any) => {
    let result: IngestResult = { received: 0, dropped: 0 };
    try {
      const body = await c.req.json();
      result = ingest(db, body);
    } catch (err) {
      // Malformed/empty body — log and still return 200 so the emitter doesn't
      // spin retrying (Claude Code drops telemetry on non-200).
      console.error("[otel] batch error:", err);
    }
    return c.json({ partialSuccess: {}, ...result }, 200);
  };
}
app.post("/v1/logs", otelHandler(ingestLogs));
app.post("/v1/metrics", otelHandler(ingestMetrics));
app.post("/v1/traces", otelHandler(ingestTraces));

// ── Core observability API (master §16) ─────────────────────────────────────
registerApiRoutes(app);

// ── Static SPA (registered last; falls through to index.html for client routes) ──
const INDEX_HTML = join(UI_DIST, "index.html");

app.get("/*", async (c) => {
  const reqPath = c.req.path;
  // Guard against path traversal: resolve under UI_DIST only.
  const rel = normalize(reqPath).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const candidate = rel === "" ? INDEX_HTML : join(UI_DIST, rel);

  if (candidate.startsWith(UI_DIST) && rel !== "" && existsSync(candidate)) {
    return new Response(Bun.file(candidate));
  }
  // SPA fallback: serve index.html for "/" and unknown client routes.
  if (existsSync(INDEX_HTML)) {
    return new Response(Bun.file(INDEX_HTML), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  // UI not built yet — keep the server fully functional for API/OTEL work.
  return c.html(
    `<!doctype html><meta charset=utf-8><title>Command Centre</title>
     <body style="font:14px ui-monospace,monospace;background:#0a0a0f;color:#e8e8f0;padding:3rem">
     <h1 style="font-weight:600">Command Centre</h1>
     <p style="color:#8888a0">UI not built yet. Run <code style="color:#4d7cff">bun run build:ui</code> then reload.</p>
     <p style="color:#5a5a70">API is live: <a style="color:#06b6d4" href="/api/system/health">/api/system/health</a></p>
     </body>`,
    200,
  );
});

// ── Listen (127.0.0.1 only) + graceful shutdown ─────────────────────────────
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
});

console.log(`Command Centre listening on http://127.0.0.1:${server.port}`);

function shutdown() {
  try {
    worker.postMessage({ type: "stop" });
  } catch {}
  worker.terminate();
  server.stop(true);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
