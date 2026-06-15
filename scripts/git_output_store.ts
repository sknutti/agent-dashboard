// Persisted git-output rollup store. Writes computeDayOutcome's VERBATIM deduped
// result into git_output_daily so the whole Burn grid can read output cheaply
// without per-click git fan-out. We persist exactly what the deduper returned, so
// the Q2 per-hash dedupe is provably preserved — see the git_output_daily comment in
// db.ts (and the regression guard in git_output_store.test.ts) for why this must
// never become a per-session scalar SUM.

import type { Database } from "bun:sqlite";
import { computeDayOutcome, type DayOutcome, type GitRunner } from "./session_outcomes.ts";

/** Read one day's persisted deduped output, mapped back to the DayOutcome shape
 *  (files_changed→filesChanged, deduped int→bool). Null when not yet computed. */
export function readDayOutput(db: Database, date: string): DayOutcome | null {
  const row = db
    .query<{ sessions: number; commits: number; insertions: number; deletions: number; files_changed: number; fidelity: string; deduped: number }, [string]>(
      `SELECT sessions, commits, insertions, deletions, files_changed, fidelity, deduped
       FROM git_output_daily WHERE date = ?`,
    )
    .get(date);
  if (!row) return null;
  return {
    date,
    sessions: row.sessions,
    commits: row.commits,
    insertions: row.insertions,
    deletions: row.deletions,
    filesChanged: row.files_changed,
    fidelity: "estimated",
    deduped: true,
  };
}

/** Persisted-first read: return the cached daily output if present, else compute it
 *  live (a day not yet rolled up by the worker). The on-demand day endpoint uses this
 *  so a cache miss still resolves without waiting for the next tick. */
export async function getDayOutcome(db: Database, date: string, runGit: GitRunner): Promise<DayOutcome> {
  return readDayOutput(db, date) ?? (await computeDayOutcome(db, date, runGit));
}

/** Find up to `cap` most-recent local days that have ended git-eligible sessions but
 *  no git_output_daily row yet — so a long history backfills over several ticks
 *  rather than one git storm. */
function missingRecentDays(db: Database, cap: number): string[] {
  if (cap <= 0) return [];
  return db
    .query<{ d: string }, [number]>(/* sql */ `
      SELECT DISTINCT DATE(started_at,'localtime') d FROM sessions
      WHERE ended_at IS NOT NULL AND cwd IS NOT NULL AND started_at IS NOT NULL
        AND DATE(started_at,'localtime') NOT IN (SELECT date FROM git_output_daily)
      ORDER BY d DESC LIMIT ?`)
    .all(cap)
    .map((r) => r.d);
}

/** The bounded worker driver: recompute the deduped output for each touched date,
 *  plus a small capped backfill of missing recent days. Each date is isolated in its
 *  own try/catch so one bad repo/day can't stall the tick; git itself is bounded by
 *  runGitLog's 5s SIGKILL watchdog. Returns how many days were successfully written
 *  (for the worker heartbeat). The caller gates this on `synced > 0` so a quiet tick
 *  spawns zero git. */
export async function refreshGitOutput(
  db: Database,
  touched: Iterable<string>,
  runGit: GitRunner,
  opts: { backfillCap?: number } = {},
): Promise<{ days: number }> {
  const dates = new Set(touched);
  for (const d of missingRecentDays(db, opts.backfillCap ?? 0)) dates.add(d);

  let days = 0;
  for (const date of dates) {
    try {
      await upsertDayOutcome(db, date, runGit);
      days += 1;
    } catch (err) {
      console.error(`[sync] git output rollup for ${date} failed:`, err);
    }
  }
  return { days };
}

/** Compute one day's deduped git output and upsert it (mirrors upsertBurnDaily's
 *  INSERT … ON CONFLICT shape). Returns the computed outcome. Injected runGit so it
 *  is unit-tested with no subprocess; stamps computed_at for freshness/observability. */
export async function upsertDayOutcome(
  db: Database,
  date: string,
  runGit: GitRunner,
): Promise<DayOutcome> {
  const out = await computeDayOutcome(db, date, runGit);
  db.query(/* sql */ `
    INSERT INTO git_output_daily
      (date, sessions, commits, insertions, deletions, files_changed, fidelity, deduped, computed_at)
    VALUES ($date, $sessions, $commits, $insertions, $deletions, $files, $fidelity, $deduped, $computed_at)
    ON CONFLICT(date) DO UPDATE SET
      sessions=excluded.sessions, commits=excluded.commits, insertions=excluded.insertions,
      deletions=excluded.deletions, files_changed=excluded.files_changed,
      fidelity=excluded.fidelity, deduped=excluded.deduped, computed_at=excluded.computed_at
  `).run({
    $date: out.date,
    $sessions: out.sessions,
    $commits: out.commits,
    $insertions: out.insertions,
    $deletions: out.deletions,
    $files: out.filesChanged,
    $fidelity: out.fidelity,
    $deduped: out.deduped ? 1 : 0,
    $computed_at: new Date().toISOString(),
  });
  return out;
}
