// Persisted git-output rollup. The store writes computeDayOutcome's VERBATIM deduped
// output into git_output_daily (date-only key), so the dedupe (Q2=(b)) is provably
// preserved — the regression guard below fails loudly if anyone ever switches the
// daily figure to a per-session scalar SUM (which would re-introduce the over-count).

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./db.ts";
import { upsertDayOutcome, refreshGitOutput, getDayOutcome, backfillExistingDayOutputs } from "./git_output_store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

describe("git_output_daily schema (Phase 0)", () => {
  test("initSchema creates the table keyed by date, idempotently", () => {
    const db = freshDb();
    initSchema(db); // second run must be a no-op, not an error
    const cols = (db.query("PRAGMA table_info(git_output_daily)").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toEqual([
      "date", "sessions", "commits", "insertions", "deletions",
      "files_changed", "fidelity", "deduped", "computed_at",
    ]);
    // date is the primary key (one row per local day, agent-agnostic by design)
    const pk = (db.query("PRAGMA table_info(git_output_daily)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(["date"]);
    db.close();
  });
});

describe("upsertDayOutcome (Phase 1 — persist deduped output)", () => {
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  const dayKey = (db: Database, iso: string): string =>
    (db.query<{ d: string }, [string]>("SELECT DATE(?, 'localtime') d").get(iso)!).d;

  const H1 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const H2 = "b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1";
  const H3 = "c1c2c3c4c5c6c7c8c9c0c1c2c3c4c5c6c7c8c9c0";
  const FIX_A = [H1, "", "10\t2\tsrc/foo.ts", "5\t0\tsrc/bar.ts", H2, "", "3\t3\tsrc/foo.ts", "-\t-\tassets/logo.png"].join("\n");
  const FIX_B = [H2, "", "3\t3\tsrc/foo.ts", "-\t-\tassets/logo.png", H3, "", "7\t1\tsrc/baz.ts"].join("\n");
  const dayRunner = async (args: string[]) => {
    const since = args[args.indexOf("--since") + 1];
    if (since === "2026-06-10T12:00:00Z") return { exitCode: 0, stdout: FIX_A, stderr: "" };
    if (since === "2026-06-10T14:00:00Z") return { exitCode: 0, stdout: FIX_B, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  // The #1-decision regression guard: persisted commits MUST equal COUNT(DISTINCT hash),
  // never the per-session raw sum. H2 is shared by both sessions → distinct = 3, sum = 4.
  test("persists computeDayOutcome's DEDUPED output, not a per-session sum", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", git_branch: null, started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    seed(db, { session_id: "s2", cwd: "/repo", git_branch: null, started_at: "2026-06-10T14:00:00Z", ended_at: "2026-06-10T15:00:00Z" });

    await upsertDayOutcome(db, date, dayRunner);

    const row = db.query<{ commits: number; insertions: number; deletions: number; files_changed: number; sessions: number; deduped: number; computed_at: string | null }, [string]>(
      "SELECT commits, insertions, deletions, files_changed, sessions, deduped, computed_at FROM git_output_daily WHERE date = ?",
    ).get(date)!;
    expect(row.commits).toBe(3); // DISTINCT hashes — NOT 4 (the raw sum)
    expect(row.insertions).toBe(25); // H2's 3 counted once — NOT 28
    expect(row.deletions).toBe(6);
    expect(row.files_changed).toBe(4);
    expect(row.sessions).toBe(2);
    expect(row.deduped).toBe(1);
    expect(row.computed_at).toBeTruthy();
    db.close();
  });

  test("is idempotent — re-upserting keeps one row with refreshed values", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", git_branch: null, started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    await upsertDayOutcome(db, date, dayRunner);
    await upsertDayOutcome(db, date, dayRunner);
    const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM git_output_daily WHERE date = ?").get(date)!.n;
    expect(n).toBe(1);
    db.close();
  });
});

describe("refreshGitOutput (Phase 2 — bounded worker driver)", () => {
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  const dayKey = (db: Database, iso: string): string =>
    (db.query<{ d: string }, [string]>("SELECT DATE(?, 'localtime') d").get(iso)!).d;
  const okRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

  test("writes a git_output_daily row for each touched date", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const d1 = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    const { days } = await refreshGitOutput(db, [d1], okRunner, {});
    expect(days).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM git_output_daily").get()).toEqual({ n: 1 });
    db.close();
  });

  test("bounded backfill fills the most-recent missing days, up to the cap", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    // three distinct ended-session days, none yet in git_output_daily
    seed(db, { session_id: "a", cwd: "/repo", started_at: "2026-06-08T12:00:00Z", ended_at: "2026-06-08T13:00:00Z" });
    seed(db, { session_id: "b", cwd: "/repo", started_at: "2026-06-09T12:00:00Z", ended_at: "2026-06-09T13:00:00Z" });
    seed(db, { session_id: "c", cwd: "/repo", started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    await refreshGitOutput(db, [], okRunner, { backfillCap: 2 });
    const dates = (db.query<{ date: string }, []>("SELECT date FROM git_output_daily ORDER BY date DESC").all()).map((r) => r.date);
    expect(dates.length).toBe(2); // capped at 2
    // the two MOST-RECENT missing days, not the oldest
    expect(dates).toEqual([dayKey(db, "2026-06-10T12:00:00Z"), dayKey(db, "2026-06-09T12:00:00Z")]);
    db.close();
  });

  test("a failing date is isolated — other dates still persist, count reflects successes", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const dA = dayKey(db, "2026-06-10T12:00:00Z");
    const dB = dayKey(db, "2026-06-11T12:00:00Z");
    seed(db, { session_id: "a", cwd: "/repo", started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    seed(db, { session_id: "b", cwd: "/repo", started_at: "2026-06-11T12:00:00Z", ended_at: "2026-06-11T13:00:00Z" });
    const flaky = async (args: string[]) => {
      const since = args[args.indexOf("--since") + 1];
      if (since === "2026-06-10T12:00:00Z") throw new Error("git exploded");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { days } = await refreshGitOutput(db, [dA, dB], flaky, {});
    expect(days).toBe(1); // only dB succeeded
    const have = (db.query<{ date: string }, []>("SELECT date FROM git_output_daily").all()).map((r) => r.date);
    expect(have).toEqual([dB]); // dA's failure didn't poison dB or throw
    db.close();
  });
});

describe("backfillExistingDayOutputs (Phase 4 — recompute stale persisted rows after a logic fix)", () => {
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  const dayKey = (db: Database, iso: string): string =>
    (db.query<{ d: string }, [string]>("SELECT DATE(?, 'localtime') d").get(iso)!).d;
  const stale = (db: Database, date: string): void => {
    db.run(`INSERT INTO git_output_daily (date, sessions, commits, insertions, deletions, files_changed, fidelity, deduped, computed_at)
            VALUES (?, 1, 99, 9999, 9999, 99, 'estimated', 1, '2026-01-01T00:00:00Z')`, [date]);
  };

  // The merge/timestamp fixes change computed figures. missingRecentDays SKIPS dates
  // already in git_output_daily, so existing rows would stay stale — this recompute fixes them.
  test("recomputes an existing stale row to the current logic", async () => {
    const db = freshDb();
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", git_branch: null, started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    stale(db, date); // pre-fix inflated figures
    const H = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const runner = async () => ({ exitCode: 0, stdout: [H, "", "4\t1\tsrc/x.ts"].join("\n"), stderr: "" });
    const { days } = await backfillExistingDayOutputs(db, runner, {});
    expect(days).toBe(1);
    const row = db.query<{ commits: number; insertions: number }, [string]>(
      "SELECT commits, insertions FROM git_output_daily WHERE date = ?").get(date)!;
    expect(row.commits).toBe(1); // recomputed — not the stale 99
    expect(row.insertions).toBe(4); // not the stale 9999
    db.close();
  });

  // Bounded so a long history can't git-storm: only the cap most-recent existing rows.
  test("is bounded by cap — only the most-recent existing rows are recomputed", async () => {
    const db = freshDb();
    for (const d of ["2026-06-08", "2026-06-09", "2026-06-10"]) stale(db, d);
    // no sessions seeded → computeDayOutcome returns zeros without calling git, so a
    // throwing runner proves git isn't spawned for these empty days.
    const never = async () => { throw new Error("git should not run for empty days"); };
    const { days } = await backfillExistingDayOutputs(db, never, { cap: 2 });
    expect(days).toBe(2); // capped
    // the OLDEST date kept its stale computed_at (was not recomputed)
    const oldest = db.query<{ computed_at: string }, [string]>(
      "SELECT computed_at FROM git_output_daily WHERE date = ?").get("2026-06-08")!;
    expect(oldest.computed_at).toBe("2026-01-01T00:00:00Z");
    db.close();
  });
});

describe("getDayOutcome (Phase 3 — persisted-first, live fallback)", () => {
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  const dayKey = (db: Database, iso: string): string =>
    (db.query<{ d: string }, [string]>("SELECT DATE(?, 'localtime') d").get(iso)!).d;

  test("returns the persisted row WITHOUT running git", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    db.run(`INSERT INTO git_output_daily (date, sessions, commits, insertions, deletions, files_changed, fidelity, deduped, computed_at)
            VALUES ('2026-06-12', 11, 51, 18015, 384, 60, 'estimated', 1, '2026-06-12T00:00:00Z')`);
    const never = async () => { throw new Error("git must not run for a persisted day"); };
    const out = await getDayOutcome(db, "2026-06-12", never);
    expect(out).toEqual({
      date: "2026-06-12", sessions: 11, commits: 51, insertions: 18015,
      deletions: 384, filesChanged: 60, fidelity: "estimated", deduped: true,
    });
    db.close();
  });

  test("falls back to a live compute when there is no persisted row", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    const H = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const live = async () => ({ exitCode: 0, stdout: [H, "", "4\t1\tsrc/x.ts"].join("\n"), stderr: "" });
    const out = await getDayOutcome(db, date, live);
    expect(out.commits).toBe(1);
    expect(out.insertions).toBe(4);
    db.close();
  });
});
