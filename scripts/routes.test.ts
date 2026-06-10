import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./db.ts";
import { rangePred } from "./routes.ts";

// The rollup tables store `date` as an already-local YYYY-MM-DD. The old predicate
// wrapped it in DATE(date,'localtime') a SECOND time, which shifts each date back a
// day in zones west of UTC and dropped the oldest day of every range. These tests
// pin the corrected (raw, sargable) behavior independent of the host timezone.
describe("rangePred (#12)", () => {
  test("the rollup `date` column is compared RAW (no DATE/localtime wrapper)", () => {
    const p = rangePred("7d", "date");
    expect(p).not.toContain("DATE(date");
    expect(p).toContain("date >=");
  });

  test("timestamp columns keep the (single, correct) localtime bucketing", () => {
    expect(rangePred("7d", "started_at")).toContain("DATE(started_at,'localtime')");
    expect(rangePred("7d", "ts")).toContain("DATE(ts,'localtime')");
  });

  test("a token_usage row on the range's first local day is INCLUDED (was dropped)", () => {
    const db = new Database(":memory:");
    initSchema(db);
    // Compute the actual 7d lower bound the predicate uses, then insert a row dated
    // exactly on it — the boundary day the old double-localtime predicate excluded.
    const bound = (db.query("SELECT date('now','localtime','-6 days') b").get() as { b: string }).b;
    db.run(
      "INSERT INTO token_usage (date, agent, model, source, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)",
      [bound, "claude_code", "m", "", 100, 50],
    );
    // The corrected predicate includes the boundary day in EVERY timezone (this is
    // the universal correctness invariant). The old DATE(date,'localtime') wrapper
    // dropped it only in zones west of UTC, so asserting that here would be
    // host-TZ-dependent (and would flip in CI's UTC) — the empirical before/after
    // (4→5 days, +418K tokens) is recorded in the batch-10 commit instead.
    const got = db.query(`SELECT COUNT(*) n FROM token_usage WHERE ${rangePred("7d", "date")}`).get() as { n: number };
    expect(got.n).toBe(1);
    db.close();
  });
});
