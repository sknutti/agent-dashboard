# Burn–Output Pairing — Tracer Bullet Plan

- Date: 2026-06-15
- Type: feat
- Status: completed. Decisions: Q1=(a) on-demand single-day, Q3=estimated-only, Q4=BurnPanel table — as recommended. **Q2: Scott chose (b) — per-hash dedupe FOLDED INTO the tracer** (not deferred), so the daily figure is a truthful distinct-commit count, not an over-count upper bound. Implemented via parseGitCommits + union-by-hash in computeDayOutcome.
- Scope: put git-derived OUTPUT (commits / insertions / deletions / files) next to
  Burn COST on a per-day axis, so a day reads as "did the spend produce anything."
  Thinnest end-to-end tracer first; efficiency metrics and full persistence deferred.

## Overview / Problem statement

Two halves now exist independently and merged to main:

- **Burn** (Panel 34): cross-agent DAILY spend. `burn_daily(date, agent, tokens,
  cost_usd native, cost_estimated_usd rack-rate, fidelity)` re-derived in
  `scripts/sync_agents.ts`; `GET /api/burn` folds it via the pure `mergeBurnByDate`
  (`scripts/burn.ts`); `BurnPanel.svelte` renders it.
- **Git-derived session outcomes** (PR #18): PER-SESSION, ESTIMATED commits/
  insertions/deletions/filesChanged via `scripts/session_outcomes.ts`. ON-DEMAND,
  NO persistence, exposed at `GET /api/sessions/:id/git-outcome`, badged strip on
  the session detail.

The missing join is the *pairing*: cost and output on one daily axis. The tracer
proves that join for a single real day before any efficiency math or worker-side
persistence.

### Critical pre-existing facts (do not conflate)

- **Native cost and estimated rack-rate are NEVER summed** (`scripts/burn.ts:5-11`,
  CONTEXT.md). Estimated rack-rate is the only cross-agent money axis; native is
  Claude/Pi-only and per-vendor non-comparable.
- The OTEL `ProductivityPanel` (`/api/activity/productivity`) ALREADY shows
  commits/lines — but Claude-only, EXACT OTEL counters. The git-derived signal is
  a DISTINCT, all-agent, ESTIMATED signal. Must stay unconflated — same rule the
  PR #18 plan held.

## Current-state facts (repository evidence)

- `mergeBurnByDate(rows, claudeOtelByDate) → BurnDay[]` is a pure, unit-tested fold
  returning `{ date, tokens, estUsd, nativeUsd }` per day (`scripts/burn.ts:44-92`).
  This is the natural seam to attach a per-day output figure to.
- `GET /api/burn` (`scripts/routes.ts:768-813`) returns `{ range, rows, daily,
  movingAvg, scaleEquivalents, totals }`; `daily` is the per-date series the panel
  iterates. `BurnResponse` typed in `ui/src/lib/api.ts:185-188`.
- `BurnPanel.svelte` renders `d.daily` as a heatmap + a `recent` table
  (`scripts/.../BurnPanel.svelte:67`, `139-147`) with the `est`/`≈` amber +
  `native` cyan badging convention (`:133-137`, `:168-170`). Colorblind-safe
  cividis ramp already in place (`RAMP`, `:59`).
- `computeSessionOutcome(db, id, runGit)` and `parseGitNumstat(stdout)` are pure,
  injectable, and tested (`scripts/session_outcomes.ts`); `parseGitNumstat`
  already dedupes filesChanged by DISTINCT path within its window, and counts a
  commit per 40-hex `%H` line (`:149-168`). filesChanged is per-window-distinct
  but commits/insertions/deletions are raw sums.
- `sessions` table has `cwd, git_branch, started_at, ended_at` and a per-day
  derivation already runs in the sync worker keyed on `DATE(started_at,'localtime')`
  (`scripts/db.ts:53-79`, `scripts/sync_agents.ts:126-141`). burn_daily is
  re-derived per-agent via `selectBurnAgg` + `upsertBurnDaily`, UPSERTed so user
  `driver/evidence` survive. This is the exact precedent for any output rollup.
- `migrateAddColumn(db, table, col, decl)` is the additive-migration helper used
  for every prior column add (`scripts/db.ts:39`, used `:266-282`). Adding a
  cached-outcome column or a sidecar table follows this pattern.
- Zero-network invariant (CONTEXT.md): the git argv can only ever be a local `log`
  (`buildGitOutcomeArgs`, `session_outcomes.ts:47-60`). Any rollup must reuse that
  builder, never a new git subcommand.

## Assumptions (plausible, unverified — labeled)

- A1: The tracer can compute the per-day output figure by iterating the day's
  ENDED sessions and running the existing per-session `git log` for each, summed
  server-side. For ONE day on demand this is acceptable (mirrors the on-demand
  Errors/Messages posture); doing it for every day on every Burn render is NOT,
  which is exactly what Q1 forces a decision on.
- A2: `DATE(started_at,'localtime')` is the correct day key to align output with
  burn_daily, since burn_daily buckets by the same expression
  (`sync_agents.ts:116,127`). A session is attributed to its START day.
- A3: Live sessions (no `ended_at`) are excluded from a day's rollup (open-ended
  window), matching the per-session tracer's `applicable:false reason:"live"`.
- A4: The pairing pairs output against the ESTIMATED rack-rate axis, not native —
  it is the only cross-agent money axis (CONTEXT.md). See Q3.

## Open Questions — Scott must confirm before implementation

These are the four hard design tensions. Recommendation given for each; none
silently chosen.

### Q1 (BLOCKING) — Aggregation & persistence

Pairing needs a per-DAY output figure, but git outcome is per-session, on demand.
Running git for every session on every Burn render is too expensive.

Options:
- (a) **On-demand, single-day only (tracer scope)**: a new endpoint computes one
  day's output by iterating that day's ended sessions and summing the existing
  per-session `git log`. No schema change, no worker change. Bounded cost because
  it is one day, triggered explicitly (e.g. clicking a day), not the whole 30/90d
  grid.
- (b) **Persisted per-session outcome column + worker recompute**: add
  `git_commits/git_insertions/git_deletions/git_files` (+ a `git_outcome_fidelity`
  or computed-at marker) to `sessions` via `migrateAddColumn`, compute in the sync
  worker when a session re-parses, then roll up to a per-day output exactly like
  `selectBurnAgg`. This is the "real" pairing but is a bigger slice and pulls git
  spawning into the worker loop.
- (c) Full sidecar `session_outcomes` table.

**Recommendation: (a) for the tracer, (b) as the very next slice.** The tracer
proves co-visualization for ONE real day with zero schema/worker risk; (b) is the
deferred follow-up that makes it cheap across the whole grid. Do NOT build (b)
inside the tracer — it conflates "prove the join" with "make it cheap," and pulls
git spawning into the sync worker (a new failure surface in the hot loop) before
the visual is validated.

### Q2 (BLOCKING) — Overlap / double-counting

Summing per-session windows over a day double-counts a commit when multiple
sessions on one repo share the time window (same `%H` lands in each).

Options:
- (a) **Accept over-count, louder badge**: keep raw per-session sums, badge the
  daily figure ESTIMATED with an explicit "may over-count overlapping sessions"
  tooltip.
- (b) **Dedupe commits by hash at the day level**: `parseGitNumstat` already keys
  off `%H`; collect the SET of hashes across the day's sessions and count distinct,
  summing each commit's numstat exactly once. This needs the parser to surface
  per-commit rows (it currently returns only summed scalars), so it is a real
  change to `session_outcomes.ts`.

**Recommendation: (b), but staged.** For the tracer, do (a) — raw sum + a loud
"estimated, may over-count" badge — because the tracer's job is co-visualization,
not attribution precision, and (b) requires reshaping the parser's return.
Schedule (b) (per-hash dedupe) as a fast-follow once the pairing visual is
confirmed, since it is the honest daily number. Flag clearly in the artifact that
the tracer's daily output is a deliberate over-count upper bound.

### Q3 (BLOCKING) — Fidelity pairing

Git output is ESTIMATED. Burn cost has native (exact, Claude/Pi) AND estimated
rack-rate (all agents).

**Recommendation: pair output against ESTIMATED rack-rate only.** It is the single
cross-agent money axis per CONTEXT.md and `scripts/burn.ts:5-11`; pairing against
native would (i) silently drop the non-Claude/Pi agents and (ii) imply a precision
the output side does not have. Any derived metric (cost-per-commit, $/100-LOC) is
estimated-over-estimated and MUST carry the `est`/`≈` badge and never render a
native-derived ratio. NO derived efficiency metric in the tracer — pure side-by-side
only; ratios are a labeled follow-up.

### Q4 (non-blocking, proceeding with recommendation) — Visual surface

Options: overlay output on the existing `BurnPanel` (dual-axis cost+output per day)
vs a new dedicated efficiency panel.

**Recommendation: extend `BurnPanel`'s existing `recent` table with output columns
for the tracer** — it is the lowest-risk co-visualization, reuses the panel's
badging/palette, and proves the join without a new panel's layout cost. The
heatmap stays cost-only (its color channel is already spent on tokens; adding a
second encoded variable there is where colorblind-safe encoding gets hard). A
dedicated efficiency panel with cost-per-output is a deferred follow-up once
ratios are in scope. Proceeding with this unless Scott prefers a new panel.

## Proposed Plan

Planning depth: **Standard**, one thin tracer slice + an explicit follow-up list.
The tracer goes through every layer (existing per-session core → day rollup →
route → api → BurnPanel column) for ONE day, on demand, no schema/worker change.
Predicated on Q1=(a), Q2=(a)+loud badge, Q3=estimated-only, Q4=BurnPanel table.

### Phase 1 (tracer): one day's cost paired with summed git output, on demand

- Objective: Render, for a single real day, the day's estimated rack-rate cost
  beside its summed git output (commits/+ins/−del/files), visibly badged ESTIMATED
  and flagged as a possible over-count, with zero schema change and zero new git
  in the sync worker.

- Changes (test-first):
  1. New pure core in `scripts/session_outcomes.ts` (extend, don't fork):
     `computeDayOutcome(db, date, runGit) → { date, sessions: number,
     commits, insertions, deletions, filesChanged, fidelity:"estimated",
     overcount: true }`. It selects ended sessions whose
     `DATE(started_at,'localtime') = date`, reuses `buildGitOutcomeArgs` +
     `parseGitNumstat` per session (the EXISTING zero-network builder), sums the
     scalars, and counts contributing sessions. Injected `runGit` so tests run with
     a stub — no subprocess. Unit-tested against a seeded in-memory DB + fixture
     numstat (mirror `session_outcomes.test.ts`).
  2. New route `GET /api/burn/day/:date/output` in `scripts/routes.ts`, delegating
     to `computeDayOutcome(db, date, runGitLog)` exactly as `:id/git-outcome`
     delegates (`routes.ts:536-539`). Validate `:date` is `YYYY-MM-DD` (mirror the
     guard at `routes.ts:817`). Returns 200 with the body; a day with no ended
     sessions returns `{ sessions: 0, ... }` zeros (a legitimate empty, not a 500).
  3. `getBurnDayOutput(date)` + return type in `ui/src/lib/api.ts` (mirror
     `getSessionGitOutcome` / `getBurn`).
  4. UI: in `BurnPanel.svelte`, make a day in the `recent` table expandable (or add
     a per-row "output" affordance) that lazily fetches that day's output via
     `resource()` keyed on the date (NO raw `$effect` / no `useEffect`-equivalent;
     `resource()` is the established pattern, `BurnPanel.svelte:12`). Show
     `commits · +ins · −del · files` with the `est`/`≈` amber badge and an
     "estimated — may over-count overlapping sessions" tooltip. insertions cyan /
     deletions amber (NOT red/green — Scott is colorblind; matches the per-session
     strip convention). The est cost column already present is the pairing partner.

- Affected areas:
  - Edit: `scripts/session_outcomes.ts` (+`computeDayOutcome`),
    `scripts/session_outcomes.test.ts` (+day-rollup cases),
    `scripts/routes.ts` (one route), `ui/src/lib/api.ts` (one fn + type),
    `ui/src/lib/components/panels/BurnPanel.svelte` (lazy per-day output cell).
  - Untouched (deliberately): `scripts/db.ts` (NO schema change — on-demand),
    `scripts/sync_agents.ts` (NO git in the worker yet — that is the Q1=(b)
    follow-up), `scripts/burn.ts` `mergeBurnByDate` (cost fold unchanged — output
    is fetched separately, not merged into the fold), `ProductivityPanel` +
    `/api/activity/productivity` (distinct OTEL signal), the Rust bridge.

- Dependencies / sequencing:
  - BLOCKED on Q1–Q3 (they decide the endpoint shape and honesty story); Q4
    proceeding with the BurnPanel-table recommendation.
  - Otherwise self-contained: reuses existing zero-network git builder + parser; no
    migration, no new dependency, no worker change.

- Risks:
  - Over-count from overlapping sessions (Q2) — managed by the ESTIMATED badge +
    explicit over-count tooltip in the tracer, dedupe deferred to a fast-follow.
  - Fanning N `git log` calls for a busy day's sessions on one click — bounded
    (one day, explicit trigger), but if a day has many ended sessions across big
    repos it could be slow. Acceptable for on-demand single-day; the Q1=(b)
    persisted rollup removes it. Reuse the existing 5s SIGKILL watchdog per call
    (`runGitLog`, `session_outcomes.ts:120-143`).
  - Pairing the wrong cost axis — pinned to estimated rack-rate (Q3); no native
    ratio rendered.
  - Visual confusion if output looks exact next to a native cost — mitigated by NOT
    encoding output in the heatmap and badging every output figure estimated.

- Validation:
  - `bun test scripts/session_outcomes.test.ts`: `computeDayOutcome` sums across a
    seeded multi-session day; excludes live (no `ended_at`) sessions; returns zeros
    for an empty day; sets `fidelity:"estimated"` + `overcount:true`; injected
    `runGit` (no subprocess).
  - vitest on the BurnPanel output cell: renders the estimated badge, colorblind-
    safe ins/del colors, and the over-count tooltip; uses `resource()` not
    `$effect`.
  - Manual: pick a real day this repo worked, expand it in Burn, confirm cost (est)
    and plausible commits/LOC/files sit side by side, output visibly badged est.
  - Grep the day-rollup path to confirm it produces ONLY the existing local-`log`
    argv (zero-network invariant) — no new git subcommand introduced.

## Deferred follow-ups (explicitly NOT in the tracer)

- **Q1=(b) persisted per-session outcome + worker rollup**: `migrateAddColumn` the
  outcome scalars onto `sessions`, compute in `sync_agents.ts` when a session
  re-parses, roll up to a per-day output via a `selectBurnAgg`-style query so the
  WHOLE 30/90d grid shows output cheaply. This is the next slice after the visual
  is confirmed.
- **Q2=(b) per-hash dedupe**: reshape `parseGitNumstat` to surface per-commit rows,
  collect the day's distinct `%H` set, count each commit's numstat once — the
  honest (non-over-count) daily figure.
- Cost-per-output / $-per-100-LOC efficiency metrics (estimated-over-estimated,
  badged), and a dedicated efficiency panel (Q4 alternative).
- Encoding output as a second heatmap channel (only if a colorblind-safe dual
  encoding is designed).
- Post-`ended_at` grace window and rebase/squash history handling (inherited from
  the per-session tracer's deferred list).

## Acceptance criteria

- [ ] `GET /api/burn/day/:date/output` returns `{ date, sessions, commits,
      insertions, deletions, filesChanged, fidelity:"estimated", overcount:true }`
      for a valid `YYYY-MM-DD`, summed over that day's ENDED sessions.
- [ ] A day with no ended sessions returns zeros (sessions:0), never a 500.
- [ ] Output is paired against the ESTIMATED rack-rate cost only; no native-derived
      ratio is rendered anywhere.
- [ ] Output is visibly badged ESTIMATED in `BurnPanel` with an explicit
      "may over-count overlapping sessions" disclosure; ins/del use cyan/amber
      (no red/green).
- [ ] No schema change, no git added to the sync worker, `mergeBurnByDate` unchanged.
- [ ] Zero outbound network: the day rollup produces only the existing local `log`
      argv.
- [ ] Core covered by `bun test` (seeded DB + fixture numstat, injected runner) and
      the panel cell by vitest; no raw `$effect` — `resource()` only.
- [ ] OTEL Productivity surface untouched and unconflated.

## Dependencies and risks (summary)

- Hard dependency: Q1–Q3 decisions (blocking); Q4 proceeding on recommendation.
- Over-count and on-demand fan-out are the two managed risks — both retired by the
  named follow-ups (per-hash dedupe; persisted worker rollup).
- Security/network: reuses the argv-array, SIGKILL-watchdog, local-`log`-only path.

## References

- `CONTEXT.md` — Fidelity, Burn, Native vs Estimated (never summed), zero-network.
- `scripts/burn.ts:44-92` — `mergeBurnByDate` fold (the cost seam, kept unchanged).
- `scripts/routes.ts:768-813` (`/api/burn`), `:536-539` (`:id/git-outcome` delegation
  pattern), `:815-827` (date-guard + UPSERT precedent).
- `scripts/session_outcomes.ts` — per-session core + zero-network argv builder +
  parser to reuse for the day rollup.
- `scripts/sync_agents.ts:126-141` — `selectBurnAgg`/`upsertBurnDaily`, the
  per-day derivation precedent for the Q1=(b) follow-up.
- `scripts/db.ts:39` (`migrateAddColumn`), `:53-79` (sessions), `:118-128`
  (burn_daily) — schema seams for the persisted follow-up.
- `ui/src/lib/components/panels/BurnPanel.svelte` — host panel + `est`/`≈` amber /
  native cyan / cividis-ramp colorblind-safe convention.
- `docs/plans/2026-06-15-feat-session-git-outcomes-tracer-plan.md` — the per-session
  tracer this builds on (and its "do not conflate with OTEL Productivity" rule).

## Next step

Confirm Q1 (persistence), Q2 (over-count honesty), Q3 (fidelity axis) — Q4 has a
recommendation to accept or override — then `/workflows:work` this plan starting at
Phase 1 (test-first: extend `scripts/session_outcomes.test.ts` with the day-rollup
cases before `computeDayOutcome`).
