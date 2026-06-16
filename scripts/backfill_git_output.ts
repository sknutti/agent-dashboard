// One-time bounded recompute of persisted git_output_daily rows after the git-outcome
// correctness fix (merge exclusion + timestamp normalization). The recurring worker's
// missingRecentDays only fills dates with NO row yet, so already-persisted rows keep
// their pre-fix figures until independently touched — this brings them up to current
// logic. Run once after deploying the fix:
//
//   bun scripts/backfill_git_output.ts
//
// Idempotent and bounded (CC_GIT_OUTPUT_BACKFILL_CAP, default 400 most-recent rows); the
// per-day git spawn is capped by runGitLog's 5s watchdog. Q2 = bounded backfill.

import { openDb } from "./db.ts";
import { runGitLog } from "./session_outcomes.ts";
import { backfillExistingDayOutputs } from "./git_output_store.ts";

if (import.meta.main) {
  const db = openDb();
  const cap = Number(process.env.CC_GIT_OUTPUT_BACKFILL_CAP ?? 400);
  const { days } = await backfillExistingDayOutputs(db, runGitLog, {
    cap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 400,
  });
  console.log(`git_output_daily: recomputed ${days} day(s) to current logic.`);
  db.close();
}
