// Content search index — the write half of the FTS5 session-content search.
//
// A THIRD consumer of each agent's raw session log (after scripts/adapters/* and
// error_context.ts). It re-uses the on-demand display parse to flatten a session
// into one searchable `body` of readable conversation text, stored in the
// `session_search` FTS5 table (scripts/db.ts). Message content is otherwise never
// persisted (ADR-0005/0006), so this index IS the only queryable copy.
//
// Scope (A2): only user + assistant + thinking text is indexed — the human-readable
// conversation. Tool result/input blobs are deliberately excluded as high-noise.
// Agents without a display parser (antigravity) are silently skipped — no row, not
// an error (mirrors the Errors/Messages endpoints' degrade-don't-throw posture).

import { Database } from "bun:sqlite";
import { parseDisplay, DISPLAY_PARSER_AGENTS, type DisplayMessage } from "./error_context.ts";

/** The roles whose readable text is worth searching (A2). */
const INDEXED_ROLES = new Set<DisplayMessage["role"]>(["user", "assistant", "thinking"]);

/** Concatenate the readable conversation text of a transcript into one body.
 *  Pure — the single place the indexed content scope (A2) is decided. */
export function buildBody(messages: DisplayMessage[]): string {
  return messages
    .filter((m) => INDEXED_ROLES.has(m.role) && m.text)
    .map((m) => m.text)
    .join("\n");
}

/** Idempotently (re)index one session's body. FTS5 has no UPSERT, so the reparse
 *  pattern is DELETE-then-INSERT keyed on session_id — mirrors the tool_calls
 *  reparse in sync_agents.ts. Empty body still clears any stale row. */
export function indexSession(db: Database, sessionId: string, agent: string, body: string): void {
  db.run("DELETE FROM session_search WHERE session_id = ?", [sessionId]);
  if (!body) return;
  db.run("INSERT INTO session_search (session_id, agent, body) VALUES (?, ?, ?)", [
    sessionId,
    agent,
    body,
  ]);
}

/** Parse a session's raw log and (re)index its readable content. Agents with no
 *  display parser are skipped silently (expected, not an error). The file is the
 *  same one the adapter just read — at tracer scale this second pass is acceptable
 *  (the top post-tracer follow-up is fusing the two parsers). */
export async function indexSessionFromLog(
  db: Database,
  agent: string,
  sessionId: string,
  path: string,
): Promise<void> {
  if (!DISPLAY_PARSER_AGENTS.has(agent)) return;
  const messages = await parseDisplay(agent, path);
  indexSession(db, sessionId, agent, buildBody(messages));
}

/** One-shot backfill: index the content of every already-synced session that has a
 *  readable log. The reparse loop only (re)indexes sessions whose file CHANGES, so
 *  on an existing install the index would otherwise stay empty until each session is
 *  touched again — this makes the whole history searchable immediately. Idempotent
 *  (DELETE+INSERT per session), so it's safe to re-run. Non-display agents and
 *  missing/unreadable logs are skipped, not fatal. */
export async function backfillSearchIndex(
  db: Database,
): Promise<{ indexed: number; skipped: number }> {
  const rows = db
    .query<{ session_id: string; agent: string; source_path: string }, []>(
      "SELECT session_id, agent, source_path FROM sessions WHERE source_path IS NOT NULL",
    )
    .all();
  let indexed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!DISPLAY_PARSER_AGENTS.has(r.agent)) {
      skipped += 1;
      continue;
    }
    try {
      await indexSessionFromLog(db, r.agent, r.session_id, r.source_path);
      indexed += 1;
    } catch {
      // Missing/unreadable log (e.g. the raw file was deleted) — skip, don't abort
      // the whole backfill. A later reparse re-indexes it if the file returns.
      skipped += 1;
    }
  }
  return { indexed, skipped };
}
