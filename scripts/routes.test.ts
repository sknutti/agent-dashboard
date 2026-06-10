import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "./db.ts";
import { rangePred, buildSessionErrors } from "./routes.ts";

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

// GET /api/sessions/:id/errors core logic (buildSessionErrors), exercised against
// an in-memory DB with a temp fixture file standing in for sessions.source_path.
describe("buildSessionErrors (#errors-endpoint)", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    return db;
  }

  function insertSession(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(
      `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any),
    );
  }

  /** A minimal claude transcript with one errored Edit, written to a temp file. */
  function claudeErrLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "ec-route-"));
    const path = join(dir, "session.jsonl");
    const asst = (id: string, ts: string, block: any) =>
      JSON.stringify({ type: "assistant", timestamp: ts, message: { id, content: [block] } });
    writeFileSync(path, [
      JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "fix it" } }),
      asst("a", "2026-06-01T00:00:01Z", { type: "tool_use", id: "tu", name: "Edit",
        input: { file_path: "foo.ts", old_string: "x" } }),
      JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:02Z",
        message: { content: [{ type: "tool_result", tool_use_id: "tu", is_error: true, content: "no match" }] } }),
    ].join("\n") + "\n", "utf8");
    return path;
  }

  test("errored claude session returns the windowed errors with input + text", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "s1", agent: "claude_code", source_path: claudeErrLog(), error_count: 1 });
    const { status, body } = await buildSessionErrors(db, "s1");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: true, outcome: "errored" });
    const errs = (body as any).errors;
    expect(errs.length).toBe(1);
    expect(errs[0].toolName).toBe("Edit");
    expect(errs[0].toolInput).toContain("foo.ts");
    expect(errs[0].errorText).toContain("no match");
    db.close();
  });

  test("antigravity (no display parser) returns supported:false with a note", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "s2", agent: "antigravity", source_path: "/tmp/whatever", error_count: 1 });
    const { status, body } = await buildSessionErrors(db, "s2");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: false, outcome: "errored" });
    expect((body as any).note).toBeTruthy();
    db.close();
  });

  test("rate-limited session (no errors) returns errors:[] + a failureNote", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "s3", agent: "claude_code", source_path: claudeErrLog(),
      error_count: 0, rate_limit_hit: 1 });
    const { status, body } = await buildSessionErrors(db, "s3");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: true, outcome: "rate_limited" });
    expect((body as any).errors).toEqual([]);
    expect((body as any).failureNote).toBeTruthy();
    db.close();
  });

  test("unknown session id returns 404", async () => {
    const db = freshDb();
    const { status } = await buildSessionErrors(db, "nope");
    expect(status).toBe(404);
    db.close();
  });

  test("null source_path degrades to supported:false note, not a 500", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "s4", agent: "claude_code", source_path: null, error_count: 1 });
    const { status, body } = await buildSessionErrors(db, "s4");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: false, outcome: "errored" });
    expect((body as any).note).toBeTruthy();
    db.close();
  });
});
