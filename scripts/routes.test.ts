import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "./db.ts";
import { rangePred, buildSessionErrors, buildSessionMessages, buildSearch, buildBurnOutput } from "./routes.ts";
import { indexSession } from "./session_search.ts";

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

// GET /api/sessions/:id/messages core logic (buildSessionMessages). Serves the
// WHOLE parsed Transcript for an ENDED session (vs the windowed Errors view), and
// signals a still-live session so the client renders the raw byte-tail instead.
describe("buildSessionMessages (#messages-endpoint)", () => {
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

  /** A minimal claude transcript: user prompt + a (split) thinking/text turn. */
  function claudeMsgLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "msg-route-"));
    const path = join(dir, "session.jsonl");
    const asst = (id: string, ts: string, block: any) =>
      JSON.stringify({ type: "assistant", timestamp: ts, message: { id, content: [block] } });
    writeFileSync(path, [
      JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z", message: { content: "hi" } }),
      asst("a", "2026-06-01T00:00:01Z", { type: "thinking", thinking: "pondering" }),
      asst("a", "2026-06-01T00:00:02Z", { type: "text", text: "hello there" }),
    ].join("\n") + "\n", "utf8");
    return path;
  }

  test("ended claude session returns live:false + the whole parsed Transcript (incl thinking)", async () => {
    const db = freshDb();
    // ended_at far in the past ⟹ outside the 5-min live window ⟹ ended.
    insertSession(db, { session_id: "m1", agent: "claude_code", source_path: claudeMsgLog(),
      ended_at: "2020-01-01T00:00:00Z" });
    const { status, body } = await buildSessionMessages(db, "m1");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: true, live: false });
    const msgs = (body as any).messages as { role: string; ts: string }[];
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some((m) => m.role === "thinking")).toBe(true);
    expect(msgs.every((m) => typeof m.ts === "string")).toBe(true);
    db.close();
  });

  test("live session (null ended_at) returns live:true with no messages", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "m2", agent: "claude_code", source_path: claudeMsgLog(), ended_at: null });
    const { status, body } = await buildSessionMessages(db, "m2");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: true, live: true });
    expect((body as any).messages ?? []).toEqual([]);
    db.close();
  });

  test("a session that ended in the last 5 min still reads as live (reuses /sessions/live window)", async () => {
    const db = freshDb();
    // ended just now → inside the 5-min window → still tail-able as live.
    const recent = (db.query("SELECT datetime('now','-1 minutes') t").get() as { t: string }).t;
    insertSession(db, { session_id: "m2b", agent: "claude_code", source_path: claudeMsgLog(), ended_at: recent });
    const { body } = await buildSessionMessages(db, "m2b");
    expect(body).toMatchObject({ supported: true, live: true });
    db.close();
  });

  test("antigravity (no parser) on an ended session returns supported:false + a note", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "m3", agent: "antigravity", source_path: "/tmp/whatever",
      ended_at: "2020-01-01T00:00:00Z" });
    const { status, body } = await buildSessionMessages(db, "m3");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: false, live: false });
    expect((body as any).note).toBeTruthy();
    db.close();
  });

  test("null source_path on an ended session degrades to a supported:false note, not a 500", async () => {
    const db = freshDb();
    insertSession(db, { session_id: "m4", agent: "claude_code", source_path: null,
      ended_at: "2020-01-01T00:00:00Z" });
    const { status, body } = await buildSessionMessages(db, "m4");
    expect(status).toBe(200);
    expect(body).toMatchObject({ supported: false, live: false });
    expect((body as any).note).toBeTruthy();
    db.close();
  });

  test("unknown session id returns 404", async () => {
    const db = freshDb();
    const { status } = await buildSessionMessages(db, "nope");
    expect(status).toBe(404);
    db.close();
  });
});

// GET /api/search core logic (buildSearch) — FTS5 MATCH joined back to sessions for
// display rows. Always 200: degrade-don't-500 on empty/malformed queries.
describe("buildSearch (#content-search)", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    return db;
  }

  /** Insert a session row + its searchable body so JOIN sessions yields display fields. */
  function seed(db: Database, id: string, body: string, extra: Record<string, unknown> = {}): void {
    const row = { session_id: id, agent: "claude_code", title: `title ${id}`,
      cwd: `/repo/${id}`, started_at: "2026-06-01T00:00:00Z", ...extra };
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => (row as any)[k]));
    indexSession(db, id, row.agent as string, body);
  }

  test("returns only the session whose content matches, with a snippet of the term", () => {
    const db = freshDb();
    seed(db, "alpha", "the zebrafish algorithm is subtle");
    seed(db, "beta", "a completely unrelated quokka discussion");
    const res = buildSearch(db, "zebrafish");
    expect(res.results.map((r) => r.session_id)).toEqual(["alpha"]);
    expect(res.results[0]!.snippet).toContain("zebrafish");
    expect(res.results[0]!.title).toBe("title alpha"); // joined from sessions
    db.close();
  });

  test("multiple terms AND together (both must appear)", () => {
    const db = freshDb();
    seed(db, "both", "zebrafish and quokka together");
    seed(db, "one", "only the zebrafish here");
    const res = buildSearch(db, "zebrafish quokka");
    expect(res.results.map((r) => r.session_id)).toEqual(["both"]);
    db.close();
  });

  test("empty query returns the zero-shaped body, no error", () => {
    const db = freshDb();
    seed(db, "alpha", "zebrafish");
    expect(buildSearch(db, "   ")).toEqual({ q: "", total: 0, limit: 50, offset: 0, results: [] });
    db.close();
  });

  test("malformed FTS5 query degrades to [] without throwing", () => {
    const db = freshDb();
    seed(db, "alpha", "zebrafish");
    // A bare double-quote / operator soup would throw raw against FTS5.
    const res = buildSearch(db, 'foo" AND (');
    expect(res.results).toEqual([]);
    db.close();
  });

  test("limit clamps the number of hits", () => {
    const db = freshDb();
    for (const id of ["a", "b", "c"]) seed(db, id, "shared zebrafish token");
    const res = buildSearch(db, "zebrafish", { limit: 2 });
    expect(res.results.length).toBe(2);
    db.close();
  });

  test("equal-rank hits order deterministically (started_at DESC) and partition across pages", () => {
    const db = freshDb();
    // Identical bodies → identical bm25 rank, so the tie-break decides order.
    // Insert in an order (a,b,c) that differs from the expected tie-break order
    // (b,a,c by started_at DESC) so a missing tie-break would surface as flakiness.
    seed(db, "a", "shared zebrafish token", { started_at: "2026-06-02T00:00:00Z" });
    seed(db, "b", "shared zebrafish token", { started_at: "2026-06-03T00:00:00Z" });
    seed(db, "c", "shared zebrafish token", { started_at: "2026-06-01T00:00:00Z" });
    const all = buildSearch(db, "zebrafish");
    expect(all.results.map((r) => r.session_id)).toEqual(["b", "a", "c"]);
    // and the order is stable across an OFFSET boundary (no drop, no repeat)
    const p1 = buildSearch(db, "zebrafish", { limit: 2, offset: 0 }).results.map((r) => r.session_id);
    const p2 = buildSearch(db, "zebrafish", { limit: 2, offset: 2 }).results.map((r) => r.session_id);
    expect(p1).toEqual(["b", "a"]);
    expect(p2).toEqual(["c"]);
    db.close();
  });

  test("an orphan index row (session deleted) is dropped by the JOIN", () => {
    const db = freshDb();
    indexSession(db, "ghost", "claude_code", "zebrafish with no session row");
    expect(buildSearch(db, "zebrafish").results).toEqual([]);
    db.close();
  });

  test("filters by agent (qualified s.agent — the JOIN exposes agent on both tables)", () => {
    const db = freshDb();
    seed(db, "cc", "shared zebrafish token", { agent: "claude_code" });
    seed(db, "cx", "shared zebrafish token", { agent: "codex" });
    const res = buildSearch(db, "zebrafish", { agent: "codex" });
    expect(res.results.map((r) => r.session_id)).toEqual(["cx"]);
    expect(res.total).toBe(1);
    // "all"/invalid agent is a no-op filter
    expect(buildSearch(db, "zebrafish", { agent: "all" }).total).toBe(2);
    db.close();
  });

  test("filters by outcome (OUTCOME_CASE over the joined sessions row)", () => {
    const db = freshDb();
    seed(db, "ok1", "shared zebrafish token", { ended_at: "2026-06-01T01:00:00Z" });
    seed(db, "err1", "shared zebrafish token", { error_count: 2, ended_at: "2026-06-01T01:00:00Z" });
    const res = buildSearch(db, "zebrafish", { outcome: "errored" });
    expect(res.results.map((r) => r.session_id)).toEqual(["err1"]);
    expect(res.total).toBe(1);
    db.close();
  });

  test("filters by range (a session outside the window is excluded)", () => {
    const db = freshDb();
    seed(db, "recent", "shared zebrafish token",
      { started_at: new Date().toISOString() });
    seed(db, "old", "shared zebrafish token",
      { started_at: "2020-01-01T00:00:00Z" });
    const res = buildSearch(db, "zebrafish", { range: "7d" });
    expect(res.results.map((r) => r.session_id)).toEqual(["recent"]);
    expect(res.total).toBe(1);
    db.close();
  });

  test("paginates: total is the full match count, stable across pages", () => {
    const db = freshDb();
    for (const id of ["a", "b", "c"]) seed(db, id, "shared zebrafish token");
    const page1 = buildSearch(db, "zebrafish", { limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.results.length).toBe(2);
    const page2 = buildSearch(db, "zebrafish", { limit: 2, offset: 2 });
    expect(page2.total).toBe(3); // total unaffected by paging
    expect(page2.results.length).toBe(1);
    // the two pages partition the set — no overlap, no gap
    const ids = [...page1.results, ...page2.results].map((r) => r.session_id);
    expect(new Set(ids).size).toBe(3);
    db.close();
  });
});

// GET /api/burn/output core (buildBurnOutput) — reads the persisted, deduped
// git_output_daily rollup over a range. Cost arithmetic (mergeBurnByDate) untouched.
describe("buildBurnOutput (#burn-output)", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    return db;
  }
  test("returns persisted daily output within the range, deduped figures intact", () => {
    const db = freshDb();
    const inRange = (db.query("SELECT date('now','localtime','-1 days') d").get() as { d: string }).d;
    const outRange = (db.query("SELECT date('now','localtime','-40 days') d").get() as { d: string }).d;
    db.run("INSERT INTO git_output_daily (date, sessions, commits, insertions, deletions, files_changed) VALUES (?,?,?,?,?,?)", [inRange, 2, 3, 25, 6, 4]);
    db.run("INSERT INTO git_output_daily (date, sessions, commits, insertions, deletions, files_changed) VALUES (?,?,?,?,?,?)", [outRange, 1, 9, 99, 9, 9]);
    const res = buildBurnOutput(db, "7d");
    expect(res.days.map((d) => d.date)).toEqual([inRange]); // out-of-range excluded
    expect(res.days[0]!.commits).toBe(3);
    expect(res.days[0]!.filesChanged).toBe(4);
    expect(res.days[0]!.fidelity).toBe("estimated");
    db.close();
  });
});
