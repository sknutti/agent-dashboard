// FTS5 content-index coverage. session_search.ts is the THIRD consumer of a raw
// session log (after scripts/adapters/* and error_context.ts): it re-uses the
// display parse to concatenate readable user/assistant/thinking text into one
// searchable `body` per session. Fixtures mirror the claude shape the display
// parser already encodes (see error_context.test.ts) so the consumers can't drift.

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "./db.ts";
import { buildBody, indexSession, indexSessionFromLog, backfillSearchIndex } from "./session_search.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

function fixture(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `ss-${name}-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// Distinctive nonsense tokens per role so a MATCH can prove exactly which message
// text reached the index: user→zebrafish, assistant→quokka, tool-result→platypus.
function claudeFixture(): string {
  const asst = (id: string, ts: string, block: any) =>
    JSON.stringify({ type: "assistant", sessionId: "s", timestamp: ts,
      message: { id, model: "claude-opus-4-8", content: [block] } });
  return fixture("claude", [
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "discuss the zebrafish algorithm" } }),
    asst("msg_A", "2026-06-01T00:00:01Z", { type: "text", text: "I'll edit the quokka module" }),
    asst("msg_A", "2026-06-01T00:00:02Z", { type: "tool_use", id: "tu_1", name: "Bash",
      input: { command: "ls" } }),
    JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:03Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false,
        content: "platypus command output" }] } }),
  ]);
}

function matchIds(db: Database, q: string): string[] {
  return db.query<{ session_id: string }, [string]>(
    "SELECT session_id FROM session_search WHERE session_search MATCH ?",
  ).all(q).map((r) => r.session_id);
}

describe("indexSessionFromLog", () => {
  test("a user/assistant token makes the session findable by MATCH", async () => {
    const db = freshDb();
    await indexSessionFromLog(db, "claude_code", "sess-1", claudeFixture());
    expect(matchIds(db, "zebrafish")).toEqual(["sess-1"]);
    expect(matchIds(db, "quokka")).toEqual(["sess-1"]);
    db.close();
  });

  test("tool-result text is NOT indexed (A2: conversation only)", async () => {
    const db = freshDb();
    await indexSessionFromLog(db, "claude_code", "sess-1", claudeFixture());
    expect(matchIds(db, "platypus")).toEqual([]);
    db.close();
  });

  test("an agent with no display parser is skipped silently — no row, no throw", async () => {
    const db = freshDb();
    await indexSessionFromLog(db, "antigravity", "sess-ag", claudeFixture());
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_search").get()!.n;
    expect(n).toBe(0);
    db.close();
  });
});

describe("indexSession idempotency", () => {
  test("re-indexing the same session keeps exactly one row", () => {
    const db = freshDb();
    indexSession(db, "sess-1", "claude_code", "first body");
    indexSession(db, "sess-1", "claude_code", "second body");
    const rows = db.query<{ session_id: string }, []>(
      "SELECT session_id FROM session_search",
    ).all();
    expect(rows).toEqual([{ session_id: "sess-1" }]);
    // and it reflects the latest content, not the first
    expect(matchIds(db, "second")).toEqual(["sess-1"]);
    expect(matchIds(db, "first")).toEqual([]);
    db.close();
  });
});

describe("backfillSearchIndex", () => {
  // A one-token claude fixture so each backfilled session is matchable distinctly.
  function claudeFixtureWith(token: string): string {
    return fixture("bf", [
      JSON.stringify({ type: "user", timestamp: "2026-06-01T00:00:00Z",
        message: { role: "user", content: `please discuss ${token} today` } }),
    ]);
  }
  function seedSession(db: Database, id: string, agent: string, sourcePath: string | null): void {
    db.run("INSERT INTO sessions (session_id, agent, source_path) VALUES (?,?,?)", [id, agent, sourcePath]);
  }

  test("indexes every display-parser session with a readable log, skips the rest", async () => {
    const db = freshDb();
    seedSession(db, "c1", "claude_code", claudeFixtureWith("alphatoken"));
    seedSession(db, "c2", "claude_code", claudeFixtureWith("betatoken"));
    seedSession(db, "ag", "antigravity", "/tmp/no-parser.jsonl"); // no display parser
    seedSession(db, "gone", "claude_code", "/tmp/does-not-exist-xyz.jsonl"); // missing file
    seedSession(db, "nopath", "claude_code", null); // excluded by the query

    const { indexed, skipped } = await backfillSearchIndex(db);
    expect(indexed).toBe(2);
    expect(skipped).toBe(2); // ag (no parser) + gone (missing file); nopath isn't considered
    expect(matchIds(db, "alphatoken")).toEqual(["c1"]);
    expect(matchIds(db, "betatoken")).toEqual(["c2"]);
    db.close();
  });

  test("is idempotent — re-running keeps exactly one row per session", async () => {
    const db = freshDb();
    seedSession(db, "c1", "claude_code", claudeFixtureWith("alphatoken"));
    await backfillSearchIndex(db);
    await backfillSearchIndex(db);
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_search").get()!.n;
    expect(n).toBe(1);
    db.close();
  });
});

describe("buildBody", () => {
  test("joins user/assistant/thinking text and drops tool + empty entries", () => {
    const body = buildBody([
      { role: "user", text: "alpha", isError: false, ts: "" },
      { role: "thinking", text: "beta", isError: false, ts: "" },
      { role: "assistant", text: "gamma", isError: false, ts: "" },
      { role: "tool", text: "delta", isError: false, ts: "", toolName: "Bash" },
      { role: "assistant", text: "", isError: false, ts: "" },
    ]);
    expect(body).toBe("alpha\nbeta\ngamma");
  });
});
