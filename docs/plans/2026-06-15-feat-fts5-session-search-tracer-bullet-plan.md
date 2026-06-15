# FTS5 Session-Content Search — Tracer Bullet Plan

- **Date:** 2026-06-15
- **Type:** feat
- **Status:** completed
- **Scope:** One end-to-end vertical slice (SQLite FTS5 over session message content + one search API endpoint + minimal UI) that proves cross-session full-text search works before any expansion.

## Overview / Problem Statement

The dashboard can currently search sessions only by **metadata** — `GET /api/sessions?q=...` runs `title LIKE ? OR cwd LIKE ?` (`scripts/routes.ts:375`). There is no way to find *"which session did I discuss FTS5 in"* by the **content** of the transcript. The readable content of a session (`DisplayMessage.text`) is never stored in SQLite; it is re-parsed on demand from the raw JSONL via `parseDisplay()` (`scripts/error_context.ts:108`) only when a user opens the Errors or Messages tab.

This tracer bullet proves the whole loop — **index → query → render** — across **all** sessions, end to end, with the smallest possible surface. It deliberately does not solve incremental indexing perfectly, ranking quality, snippet polish, or multi-agent edge cases; those are explicit follow-ups gated on this slice working.

This is a Pragmatic-Programmer tracer bullet: thin, real, all-layers, feedback-first.

## Current State

### Facts (verified against current code)
- **Stack:** Bun + Hono + `bun:sqlite` + Svelte 5. Server is `scripts/server.ts`; API routes register via `registerApiRoutes(app)` in `scripts/routes.ts:270`. (ADR-0001)
- **FTS5 is available** in `bun:sqlite` with zero extra setup — verified by probe: `CREATE VIRTUAL TABLE ... USING fts5(...)` + `MATCH` works in `:memory:`.
- **Schema** is centralized in `scripts/db.ts` (`SCHEMA` const + `initSchema()`), all `CREATE TABLE IF NOT EXISTS`, run on every boot on the main thread *before* the worker opens its connection (`scripts/server.ts:24`). The schema is intentionally "build the complete observability schema up front" — message content is NOT among its tables.
- **Message content is not persisted.** Ingest (`scripts/sync_agents.ts`) writes only `sessions`, `tool_calls`, `token_usage`, `burn_daily`, `activities`. The readable transcript is produced on demand by `parseDisplay(agent, sourcePath)` returning `DisplayMessage[]` (`role`, `text`, `isError`, `ts`, `toolName?`, `toolInput?`).
- **Re-parse seam exists.** The ingest worker already calls `parseAndWrite(adapter, path, liveActive)` per changed source file (`scripts/sync_agents.ts:257`), gated by `reparseDecision()` (mtime vs `synced_at`, plus "still live → always reparse"). This is the natural hook for content indexing — the file is already open and the session row is being written in `writeSession` (a `db.transaction`).
- **`source_path`** column on `sessions` is the stable raw-log key (basename ≠ session_id for codex/pi/antigravity); indexed via `idx_sessions_source_path`.
- **Display parser scope** is three agents: `DISPLAY_PARSER_AGENTS = {claude_code, codex, pi}` (`error_context.ts:104`). Antigravity (protobuf) has no display parser and must degrade gracefully, not 500.
- **An existing `q` seam:** `/api/sessions` already accepts `q` and the UI already renders a search box (`SessionsTablePanel.svelte:66`, placeholder `"title or path…"`). This is metadata-only and is the contrast/integration point — content search is a *new, distinct* capability, not a replacement of that filter.
- **Privacy posture:** localhost-only, zero outbound (CONTEXT.md, server binds `127.0.0.1` only). Raw logs are treated as un-redacted local data (ADR-0005 Q1) — so indexing their text introduces no new privacy boundary.
- **Test conventions:** backend tests are `bun test scripts` against in-memory DBs (`buildSessionMessages`/`buildSessionErrors` are factored out specifically for this); UI tests are Vitest/`*.svelte.test.ts`. `bun run check` is the full gate.

### Assumptions (plausible, unverified — labeled)
- **A1:** A standalone FTS5 table (external-content not required for a tracer) keyed by `session_id` is sufficient. We store concatenated readable text per session, not per message. *Rationale:* the goal is "find the session," matching the existing session-centric UI; per-message granularity is a later refinement.
- **A2:** Indexing the `text` of `user` + `assistant` + `thinking` messages (skipping `tool` result blobs and `toolInput`) is the right v1 content scope — it's the human-readable conversation, lowest noise. *Adjustable in one place.*
- **A3:** Re-indexing on the existing per-file reparse tick is acceptable latency for a tracer (sessions become searchable within one sync interval, default ~120s). Real-time is not a tracer requirement.
- **A4:** Total readable text across all local sessions fits comfortably in the existing single SQLite file without special tuning at tracer scale. (Verify in Phase 1 against the real `data/` DB.)
- **A5:** A new top-level `/search` is heavier than needed for a tracer; surfacing results inside the existing Sessions surface (or a thin dedicated panel) proves the loop with less UI. *See Open Question OQ1.*

### Open Questions (only the ones that change the plan)
- **OQ1 (UI placement — low-stakes, proceeding with an assumption):** Should the minimal UI be (a) a brand-new `/search` route, or (b) a "search content" toggle/second box reusing `SessionsTablePanel`? *Proceeding with (b)-lite: a small dedicated `ContentSearchPanel` on an existing route, behind a clearly distinct input, to avoid conflating with the metadata `q` box. Easy to promote to a route later.* Flag if you want a route instead.
- **OQ2 (non-blocking):** Snippet/highlight fidelity for v1 — plain `snippet()`/`highlight()` from FTS5 is enough for the tracer; do you want match-term highlighting in the UI now or as the first follow-up? *Default: basic `snippet()` server-side, no client highlighting yet.*

## Proposed Solution (shape)

Add one FTS5 virtual table (`session_search`) populated from the **already-open** transcript during the existing reparse, expose **one** read endpoint `GET /api/search?q=...` that runs a `MATCH` join back to `sessions` for display rows, and render results in **one** minimal Svelte panel that links each hit to the existing session detail. No new worker, no new parser, no schema migration framework — it rides every existing seam.

```
sync_agents.parseAndWrite ──(reuse parseDisplay)──▶ session_search (FTS5)
                                                          ▲
GET /api/search?q ──MATCH + JOIN sessions──────────────────┘──▶ result rows
        ▲
ContentSearchPanel.svelte ──fetch──┘──▶ link to /session/:id (existing detail)
```

## Implementation Phases

> Sequencing is validation-first: schema + index population proven by a backend unit test before any endpoint, endpoint proven before any pixel. Each phase is independently demoable.

### Phase 1 — Index: FTS5 table + population on reparse (backend, test-first)

- **Objective:** Every (re)parsed session's readable content lands in a queryable FTS5 table, idempotently, across all three display-parser agents.
- **Why this phase exists:** The index is the foundation; if content can't be reliably written and matched, nothing downstream matters. Proving it in isolation (in-memory DB) is the cheapest possible feedback.
- **Changes:**
  1. **`scripts/db.ts`** — add to `SCHEMA`:
     ```sql
     CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
       session_id UNINDEXED,
       agent UNINDEXED,
       body,
       tokenize = 'unicode61'
     );
     ```
     (Tracer keeps it a *standalone* contentless-free FTS5 table — simplest correct option; external-content + triggers is a Phase-4 optimization, see Out of Scope.)
  2. **`scripts/sync_agents.ts`** — in `parseAndWrite`, after `writeSession(...)`, for agents in `DISPLAY_PARSER_AGENTS`, call `parseDisplay(agent, path)`, concatenate `text` of `user`/`assistant`/`thinking` messages (A2), and upsert into `session_search`. Since FTS5 has no UPSERT on `session_id`, the idempotent pattern is `DELETE FROM session_search WHERE session_id = ?` then `INSERT` — mirrors the existing `deleteToolCalls.run(...)` reparse pattern (`sync_agents.ts:242`). Wrap inside the existing `writeSession` transaction or an adjacent one so a half-written row can't be matched.
     - Skip antigravity and any agent not in `DISPLAY_PARSER_AGENTS` (no parser → no content row; that's expected, not an error).
     - One extra `parseDisplay` pass per reparse re-reads the file the adapter just read. Acceptable for a tracer (A3); noted as a Phase-4 fusion candidate (parse once, feed both consumers).
- **Affected areas:** `scripts/db.ts`, `scripts/sync_agents.ts`. New test file `scripts/session_search.test.ts` (or extend an ingest test).
- **Dependencies:** none — `parseDisplay` and the reparse loop already exist.
- **Risks:**
  - *FTS5 query-syntax injection / errors:* a user query like `foo"` is invalid FTS5 and throws. Mitigated in Phase 2 (sanitize/quote), but the index itself is unaffected.
  - *Double-indexing live sessions:* live sessions reparse every tick; the DELETE-then-INSERT keeps the row correct (no duplicates), just re-does work. Fine for a tracer.
  - *Memory:* `parseDisplay` already caps text (`TEXT_CAP`/`INPUT_CAP` in `error_context.ts`), bounding row size.
- **Validation:**
  - Unit test against an in-memory DB: seed a fixture raw log (reuse the `error_context.test.ts` claude/codex/pi fixtures), run the parse-and-index path, assert `SELECT session_id FROM session_search WHERE session_search MATCH 'known-token'` returns the right session.
  - Idempotency test: index the same session twice, assert exactly one row.
  - Run against the real `data/` DB once (`bun run sync` then a manual `MATCH` query) to sanity-check size/latency (validates A4).

### Phase 2 — Query: `GET /api/search?q=` endpoint (backend, test-first)

- **Objective:** One read endpoint returns ranked session hits with a snippet, safely handling empty/invalid queries.
- **Why this phase exists:** This is the contract the UI consumes; proving it with a route test makes the UI phase pure presentation.
- **Changes:**
  1. **`scripts/routes.ts`** — register `app.get("/api/search", ...)`. Factor the core into a testable `buildSearch(db, q, limit)` (mirror the `buildSessionMessages` factoring at `routes.ts:223` so it's unit-testable against an in-memory DB).
     - Sanitize `q`: trim; if empty → `{ results: [] }` (200, not an error). Wrap the user term as a quoted FTS5 string or use a safe phrase form so stray `"`/`*`/`:` can't throw a SQLite error (catch + return `{ results: [], error: "bad query" }` as a 200 fallback, matching the app's "degrade, don't 500" posture in `buildSessionMessages`).
     - Query: `SELECT s.session_id, s.agent, s.title, s.cwd, s.started_at, snippet(session_search, 2, '[', ']', '…', 12) AS snippet FROM session_search JOIN sessions s USING (session_id) WHERE session_search MATCH ? ORDER BY rank LIMIT ?` (FTS5 `rank` = bm25). `LIMIT` clamped like `/api/sessions` (≤500).
  2. **`scripts/wire.ts`** — add `SearchResult` / `SearchResponse` shapes (alongside `SessionMessagesResponse` et al.).
  3. **`ui/src/lib/api.ts`** — add the mirrored TS interface + a `searchContent(q)` client fn (the file already mirrors wire types).
- **Affected areas:** `scripts/routes.ts`, `scripts/wire.ts`, `ui/src/lib/api.ts`. Test in `scripts/routes.test.ts` (existing) or a new `scripts/search_route.test.ts`.
- **Dependencies:** Phase 1 (table must exist + populate).
- **Risks:**
  - *Invalid FTS5 syntax →* handled by sanitize + try/catch fallback (covered by a test case).
  - *Orphan FTS rows* (session deleted but index row remains): the `JOIN sessions` drops them from results — self-healing for the tracer; a cleanup pass is a follow-up.
- **Validation:**
  - Route test: seed two sessions with distinct content, assert `/api/search?q=alpha` returns only the alpha session, with a snippet containing the term.
  - Edge tests: empty `q` → `[]`; malformed `q` (`foo"`) → `[]` with 200, no throw; `limit` clamping.

### Phase 3 — Render: minimal `ContentSearchPanel` (UI)

- **Objective:** A user can type a query, see matching sessions with snippets, and click through to the existing session detail — proving the full loop visibly.
- **Why this phase exists:** The tracer isn't "done" until a human can drive it end to end and give feedback.
- **Changes:**
  1. **`ui/src/lib/components/panels/ContentSearchPanel.svelte`** (new) — a `Card` (reuse `ui/Card.svelte`, `EmptyState`, `Badge`, `Icon` per existing panels) with a search `<input>`, a debounced fetch to `searchContent(q)`, and a result list. Each result shows agent badge + title/cwd + snippet, and links to the existing session route (`navigate('/session/' + id)` or an `<a href>`; reuse `router.svelte.ts` `sessionIdFromPath` conventions). **No `useEffect`-equivalent**: drive the fetch from the input event handler + a `resource`-style store (the repo already has `ui/src/lib/resource.svelte.ts`); use derived state for rendering. Distinct placeholder (e.g. `"search transcript content…"`) so it is visibly NOT the metadata `q` box.
  2. **Placement (per A5/OQ1):** mount the panel on an existing route — recommend `routes/Activity.svelte` or a small section above `SessionsTablePanel` — rather than adding a nav route, to keep the slice thin. Easy to promote later.
- **Affected areas:** `ui/src/lib/components/panels/ContentSearchPanel.svelte` (new) + one existing route file to mount it. New `ContentSearchPanel.svelte.test.ts`.
- **Dependencies:** Phase 2 (endpoint + api client).
- **Risks:**
  - *Color palette:* per project memory, Scott is red/green colorblind — use the existing Okabe-Ito/neutral panel styling already in the components, no new red/green status pairs.
  - *useEffect lint hook* will flag any stray effect — use event handler + derived state / `resource.svelte.ts` instead.
- **Validation:**
  - Vitest component test: mock `searchContent`, assert results render and an empty result shows `EmptyState`.
  - Manual: run `bun run dev` + `bun run dev:ui`, type a term known to appear in a real local session, confirm the right session(s) appear and the link opens detail.

## Acceptance Criteria

- [x] `session_search` FTS5 table exists after a normal boot (no manual migration), created by `initSchema`.
- [x] After one sync tick, content from `claude_code`, `codex`, and `pi` sessions is queryable; antigravity sessions are silently skipped (no error, no empty-placeholder row).
- [x] Re-indexing the same session does not create duplicate rows (idempotent, verified by test).
- [x] `GET /api/search?q=<term>` returns matching sessions ordered by relevance with a snippet, joined to live `sessions` rows.
- [x] `GET /api/search` with empty or malformed `q` returns `200` with `{ results: [] }` — never a 500.
- [x] The minimal UI panel lets a user search content across **all** sessions and click a result into the existing session detail.
- [x] `bun run check` passes (tsc + `bun test scripts` + UI check + UI tests). — 451 backend + 203 UI tests, svelte-check 0/0.
- [x] No `useEffect` introduced in the new Svelte component. — event-driven debounce, no `$effect`.

**Added beyond the original scope (per Scott's call, OQ resolved during execution):** a
one-shot backfill (`backfillSearchIndex` + `bun run reindex`) because the reparse loop
alone leaves all *pre-existing* sessions unindexed — verified against the real `data/`
DB: 567/590 sessions indexed, sub-0.2ms queries (e.g. "playwright" → 49 hits).

## Dependencies and Risks

- **Reuses, adds no new infra:** rides the existing reparse loop, `parseDisplay`, Hono route registration, and the Svelte panel/`resource` patterns. No new worker, no new process, no schema-migration framework.
- **Double parse per reparse** (adapter + `parseDisplay`) is the main inefficiency; bounded by existing text caps and acceptable at tracer scale (A3/A4). Logged as the top Phase-4 follow-up (fuse the two parsers).
- **Standalone (non-external-content) FTS5** duplicates body text in the index file; fine for a tracer, revisit if `data/` DB size becomes a concern (A4 verification in Phase 1).
- **FTS5 query syntax** is user-facing; the sanitize + catch-and-degrade in Phase 2 is load-bearing for not crashing on `"`/`*`/`:`.
- **Privacy:** introduces no new boundary — content is already local, un-redacted, localhost-only.

## Out of Scope (explicit — these are the post-tracer expansions)

- External-content FTS5 + triggers / parse-once fusion of the two parsers (the efficiency rewrite).
- Per-message granularity, tool-output/`toolInput` indexing, code-aware tokenizer.
- Match highlighting in the client, advanced ranking/filters (by agent/date/outcome), pagination.
- A dedicated `/search` nav route + command-palette integration.
- Orphan-row cleanup pass, backfill/reindex CLI command.
- Indexing antigravity (needs a protobuf display parser first).

## References

- `scripts/db.ts` — schema home (`SCHEMA`, `initSchema`); where `session_search` is added.
- `scripts/sync_agents.ts:197` (`writeSession`), `:257` (`parseAndWrite`), `:288` (`reparseDecision`) — the index-population hook.
- `scripts/error_context.ts:26` (`DisplayMessage`), `:104` (`DISPLAY_PARSER_AGENTS`), `:108` (`parseDisplay`) — content source.
- `scripts/routes.ts:223` (`buildSessionMessages` factoring to mirror), `:369` (`/api/sessions` existing metadata `q`) — endpoint pattern + contrast point.
- `scripts/wire.ts`, `ui/src/lib/api.ts` — wire/client type mirroring.
- `ui/src/lib/components/panels/SessionsTablePanel.svelte:66` — existing metadata search UI (distinct from this content search).
- `ui/src/lib/resource.svelte.ts`, `ui/src/lib/router.svelte.ts` — UI data-fetch + navigation patterns (no `useEffect`).
- ADR-0001 (stack), ADR-0005/0006 (on-demand parsing posture), CONTEXT.md "Message"/"Transcript" definitions.

## Next Step

`/workflows:work docs/plans/2026-06-15-feat-fts5-session-search-tracer-bullet-plan.md` — the plan is concrete enough to execute. Phase 1 is test-first against in-memory DB fixtures already present in `error_context.test.ts`. If you want a dedicated `/search` route instead of the embedded panel (OQ1), say so before Phase 3.
