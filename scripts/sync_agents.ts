// Orchestrator shell — runs in a WORKER THREAD (ADR-0001).
//
// Phase 0 proves the ingest plumbing end to end without any agent logic:
//   • Opens its OWN bun:sqlite WAL connection (so writes here don't block the
//     main thread's reads — the load-bearing WAL claim).
//   • Every CC_SYNC_INTERVAL_MS (default 120s), and once on boot, fans out over
//     the adapter registry (EMPTY in Phase 0) with per-adapter try/catch, then
//     writes one `activities` heartbeat row. That row is the proof the worker +
//     WAL write path works (Phase 0 stop condition #5) and backs the server's
//     "last sync tick age" health figure.
//
// Phases 1–4 only push AgentAdapter instances into `registry` and implement the
// per-event DB writes inside `syncAdapter`; the loop, isolation, and heartbeat
// stay exactly as they are.

import { parentPort } from "node:worker_threads";
import type { AdapterRegistry, AgentAdapter } from "./adapters/base.ts";
import { getDb } from "./db.ts";

const SYNC_INTERVAL_MS = Number(process.env.CC_SYNC_INTERVAL_MS ?? 120_000);

// Open this thread's own connection and ensure the schema. getDb() is a
// thread-local singleton, so in worker mode this is a distinct connection from
// the server's; CREATE TABLE IF NOT EXISTS is idempotent (WAL + busy_timeout
// serialize the rare concurrent create). Also lets `cc sync --once` run before
// the server has ever booted.
const db = getDb();

// Phase 0: empty registry => the fan-out is a no-op. This is intentional.
const registry: AdapterRegistry = [];

const insertHeartbeat = db.prepare(
  `INSERT INTO activities (event_type, detail, metadata, created_at)
   VALUES ('sync_loop_heartbeat', ?, ?, ?)`,
);

let tickCount = 0;

/** Parse one adapter's sessions. No-op in Phase 0 (no adapter implements this). */
async function syncAdapter(_adapter: AgentAdapter): Promise<void> {
  // Phase 1+: for each session source newer than synced_at (or ended_at IS NULL),
  // iterate parseSession() and write sessions/token_usage/tool_calls/burn_daily.
}

async function tick(): Promise<void> {
  tickCount += 1;
  let synced = 0;
  for (const adapter of registry) {
    if (!adapter.enabled) continue;
    try {
      await syncAdapter(adapter);
      synced += 1;
    } catch (err) {
      // Per-adapter isolation: one agent's malformed log never blocks the others.
      console.error(`[sync] adapter ${adapter.agentId} failed:`, err);
    }
  }

  const now = new Date().toISOString();
  insertHeartbeat.run(
    `tick ${tickCount}: ${synced}/${registry.length} adapters synced`,
    JSON.stringify({ tick: tickCount, adapters: registry.length, synced }),
    now,
  );
  parentPort?.postMessage({ type: "tick", tick: tickCount, at: now });
}

// Graceful stop on request from the main thread.
parentPort?.on("message", (msg: { type?: string }) => {
  if (msg?.type === "stop") {
    db.close();
    process.exit(0);
  }
});

// `cc sync` runs this file directly with --once: one tick, then exit.
if (process.argv.includes("--once")) {
  await tick();
  db.close();
  process.exit(0);
}

// Worker mode: boot tick immediately (don't wait a full interval), then loop.
void tick();
setInterval(() => void tick(), SYNC_INTERVAL_MS);
