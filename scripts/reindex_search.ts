// One-shot content-search backfill. The reparse loop only (re)indexes sessions
// whose log CHANGES, so on an existing install the session_search FTS5 table stays
// empty until each session is touched. Run this once after enabling content search
// to make the whole history searchable immediately:
//
//   bun run reindex
//
// Idempotent — safe to re-run. New/changed sessions stay covered by the live
// reparse hook in sync_agents.ts, so this is a backfill, not a recurring job.

import { getDb } from "./db.ts";
import { backfillSearchIndex } from "./session_search.ts";

const db = getDb();
const startedMs = performance.now();
const { indexed, skipped } = await backfillSearchIndex(db);
const ms = Math.round(performance.now() - startedMs);
console.log(`[reindex] content index backfilled: ${indexed} indexed, ${skipped} skipped in ${ms}ms`);
db.close();
