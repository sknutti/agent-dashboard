# Persisted git-output rollup — make git output cheap across the whole Burn grid

- date: 2026-06-15
- type: feat
- branch (current work lives here): `feat/burn-output-pairing` (PR #19, not yet merged)
- follow-up to: Burn-output pairing (Q1=(b)); the on-demand single-day-per-click compute shipped in PR #18 + #19
- planning depth: comprehensive (new persisted table + git enters the sync worker — both are new failure surfaces)
- status: COMPLETED. Locked decisions: Q-A=(c) date-only git_output_daily storing computeDayOutcome's verbatim deduped output; Q-B=date-only/agent-agnostic; Q-C=separate /api/burn/output endpoint (mergeBurnByDate untouched); Q-D=on-demand day endpoint kept as persisted-first fallback; Q-E=bounded backfill (CC_GIT_OUTPUT_BACKFILL, default 5); A3=touched-dates Set per tick. Phases 0–4 shipped test-first; the dedupe regression guard asserts commits==COUNT(DISTINCT hash). Verified --once: worker rolled up real days; grid hydrates from one fetch. Full gate green (481 backend + UI).

## Problem

Today git-derived output is computed **on demand, one day per click**:
`GET /api/burn/day/:date/output` → `computeDayOutcome(db, date, runGitLog)` spawns `git log`
once per ended session in that day, every time a row is expanded
(`BurnPanel.svelte` `openDay` → `DayOutputStrip`).

The goal is to make git output **cheap to show across the WHOLE 30/90-day grid** (and
eventually every panel) — i.e. read it from a persisted rollup instead of fanning git
spawns out on every interaction. The grid is up to 90 cells; on-demand compute for the
whole grid would be 90 days × N-sessions git spawns, unacceptable on the read path.

## The #1 decision — dedupe preservation (DO NOT silently pick)

`computeDayOutcome` (scripts/session_outcomes.ts:136) is correct **because** it unions
commits **by hash** across the day's overlapping sessions and counts each once — that is
Scott's Q2=(b) call. The persisted rollup must not silently undo it.

Three shapes preserve (or knowingly abandon) dedupe:

- **(a) per-session scalars, sum per day.** Persist `commits/insertions/deletions/files`
  on the `sessions` row; the daily figure is a `SUM`. Cheapest, smallest schema —
  but `SUM` **re-introduces the cross-session over-count** Q2=(b) removed. Only acceptable
  if paired with a "this is a raw sum, not deduped" fidelity note, which contradicts the
  pairing UI we just shipped (which advertises `deduped:true`). **Not recommended.**

- **(b) per-session → commit-hash sidecar.** Persist one row per `(session_id, date,
  commit_hash, insertions, deletions, files?)`. A daily rollup can then
  `COUNT(DISTINCT hash)` and sum per distinct commit — dedupe preserved at read time,
  and it composes to any future grouping (per-repo, per-week). Cost: largest schema +
  storage (one row per commit per session), more worker writes, and `files` is a set so
  it needs either a child table or a JSON/secondary aggregation to dedupe paths across
  hashes. Heavier than the slice needs right now.

- **(c) persist the already-deduped per-DAY result.** A `burn_daily`-style output table
  keyed by **date only** holding the deduped `commits/insertions/deletions/filesChanged
  + fidelity`, recomputed by the worker whenever any session in that day changes. Cheap
  reads, dedupe preserved (we store the output of the deduping function verbatim), tiny
  schema. Costs: the recompute runs in the worker, and the key can't be per-agent
  (see below).

### The per-day-vs-per-agent key sub-decision

`burn_daily` is keyed `(date, agent)`. But hash-dedupe is **repo-wide / cross-session**,
and a single commit can sit inside the windows of sessions from different agents. There
is **no well-defined way to split deduped commits per agent** — attributing a shared
commit to one agent is arbitrary. So the deduped output table must be **date-only,
agent-agnostic**, which deliberately does NOT line up with `burn_daily`'s `(date, agent)`
key.

This is fine and honest: the output rollup answers "what did this DAY produce" (a
repo-wide, all-agents figure), while `burn_daily` answers "what did this (day, agent)
cost". The pairing UI already pairs a day's git output with the day's **total** est cost
(`d.daily` is per-date after the `mergeBurnByDate` fold), so a date-only output rollup is
exactly the right grain for the existing consumer.

### Recommendation

**Ship (c): a date-only `git_output_daily` table holding the verbatim output of
`computeDayOutcome`.** It is the thinnest shape that preserves Q2=(b) dedupe with cheap
whole-grid reads, matches the existing per-date pairing consumer, and sidesteps the
ill-defined per-agent split. Keep **(b) as a documented follow-up** for the day we want
per-repo or per-agent attribution of output (it is the only shape that can answer those
without lying), and explicitly **reject (a)** in the table comment so a later reader
doesn't "optimize" us back into the over-count.

## Current state

### Facts (from the repo)
- `computeDayOutcome(db, date, runGit)` already produces the exact deduped `DayOutcome`
  shape we'd persist: `{date, sessions, commits, insertions, deletions, filesChanged,
  fidelity:"estimated", deduped:true}` (scripts/session_outcomes.ts:119-182). It selects
  the day's ended sessions by `DATE(started_at,'localtime') = ?` — the **same local-day
  key** `burn_daily`/`token_usage` use (sync_agents.ts:116, 127).
- The git runner is injected; `runGitLog` is the real one with a **5s SIGKILL watchdog**,
  argv-array (never shell), stdin closed, local `log` only — zero-network invariant holds
  (scripts/session_outcomes.ts:184-213). Per-session loop already does
  `if (proc.exitCode !== 0) continue;` so a bad repo contributes nothing
  (session_outcomes.ts:157).
- The worker (`scripts/sync_agents.ts`) owns ALL DB writes (ADR-0001). Rollups are
  re-derived **only when `synced > 0`** (`syncAdapter` → `rederiveRollups`,
  lines 334-359) inside a `db.transaction`. The tracer **deliberately kept git OUT of the
  worker** — this slice changes that, the central new risk.
- `rederiveRollups` runs **per-agent** (clears+rebuilds token_usage, upserts burn_daily
  for that agent's dates). A date-only git rollup does NOT fit this per-agent loop and
  must be driven separately (see Phase 2).
- Migration pattern: `migrateAddColumn(db, table, col, type)` for additive columns
  (scripts/db.ts:39); new tables go in the `SCHEMA` `CREATE TABLE IF NOT EXISTS` block
  (db.ts:51) and are created idempotently by `initSchema` (db.ts:260).
- Read path: `GET /api/burn` (routes.ts:768) folds `burn_daily` rows via the pure
  `mergeBurnByDate` (scripts/burn.ts:44) into per-date `daily[]` and returns
  `BurnResponse`. The on-demand day endpoint is routes.ts:836.
- UI: `BurnPanel.svelte` renders `d.daily` heatmap cells + a recent-rows table;
  `DayOutputStrip date={r.date}` lazily calls `getBurnDayOutput(date)`
  (ui/src/lib/api.ts:418). `DayOutcome` type is mirrored in api.ts:408.
- Tests: `scripts/session_outcomes.test.ts` and `scripts/burn.test.ts` (bun test) cover
  the pure helpers with a **stubbed GitRunner** (no subprocess). `DayOutputStrip` has a
  vitest test. Palette: BurnPanel uses an Okabe-Ito-safe blue→yellow ramp (no red/green).

### Assumptions (labeled — verify before/while building)
- A1: The whole-grid consumer wants **per-date** output (matches `d.daily`), not
  per-(date,agent). Backed by the existing pairing UI grain. **High confidence.**
- A2: Recomputing a day's output only when one of its sessions changed is sufficient
  freshness; we don't need real-time output for live (un-ended) sessions (consistent with
  `computeDayOutcome` already filtering `ended_at IS NOT NULL`).
- A3: The set of "days touched this tick" is derivable from which sessions re-parsed.
  The current worker tracks a `synced` count but not which dates changed — Phase 2 adds
  that tracking. **Medium confidence; this is the main new worker plumbing.**
- A4: Per-day git fan-out in the worker, bounded to changed days only and reusing the 5s
  watchdog + per-session try/catch, stays well under the 120s tick budget for a normal
  history. Worst case (huge backfill on first boot) is the risk to bound in Phase 2.

### Open questions (with recommendations)
- Q-A (the #1 decision): dedupe-preservation schema → **(c) date-only `git_output_daily`**.
  Reject (a) in a comment; defer (b) as the per-attribution follow-up.
- Q-B: per-day vs per-agent key → **date-only**, because repo-wide dedupe makes per-agent
  attribution ill-defined.
- Q-C: read path — extend `/api/burn` inline vs separate cheap endpoint?
  **Recommendation: separate cheap endpoint** `GET /api/burn/output?range=` returning a
  date→output map, joined client-side in `BurnPanel`. Rationale: keeps `mergeBurnByDate`
  (the most failure-sensitive arithmetic, ADR-0002) untouched and cost-only; keeps the
  output axis (estimated, all-agents, date-only) cleanly separate from the per-agent cost
  fold; lets the grid hydrate output independently. Inline extension would entangle a
  date-only all-agents figure into a fold that is explicitly per-agent and agent-filtered.
- Q-D: should the on-demand `GET /api/burn/day/:date/output` stay? **Yes — keep it as the
  freshness fallback / cache-miss path.** Phase 3 makes it read the persisted row first
  and fall back to live `computeDayOutcome` when absent (e.g. a day not yet recomputed).
- Q-E: do we backfill all historical days on first boot, or fill lazily? **Recommendation:
  lazy + bounded backfill** — recompute changed days each tick, plus a small capped
  backfill of the N most-recent missing days per tick, so a 90-day history fills in over a
  few ticks instead of one giant git storm. Bound is configurable, default small.

## Proposed plan (thin, incremental vertical slices)

### Phase 0 — Decision lock-in + schema (no behavior change)
- Objective: get the Q-A/Q-B decision committed in code/comments and the table in place,
  so nothing downstream silently re-introduces over-count.
- Changes:
  - Add `git_output_daily` to the `SCHEMA` block in scripts/db.ts (CREATE TABLE IF NOT
    EXISTS), keyed `PRIMARY KEY (date)`: `date TEXT, sessions INTEGER, commits INTEGER,
    insertions INTEGER, deletions INTEGER, files_changed INTEGER,
    fidelity TEXT NOT NULL DEFAULT 'estimated', deduped INTEGER NOT NULL DEFAULT 1,
    computed_at TEXT`. Table comment states: date-only/all-agents BY DESIGN (repo-wide
    hash dedupe makes per-agent attribution ill-defined); **never** sum per-session
    scalars to derive this — that would undo the Q2=(b) dedupe; (b) hash-sidecar is the
    documented path if per-attribution is ever needed.
- Affected: scripts/db.ts (SCHEMA + a one-line note in `initSchema` if any later index is
  wanted; none needed at this size).
- Dependencies: none.
- Risks: none (additive, idempotent).
- Validation: bun test that `initSchema` on a fresh in-memory DB creates `git_output_daily`
  with the expected columns (PRAGMA table_info); re-running `initSchema` is a no-op.

### Phase 1 — Persist helper + write path (worker still not calling it)
- Objective: a pure, injected-git function that computes AND upserts one day's deduped
  output, unit-tested with a stub runner — before it ever runs in the worker.
- Changes:
  - In scripts/session_outcomes.ts (or a thin new `git_output_store.ts` that imports
    `computeDayOutcome`), add `upsertDayOutcome(db, date, runGit)`: call the existing
    `computeDayOutcome`, then `INSERT … ON CONFLICT(date) DO UPDATE` into
    `git_output_daily` (mirrors `upsertBurnDaily`), stamping `computed_at`.
  - Keep `computeDayOutcome` unchanged — we persist its verbatim output, so dedupe is
    provably preserved (we store exactly what the deduper returned).
- Affected: scripts/session_outcomes.ts (+ its prepared-statement style), no route/UI yet.
- Dependencies: Phase 0 table.
- Risks: low; pure function with injected git.
- Validation: bun test with a stub `GitRunner` returning overlapping same-hash commits
  across two sessions of one day → assert the persisted row has `commits =
  DISTINCT(hash)`, not the raw sum (this is the **regression guard for the #1 decision** —
  it fails loudly if anyone later switches to per-session scalar sums).

### Phase 2 — Wire into the sync worker, bounded
- Objective: recompute changed days' output in the worker without destabilizing the tick.
- Changes (scripts/sync_agents.ts):
  - Track the **set of local dates touched** this tick. Cheapest: in `parseAndWrite`,
    after `writeSession`, derive the session's local start-date and add it to a per-tick
    `Set<string>` (the worker already has `agg.meta.startedAt`; bucket with the same
    `DATE(...,'localtime')` rule — compute via SQL `SELECT DATE(?, 'localtime')` or a
    shared helper to guarantee it matches `selectBurnAgg`).
  - After adapters finish (once per tick, NOT per-agent — this rollup is agent-agnostic),
    for each touched date call `upsertDayOutcome(db, date, runGitLog)` inside its **own
    try/catch** so one bad repo/day can't stall the tick. Reuse the existing 5s watchdog
    (already inside `runGitLog`) — no new timeout code.
  - Optional bounded backfill (Q-E): also pick up to `CC_GIT_OUTPUT_BACKFILL` (default ~5)
    most-recent dates present in `sessions` but missing from `git_output_daily`, so
    history fills over a few ticks rather than one git storm. Skip entirely when the day's
    sessions have no valid repo cwd (the per-session `exitCode !== 0 → continue` already
    handles non-repos, contributing nothing).
  - Guard: only do any of this when `synced > 0` for the tick (reuse the existing gate),
    so a quiet DB spawns zero git.
- Affected: scripts/sync_agents.ts (tick loop, `parseAndWrite`, new touched-dates set).
- Dependencies: Phases 0-1.
- Risks: **git now runs in the hot sync loop** (the deliberate tracer boundary changes).
  Bounding: changed-days-only + capped backfill + per-day try/catch + the existing 5s
  watchdog + reentrancy guard (`tickRunning`) already prevents overlapping ticks. Worst
  case is first-boot backfill — capped per tick to make it incremental.
- Validation: a worker-level test (or a `--once` integration run against a temp DB +
  temp git repo) asserting: a changed day produces a `git_output_daily` row; a tick with
  `synced === 0` spawns no git; a day whose session cwd is not a repo writes a zeros/empty
  row without throwing; injecting a hanging git is killed by the 5s watchdog and the tick
  still completes. Add a heartbeat metric field (e.g. `gitDays`) so the worker's git work
  is observable in `activities`.

### Phase 3 — Cheap read endpoint + on-demand fallback
- Objective: serve the whole grid's output from the persisted table in one query.
- Changes (scripts/routes.ts):
  - Add `GET /api/burn/output?range=30d|90d` → `SELECT date, commits, insertions,
    deletions, files_changed, sessions, fidelity FROM git_output_daily WHERE
    rangePred(range,'date')` returning a `date → DayOutcome` map (reuse existing
    `rangePred`). No agent param (date-only by design — document it in the route comment).
  - Repoint `GET /api/burn/day/:date/output` to **read the persisted row first**, falling
    back to live `computeDayOutcome(db, date, runGitLog)` on a miss (Q-D), so a not-yet-
    recomputed day still resolves and the existing `DayOutputStrip` keeps working.
  - Leave `/api/burn` and `mergeBurnByDate` **untouched** (Q-C).
- Affected: scripts/routes.ts.
- Dependencies: Phases 0-2 (table populated).
- Risks: low. New read is index-light at ≤90 rows; a `date` PK suffices for range scans.
- Validation: bun/route test seeding `git_output_daily` and asserting `/api/burn/output`
  returns the deduped figures for the range; assert the day endpoint falls back to live
  compute when the row is absent.

### Phase 4 — Hydrate the grid in the UI (cheap, no per-click fan-out)
- Objective: show output across the whole grid from one fetch, keeping per-day pairing.
- Changes:
  - api.ts: add `getBurnOutput(range)` → `Record<string, DayOutcome>` (reuse `DayOutcome`).
  - BurnPanel.svelte: fetch the output map once per range (alongside `getBurn`), key it by
    date, and show a compact output signal on/under each grid cell or recent row
    (e.g. commits + net LOC), all badged **estimated** (existing `.est` styling, Okabe-Ito
    palette — no red/green). `DayOutputStrip` stays as the expanded detail but now reads
    the same persisted data path (no new git spawn on click). No `$effect`/`use resource`
    for the new fetch — follow the existing `getBurn` data-load pattern already in the
    component.
  - Keep the OTEL ProductivityPanel distinct — this output axis is estimated/all-agents,
    never presented as a measured counter.
- Affected: ui/src/lib/api.ts, ui/src/lib/components/panels/BurnPanel.svelte, and the
  DayOutputStrip test if the data source changes.
- Dependencies: Phase 3.
- Risks: visual density on the heatmap; mitigate by surfacing the output figure in the
  recent-rows table first (cheapest change) and treating per-cell output as optional.
- Validation: vitest on BurnPanel/DayOutputStrip asserting the grid renders persisted
  output without per-row network calls and that figures carry the estimated badge.

## Acceptance criteria
- A `git_output_daily` table exists, keyed by `date` only, populated by the worker.
- The persisted daily figures equal `computeDayOutcome`'s deduped output — a regression
  test proves `commits == COUNT(DISTINCT hash)`, NOT the per-session sum (the Q2=(b)
  guard).
- The whole 30/90-day grid shows git output from a **single** read query, no per-click
  git fan-out for the grid.
- A quiet tick (`synced === 0`) spawns zero git; a bad/non-repo day contributes
  zeros without throwing; a hanging git is killed by the 5s watchdog and the tick still
  completes and emits a heartbeat.
- `/api/burn` and `mergeBurnByDate` are unchanged; cost arithmetic (ADR-0002) is untouched.
- Every output figure is badged `estimated`; no red/green; distinct from ProductivityPanel.
- Zero-network preserved: only local `git log` via the existing argv builder.

## Dependencies and risks
- Highest risk: **git enters the worker tick**. Bounded by changed-days-only recompute,
  capped backfill, per-day try/catch, the existing 5s SIGKILL watchdog, and the
  `tickRunning` reentrancy guard. Observability via a heartbeat `gitDays` field.
- Schema correctness risk: anyone "optimizing" to per-session scalar sums silently undoes
  Q2=(b). Mitigated by the table comment + the Phase 1 regression test.
- Freshness: live (un-ended) sessions are excluded by design; the on-demand fallback
  covers a day not yet recomputed.
- Branch state: this builds on `feat/burn-output-pairing` (PR #19), not yet merged —
  sequence after #19 lands or stack on top of it.

## Explicit follow-ups (out of scope for this slice)
- Per-repo / per-agent attribution of output → requires the **(b) hash-sidecar** schema.
- Output on panels beyond Burn ("eventually every panel") — once the date→output map is
  cheap, other panels can consume it; not built here.
- Per-message-day precision and live-session output.

## References
- scripts/session_outcomes.ts — `computeDayOutcome` (119-182), `runGitLog` (184-213),
  `parseGitCommits` (252-268).
- scripts/sync_agents.ts — `syncAdapter`/`rederiveRollups` (316-359), `parseAndWrite`
  (258-298), tick loop (368-410).
- scripts/db.ts — `SCHEMA` (51), `migrateAddColumn` (39), `burn_daily` (118-128),
  `initSchema` (260).
- scripts/burn.ts — `mergeBurnByDate` (44, leave untouched).
- scripts/routes.ts — `/api/burn` (768), `/api/burn/day/:date/output` (836),
  `rangePred` (83).
- ui/src/lib/api.ts — `DayOutcome` + `getBurnDayOutput` (408-419).
- ui/src/lib/components/panels/BurnPanel.svelte — grid + recent rows + `DayOutputStrip`
  wiring (60-164).

## Next step
Review this plan, in particular the locked Q-A/Q-B/Q-C recommendations, then
`/workflows:work docs/plans/2026-06-15-feat-persisted-git-output-rollup-plan.md`
starting at Phase 0.
