# On-demand parsed error-context view

Clicking an **Error** opens a session page **Errors tab** that, for each errored tool call, shows the failing tool input + captured error text wrapped in a few messages of **readable parsed context**. The context is produced by **re-parsing the session's raw log on demand** (a display-oriented parse, distinct from the ingest Adapters), scoped to the three text-format Agents — **Claude Code, Codex, Pi**. Antigravity is excluded; its Error clicks fall back to the raw **Messages** feed.

## Status

accepted — extends [ADR-0003](0003-agent-first-ui-with-drilldowns.md)'s read-only drill-down IA. Builds on the **Error** vs **Failure** distinction now in [CONTEXT.md](../../CONTEXT.md).

## Context

"Several places" let you click an errored session, but every one dead-ended at either the raw live-tail feed (which throws away the `tools[]` it fetches) or the drawer's all-tools timeline (error text hidden in a hover `title`). None answered "what failed, and what was the agent trying to do?" — the thing you actually need to fix it.

Two facts shaped the approach:

- The stored `tool_calls` table keeps only `tool_name` + extracted `error` text — **not** the tool input. So the failing command/edit isn't recoverable from the DB.
- The **Messages** feed is a byte-tailing SSE stream (last ~300 lines, no random access). The client can't reliably window context around an older Error from the tail.

The raw log files, however, hold the full ordered transcript *including* tool inputs.

## Decision

- **Parse on demand, don't persist messages.** A new `GET /api/sessions/:id/errors` re-reads the session log and returns each Error with its failing input, error text, and a ±N readable-message context window. We do **not** add a messages table or store display text — the log is the source of truth and the volume (multi-MB transcripts) isn't worth persisting for an occasional view.
- **A display parse separate from the ingest Adapters.** Adapters extract tokens/tools for rollups; they don't emit display-ready messages. The Errors endpoint gets its own per-Agent reader that yields ordered `{role, text, isError, toolInput}` entries. Shared rendering lives in one `<SessionErrors>` component (single host: the session page).
- **Scope: Claude Code + Codex + Pi.** These are text JSONL (107 / 9 / 5 of the current 121 errored sessions). **Antigravity is excluded** — its transcript is a protobuf blob and it has 0 errored sessions; a display decoder is a large lift for no payoff. Antigravity Error clicks open the **Messages** tab with a "parsed error view is unavailable for this agent" note.
- **Errors anchor only on Errors.** Rate-limited / truncated **Failures** carry no failed tool call, so the Errors tab shows a one-line failure explanation and defers to Messages rather than fabricating a window.
- **Messages stays whole.** The Errors tab *extracts* context for display; it never removes anything from the Messages feed, which remains the complete, in-order transcript.

## Considered and rejected

- **Reuse `tools[]` from `/details`, no new endpoint.** Has the Error text but not the tool input and no surrounding messages — can't show "what was it trying to do." Rejected.
- **Persist parsed messages into a table during ingest.** Enables instant windows but bloats the DB with multi-MB transcripts, adds a write path, and couples ingest to a display concern. On-demand parse is cheap enough for a per-session view. Rejected.
- **Client-side windowing on the SSE feed.** The feed is a live tail capped at ~300 lines; older Errors aren't present, and the format is raw JSON. Rejected.
- **All four Agents now (incl. Antigravity protobuf decoder).** Disproportionate effort for 0 errored sessions. Deferred.

## Consequences

- A per-Agent display reader must be written and kept in sync with each log format — a second consumer of formats the Adapters already track. Codex/Pi readers are small (structured JSONL); Antigravity is intentionally absent.
- Error coverage is Agent-dependent: a future Agent (or Antigravity errors) silently falls back to Messages until a reader exists. The fallback note makes this visible rather than a blank tab.
- The page's `?tab=errors` deep link and a clickable `errored` outcome pill / Failures row become the entry points; the AgentCard **errors** drill stops at the drawer list and hands off to the page (other drills keep their in-drawer detail).
- Per [ADR-0003](0003-agent-first-ui-with-drilldowns.md), this stays **read-only** — surfacing the Error to address, not acting on it. A Phase 6 "act on this Error" affordance can slot into `<SessionErrors>` without restructuring.
