# Production-grade FTS5 content search

- date: 2026-06-15
- type: feat
- branch base: `feat/fts5-session-search` (PR #16, tracer bullet `74377df`)
- depth: standard

## Overview

The FTS5 content-search tracer (one `GET /api/search?q=` endpoint, a single
`session_search` FTS5 table, a debounced `ContentSearchPanel` on the Activity
route) is shipped but minimal: no filters, a hard `LIMIT` with no pagination,
default bm25 ordering, and snippets that render the server's `[ ]` delimiters as
**literal bracket characters** in the UI (no real highlighting).

This plan makes it production-grade in four independently shippable slices that
mirror the established `/api/sessions` + `SessionsTablePanel` conventions, stays
test-first, and honors the no-`$effect` / colorblind-palette rules.

## Current state

### Facts (verified in the repo)

- Index write path: `scripts/session_search.ts` — `buildBody` / `indexSession`
  (DELETE+INSERT, no UPSERT) / `indexSessionFromLog` / `backfillSearchIndex`.
  Tested in `scripts/session_search.test.ts`.
- Schema: `scripts/db.ts` ~L248 — `session_search` FTS5 vtable with
  `session_id UNINDEXED, agent UNINDEXED, body, tokenize='unicode61'`. The
  `started_at`/`outcome`/date are NOT in the FTS table; they live on `sessions`.
- Read path: `buildSearch(db, q, limit=50)` in `scripts/routes.ts` (~L291) and
  the `GET /api/search` handler (~L444). It runs
  `snippet(session_search, 2, '[', ']', '…', 12)`, JOINs `sessions USING
  (session_id)` (also drops orphan index rows), `ORDER BY rank`, `LIMIT ?`.
  `toMatchQuery` (~L276) neutralizes operator soup; `buildSearch` returns a
  200-shaped body always (empty/malformed `q` → `{ results: [] }` (+`error`)).
- `buildSearch` returns `{ q, results, error? }` — **no `total`/`limit`/`offset`**
  (unlike `/api/sessions`).
- Wire types: `SearchResult` / `SearchResponse` in `scripts/wire.ts` (~L110) and
  mirrored in `ui/src/lib/api.ts` (~L316). `searchContent(q)` client (~L354)
  takes only a bare string.
- The sessions list (`GET /api/sessions`, routes.ts ~L411) is the reference for
  every feature here: `rangePred(range)`, `agentFilter`/`pushAgent`,
  `OUTCOME_CASE` filter, `LIMIT ? OFFSET ?`, and a `{ total, limit, offset, … }`
  response shape. `SessionsTablePanel.svelte` is the reference UI: agent chips +
  outcome chips (from `agentFilterOptions()` in `registry.svelte.ts` and a local
  `OUTCOMES` array), debounced search, a prev/next pager showing
  `from–to of total`, and outcome pills.
- Range vocabulary: `Range = "today" | "7d" | "30d" | "90d"` (`api.ts` L10);
  server `rangeStartSql`/`rangePred` accept those plus default. `/api/sessions`
  also accepts an explicit `range`.
- Colorblind handling already in the codebase is **semantic CSS vars**, not raw
  Okabe-Ito hex: `--red/--amber/--cyan/--green` defined in `ui/src/app.css`
  L23-27. The errored pill pairs the red with a `✗` glyph (redundant encoding)
  precisely for the colorblind rule. New status color MUST reuse these vars +
  a non-color cue, not introduce new red/green pairings.
- Route tests live in `scripts/routes.test.ts` — `describe("buildSearch
  (#content-search)")` (~L232) already seeds `sessions` rows + bodies and asserts
  results/snippet/limit/orphan-drop. Panel tests live in
  `ContentSearchPanel.svelte.test.ts` (vitest + @testing-library/svelte). One
  existing assertion (`findByText(/zebrafish\] algorithm/)`) depends on the raw
  `]` delimiter leaking into rendered text — Phase 2 must update it.

### Assumptions (labeled, not verified)

- A1: The search panel should gain the SAME filter controls as the sessions
  table (agent chips, outcome chips, range). Range can ride the existing
  `ui.range` store like `SessionsTablePanel` does, rather than a panel-local
  control. (Flagged as an open question below — date/range scope.)
- A2: bm25 column weighting is low-value here because the FTS table has exactly
  ONE searchable column (`body`); `bm25()` weighting tunes *across* columns.
  "Ranking polish" is therefore mostly about (a) making ordering explicit/stable
  and (b) optionally a recency tie-break, not multi-column weights. Treat the
  multi-column-weight ask as already-satisfied / N/A and document why.
- A3: Term highlighting is best done by keeping FTS5 `snippet()` server-side and
  having the client split on the `[ ]` delimiters into safe text + `<mark>`
  runs — NO `{@html}`, no offset math. This avoids XSS and a second tokenizer on
  the client. (Decision recorded in Phase 2.)
- A4: "outcome" filter on search means the same `OUTCOME_CASE` classification,
  applied to the JOINed `sessions` row — identical semantics to `/api/sessions`.

### Open questions

- OQ1 (date/range): Should search expose the full `RangeToggle` (today/7d/30d/
  90d) bound to the shared `ui.range`, OR a search-specific date filter? The ask
  says "date/range". Recommendation: reuse the shared `ui.range` + `rangePred`
  for parity and zero new server vocabulary; defer any custom date-picker to a
  follow-up. **This is the one question worth confirming before Phase 1** — it
  changes the server signature (a `range` param vs. a `from`/`to` pair).

## Proposed plan

### Phase 1 — Server: filters + pagination on `/api/search`

- Objective: make `buildSearch` accept agent / outcome / range filters and return
  the `{ total, limit, offset, results }` shape, matching `/api/sessions`.
- Why first: it is the load-bearing contract change; the UI slices (2-4) consume
  it. Filters + pagination ship together because pagination is meaningless
  without a `total`, and `total` must respect the same filters.
- Changes:
  - `scripts/routes.ts`:
    - Extend `buildSearch(db, q, opts)` where
      `opts = { agent?, outcome?, range?, limit?, offset? }`. Build a `where[]`/
      `params[]` pair seeded with `session_search MATCH ?`, then reuse
      `rangePred(range, "started_at")`, `pushAgent(where, params, agentFilter(agent), "s.agent")`,
      and `(${OUTCOME_CASE}) = ?` exactly as `/api/sessions` does (qualify columns
      with `s.` since the query JOINs `sessions s`).
    - Run a `COUNT(*)` over the same JOIN+WHERE for `total`; add `LIMIT ? OFFSET ?`
      to the rows query. Keep `ORDER BY rank` (see Phase 4 for the tie-break).
    - Update the `GET /api/search` handler to read `agent`/`outcome`/`range`/
      `limit`/`offset` query params (clamp limit/offset like `/api/sessions`).
  - `scripts/wire.ts`: add `total`, `limit`, `offset` to `SearchResponse`.
- Affected: `scripts/routes.ts`, `scripts/wire.ts`.
- Dependencies: OQ1 resolved (range vs. date pair).
- Risks:
  - `OUTCOME_CASE`/`rangePred` reference unqualified `sessions` columns; inside
    the JOIN they must be `s.`-qualified or SQLite will error / mis-resolve.
    `OUTCOME_CASE` is a shared string literal of bare column names — verify it
    resolves unambiguously when only `sessions` carries those columns (it should,
    since `session_search` only exposes `session_id/agent/body`), but test it.
  - Empty `q` must still short-circuit to `{ q, results: [], total: 0, limit,
    offset }` (filters without a query term are out of scope — this is content
    search, not a sessions browser).
- Validation (test-first, `bun test scripts`):
  - Extend `describe("buildSearch (#content-search)")` in `scripts/routes.test.ts`:
    seed rows with differing `agent`, `started_at`, and outcome-driving columns
    (`error_count`, `rate_limit_hit`, `stop_reason`, `ended_at`).
    - filters by agent (only matching-agent hits returned).
    - filters by outcome (e.g. `error_count>0` → only `errored`).
    - filters by range (a row outside the window is excluded; assert the oldest-
      day boundary like the rangePred tests).
    - `total` reflects the filtered count, not the page size; `limit`/`offset`
      page correctly and `total` stays constant across pages.
    - empty `q` returns the zero-shaped body without touching FTS.

### Phase 2 — Client: real term highlighting (delimiters → `<mark>`)

- Objective: render matched terms as highlighted spans instead of literal
  `[ ]` characters. Ships independently of Phase 1.
- Decision (resolves the brief's "keep delimiters vs. offsets"): KEEP the
  server `snippet()` `[ ]` delimiters; parse them on the client into an
  array of `{ text, hit }` segments and render `<mark>` for hits — NO `{@html}`,
  no offset arithmetic (A3). Rationale: FTS5 already computed correct match
  spans; offsets would require shipping a parallel tokenizer to the client and
  re-deriving them. Splitting on delimiters is XSS-safe (Svelte escapes text)
  and trivially testable. (Edge: bodies containing literal `[`/`]` could be
  mis-split; acceptable for a snippet view and noted as a follow-up if it bites.)
- Changes:
  - New tiny pure helper (e.g. `ui/src/lib/format.ts` alongside `compact`/
    `relTime`, or a local function): `splitSnippet(s): { text: string; hit: boolean }[]`.
  - `ContentSearchPanel.svelte`: replace `<p class="snippet">{r.snippet}</p>`
    with an `{#each splitSnippet(r.snippet)}` rendering `<mark>` vs. text.
    Style `mark` with an existing semantic accent var (e.g.
    `var(--accent-from)` / `--cyan`) — NOT a red/green pairing, and rely on the
    `<mark>` boldness/background as a non-color cue too.
- Affected: `ContentSearchPanel.svelte`, `ui/src/lib/format.ts` (or local),
  `ContentSearchPanel.svelte.test.ts`.
- Dependencies: none (works against the current endpoint).
- Risks: the existing panel test asserts the literal `]` leaks through — that
  assertion MUST be rewritten to assert a `<mark>` element with the term and no
  bracket characters. Honor no-`$effect`: `splitSnippet` runs in render /
  `$derived`, never an effect.
- Validation (vitest):
  - `splitSnippet` unit cases: a delimited hit, multiple hits, no delimiter,
    empty string, unbalanced bracket (degrade gracefully to plain text).
  - Panel: a snippet with `[zebrafish]` renders a `<mark>zebrafish</mark>` and
    the rendered text contains NO `[`/`]`.

### Phase 3 — Client: filter UI + pagination on the panel

- Objective: surface the Phase-1 server capabilities in `ContentSearchPanel`,
  mirroring `SessionsTablePanel`'s chips + pager.
- Why after 1 & 2: needs the server contract (Phase 1) and benefits from
  highlighting already landed (Phase 2), but is itself a clean slice.
- Changes:
  - `ui/src/lib/api.ts`: change `searchContent` to take a params object
    `{ q, agent?, outcome?, range?, limit?, offset? }` (build `URLSearchParams`
    like `getSessions`), and widen `SearchResponse` with `total/limit/offset`.
  - `ContentSearchPanel.svelte`: add `agent`/`outcome` `$state` + agent/outcome
    chip rows copied from `SessionsTablePanel` (reuse `agentFilterOptions()` /
    `AGENT_NAMES` from `registry.svelte.ts` and the local `OUTCOMES` list); add
    an `offset` `$state` and a prev/next pager showing `from–to of total`.
    Reset `offset = 0` whenever the query or any filter changes. Keep the
    debounce + nonce guard already in the panel; stay event-driven, no `$effect`.
    Range: per OQ1, bind to the shared `ui.range` (import `ui` from
    `stores.svelte`) so it tracks the Activity `RangeToggle`.
- Affected: `ContentSearchPanel.svelte`, `ui/src/lib/api.ts`,
  `ContentSearchPanel.svelte.test.ts`.
- Dependencies: Phase 1 (server), Phase 2 (highlighting, to avoid a test rebase).
- Risks: chip styling + colorblind rule — reuse `SessionsTablePanel`'s `.chip`/
  `.chip.on` (cyan accent) verbatim; do not invent red/green active states. The
  pager's disabled state mirrors the sessions pager.
- Validation (vitest):
  - selecting an agent/outcome chip re-issues `searchContent` with that param.
  - changing a filter or the query resets `offset` to 0.
  - Next/Prev advance/retreat `offset`; the `from–to of total` label is correct;
    Next disabled on the last page, Prev disabled at offset 0.
  - mock `searchContent` to return the new `{ total, limit, offset }` shape.

### Phase 4 — Ranking polish (explicit, stable ordering)

- Objective: make ordering explicit and stable, and document the bm25 weighting
  decision so it isn't reopened.
- Why last / smallest: low-risk tuning that benefits from the filtered, paginated
  query already existing; isolating it keeps the contract slices clean.
- Decision (A2): the FTS table has a single searchable column, so per-column
  `bm25()` weighting is N/A. Keep `ORDER BY rank` (FTS5's bm25) as primary;
  add a deterministic tie-break `ORDER BY rank, s.started_at DESC, s.session_id`
  so equal-rank hits paginate stably (otherwise OFFSET paging can drop/repeat
  rows across pages). If a recency-blended order is wanted later, that's a
  follow-up, not this slice.
- Changes: `scripts/routes.ts` `buildSearch` ORDER BY; a one-line schema/comment
  note that weighting is N/A for a single-column index.
- Affected: `scripts/routes.ts`, `scripts/routes.test.ts`.
- Dependencies: Phase 1 (the paginated query it stabilizes).
- Risks: minimal; ensure the tie-break columns are `s.`-qualified.
- Validation (`bun test scripts`): two equal-rank hits return in a deterministic
  order, and that order is consistent across an offset boundary (page 1 + page 2
  partition the set with no overlap/gap).

## Follow-ups (explicitly out of scope)

- Custom date-range picker (vs. the shared `RangeToggle`) — only if OQ1 says so.
- Recency-blended / time-decay ranking beyond the tie-break.
- Per-agent snippet length or multi-snippet-per-session (today: one row/session).
- Literal-`[`/`]`-in-body snippet mis-split hardening (switch to a private-use
  delimiter pair in `snippet()` if it ever surfaces).
- The pre-existing "fuse the two parsers" backfill follow-up (unrelated to this
  slice; noted in `session_search.ts`).

## Acceptance criteria

- `GET /api/search` accepts `agent`, `outcome`, `range`, `limit`, `offset` and
  returns `{ q, total, limit, offset, results, error? }`; `total` reflects the
  filtered count and is stable across pages.
- Filters use the exact `rangePred` / `agentFilter`+`pushAgent` / `OUTCOME_CASE`
  helpers — no parallel filtering logic.
- The panel highlights matched terms via `<mark>` with no literal `[`/`]` in the
  rendered DOM, using `{@html}`-free, XSS-safe rendering.
- The panel exposes agent + outcome chips and a prev/next pager matching
  `SessionsTablePanel`; any new status color reuses `--red/--amber/--cyan` plus a
  non-color cue (colorblind rule), with no red/green pairing.
- Ordering is explicit and stable across pagination; the bm25-weighting decision
  is documented as N/A for the single-column index.
- No `$effect` in the panel; `bun test scripts` and `vitest` pass, with tests
  written before each implementation change.

## Risks and dependencies

- Column-qualification (`s.`) inside the JOIN for `OUTCOME_CASE`/`rangePred`/
  tie-break is the single most likely server bug — covered by Phase 1/4 tests.
- The existing panel snippet test depends on leaked delimiters and must be
  rewritten in Phase 2 (don't let it block; it's expected churn).
- OQ1 (range vs. date pair) is the one decision that changes the server
  signature — confirm before Phase 1.

## References

- `scripts/routes.ts` — `buildSearch` (~L291), `GET /api/search` (~L444),
  `GET /api/sessions` (~L411), `rangePred` (L82), `agentFilter`/`pushAgent`
  (L101/L109), `OUTCOME_CASE` (L127), `toMatchQuery` (L276).
- `scripts/session_search.ts`, `scripts/db.ts` (~L248 schema).
- `scripts/wire.ts` (~L110 `SearchResult`/`SearchResponse`).
- `scripts/routes.test.ts` (~L232 `buildSearch` describe),
  `scripts/session_search.test.ts`.
- `ui/src/lib/api.ts` (~L316 types, ~L339 `getSessions`, ~L354 `searchContent`).
- `ui/src/lib/components/panels/ContentSearchPanel.svelte` (+ `.svelte.test.ts`),
  `ui/src/lib/components/panels/SessionsTablePanel.svelte`,
  `ui/src/routes/Activity.svelte`, `ui/src/lib/registry.svelte.ts`,
  `ui/src/app.css` (L23-27 palette).

## Next step

- Confirm OQ1 (shared `RangeToggle`/`ui.range` vs. a date pair), then
  `/workflows:work docs/plans/2026-06-15-feat-fts5-search-production-grade-plan.md`
  starting at Phase 1.
