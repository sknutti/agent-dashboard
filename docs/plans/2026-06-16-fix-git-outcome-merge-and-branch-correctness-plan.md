# Fix: git-outcome merge under-count, deleted-branch mislabel, and timestamp normalization

- Date: 2026-06-16
- Type: fix
- Status: in review — PR #27 (Phases 1/2/3/4/5a/5b shipped; 5c deferred). Q1=`--no-merges`, Q2=(b) bounded backfill, both confirmed by Scott 2026-06-16. Phase 0 done: merge zero-numstat behavior confirmed empirically; A2 found FALSE (all timestamp writers emit `Z` via `.toISOString()`/ISO-Z transcripts), so Phase 3 is a defensive guard + regression test, not a behavior change.
- Scope: correctness fixes to `scripts/session_outcomes.ts` (the per-session + per-day
  git-outcome heuristic shipped by
  `docs/plans/2026-06-15-feat-session-git-outcomes-tracer-plan.md`), surfaced by a
  correctness review. Three named findings (one CRITICAL, two IMPORTANT) plus three
  optional secondary suggestions. Test-first, zero-network invariant preserved,
  badging stays ESTIMATED, no red/green pairings.

## Overview / Problem statement

The git-outcome heuristic correlates local git history to a session by time window
(optionally branch-scoped) and reports commits / insertions / deletions / files. A
correctness review found three ways it misreports:

1. **Merge commits inflate the commit count with zero LOC/files (CRITICAL).**
   `git log --numstat` emits no numstat rows for a merge commit, so the parser counts
   the `%H` line as `+1 commit` and attaches no figures. A session that merged a
   feature branch reports `N commits, +0, −0, 0 files` — exactly the misleading
   near-zero the original plan's acceptance criteria forbid.
2. **A deleted/unresolvable branch is mislabeled "not a git repo" (IMPORTANT).**
   `git_branch` is passed as a positional revision (`git log <branch> …`). If that
   branch was deleted or never existed locally, git exits 128 with stderr like
   `unknown revision`. The code maps ALL exit-128 to `reason:"not_a_repo"`, so a
   valid repo with a since-deleted branch reports "not a git repo".
3. **Timestamp normalization promised but not implemented (IMPORTANT).** Assumption
   A1 in the original plan says timestamps are normalized to an explicit-offset form
   "rather than trust raw passthrough", but `buildGitOutcomeArgs` passes
   `started_at`/`ended_at` straight through. `git --since/--until` interpret a
   no-offset timestamp as LOCAL time; a no-offset fallback (e.g. from `fileMtime()`)
   would skew the window by the UTC offset. A `Z`-suffixed timestamp is already a
   valid explicit offset (empirically working today) — the real risk is no-offset
   fallbacks, so verify before over-engineering.

Three secondary suggestions (include if cheap): a worded empty state for a genuine
zero-commit window; distinct operability reason codes (`git_not_found` / `timeout` /
`git_failed`); and rename-line handling in `filesChanged`.

## Current-state facts (repository evidence)

- The single shared argv builder is `buildGitOutcomeArgs`
  (`scripts/session_outcomes.ts:47-60`). It already only ever produces a local `log`
  (zero-network invariant, pinned by the test at
  `scripts/session_outcomes.test.ts:79-85`). Today it emits, in order:
  `-C <cwd> log [<branch>] --since <started_at> --until <ended_at> --numstat --format=%H`.
- Two parsers consume that output:
  - `parseGitNumstat` (`scripts/session_outcomes.ts:219-238`) — pre-summed scalars for
    the per-session path. Counts a commit on any 40-hex line (`:226`), attaches
    figures from numstat rows.
  - `parseGitCommits` (`scripts/session_outcomes.ts:252-268`) — per-commit rows for the
    day-level hash dedupe. Same 40-hex-line commit detection (`:256`).
- `computeSessionOutcome` (`:80-112`) maps exit codes: `128 → not_a_repo` (`:107`),
  any other non-zero/null → `git_failed` (`:108`). It does NOT inspect stderr.
- `computeDayOutcome` (`:136-182`) calls the SAME `buildGitOutcomeArgs` and
  `parseGitCommits`, skipping any session whose `exitCode !== 0` (`:157`). So both the
  merge bug and the timestamp bug affect day rollups too, and a deleted-branch session
  silently contributes nothing to a day (acceptable but worth noting).
- `runGitLog` (`:190-213`) is the real runner. It already DISTINGUISHES failure modes
  at the transport layer but flattens them into exit codes: spawn failure →
  `exitCode:127` with stderr `"git could not be launched: …"` (`:195`); timeout →
  `exitCode:null` with stderr `"git log timed out"` (`:208`). `computeSessionOutcome`
  collapses all of these into `git_failed` and never logs stderr.
- Persistence: `git_output_store.ts` writes `computeDayOutcome`'s VERBATIM result into
  `git_output_daily` (`upsertDayOutcome`, `:85-111`), read persisted-first by
  `getDayOutcome` (`:36-38`). **Any fix that changes computed day figures makes already
  -persisted rows stale.** A worker (`refreshGitOutput`, `:61-80`) recomputes touched +
  backfilled days each tick and upserts via `ON CONFLICT … DO UPDATE`, so stale rows
  self-heal over time but not retroactively for untouched past days.
- UI consumers exist and depend on the `reason` contract:
  - `ui/src/lib/components/panels/GitOutcomeStrip.svelte` — per-session strip. Renders
    `o.commits commits · +ins −del · files` when `applicable`, else
    `REASON_LABEL[reason]` (`:17-23`). Current labels: `no_cwd`, `not_a_repo`,
    `git_failed`, `no_window`, `live`. insertions=cyan, deletions=amber, `≈ est` badge
    in amber (`:57-71`) — the colorblind-safe pairing, no red/green.
  - `ui/src/lib/components/panels/DayOutputStrip.svelte` — day rollup strip.
  - `ui/src/lib/api.ts:374-385` — `GitOutcome` type + `getSessionGitOutcome`. `reason`
    is typed as a bare `string`, so adding new reason codes does not break the type.
- Tests to mirror: `scripts/session_outcomes.test.ts` (injected runner, fixture
  numstat, no subprocess), `scripts/git_output_store.test.ts`. The pattern is "factor
  the core out, inject the git runner" — explicitly required by the constraints.
- `git version 2.54.0` is installed locally (supports `--no-merges`, `-m`,
  `--first-parent`).

## Assumptions (plausible, unverified — labeled)

- **A1:** The recommended merge fix is `--no-merges` (honest "lines I produced"
  heuristic), NOT `-m --first-parent` (which would attribute the whole merged diff to
  the merge commit and double-count work already counted on the branch). This is a
  judgment call the review flagged as "decide and document". See Open Question Q1.
- **A2:** No-offset timestamps can actually occur in `sessions.started_at/ended_at`.
  The review names `fileMtime()` as a source. **Must be verified in Phase 0** before
  building normalization — if every stored timestamp is already `Z`-suffixed, the fix
  is a defensive guard + test, not a behavior change.
- **A3:** Changing day figures and accepting that already-persisted `git_output_daily`
  rows go stale (self-healing via the worker on next touch) is acceptable, OR a
  one-time backfill is in scope. See Open Question Q2.
- **A4:** The UI's `REASON_LABEL` map should gain entries for any new reason code; an
  unmapped reason falls back to `"—"` (`GitOutcomeStrip.svelte:44`), which is ugly but
  not broken. New labels must avoid red/green and stay neutral.

## Open Questions

### Q1 (decide before Phase 2 — merge strategy)
`--no-merges` vs `-m --first-parent`. Recommendation: **`--no-merges`**. Rationale: the
badge already reads as "lines this session produced", merge commits produce no new
lines of authored work, and `-m --first-parent` would re-attribute an entire branch's
diff to the merge — inflating insertions/deletions and double-counting against the
branch commits already in the window. `--no-merges` makes the commit count honest
(merges no longer counted as zero-LOC commits) and is the simpler argv change.
**Confirm with Scott before implementing**, and document the choice in the strip
tooltip. (Per the no-conflation constraint, this stays ESTIMATED regardless.)

### Q2 (decide before Phase 4 — persisted-row staleness)
After the merge/timestamp fixes change computed figures, already-persisted
`git_output_daily` rows are stale until the worker next touches that date. Options:
(a) accept self-healing (do nothing — past untouched days stay stale);
(b) add a one-time backfill that recomputes all existing `git_output_daily` rows;
(c) bump a stored `algo_version` and have the worker recompute rows below the current
version. Recommendation: **(b) a bounded one-time recompute** is cheapest and correct
for a localhost single-user dashboard. Confirm scope with Scott.

## Proposed Plan

Planning depth: **Standard.** Test-first throughout. Findings are independent, so each
is its own slice that can land and be validated alone. Phase 0 is a quick empirical
check that right-sizes Phases 2 and 4.

### Phase 0 — Verify assumptions before coding (no production changes)

- Objective: Confirm A2 (no-offset timestamps actually occur) and Q1's merge behavior
  empirically, so the fixes are right-sized rather than speculative.
- Changes: investigation only.
  1. Inspect stored timestamp shapes:
     `rg -n "fileMtime|started_at|ended_at" scripts/*.ts` to find every writer of
     `sessions.started_at/ended_at`, and confirm whether any path can write a
     no-offset string. If a live DB is available, sample
     `SELECT DISTINCT started_at FROM sessions LIMIT 20` and check for offset suffixes.
  2. Confirm merge behavior in a real repo:
     `git log --numstat --format=%H -n 5 <a-merge-sha>` in this repo to observe the
     zero-numstat merge row, and `git log --no-merges …` to confirm it drops merges.
- Affected areas: none (read-only).
- Dependencies: none.
- Risks: if A2 is false (all timestamps already offset-qualified), Phase 4 reduces to a
  defensive guard + regression test rather than a behavior change — note that outcome
  and proceed.
- Validation: a one-paragraph finding recorded in the PR description / commit body
  stating whether no-offset timestamps occur and confirming the merge-row behavior.

### Phase 1 — FINDING 1 (CRITICAL): stop counting merges as zero-LOC commits

- Objective: A session that merged a branch no longer reports `N commits, +0, −0, 0
  files`; merge commits are excluded from the count so the figures are an honest
  "lines produced" estimate.
- Changes (test-first), assuming Q1 = `--no-merges`:
  1. **Test first** in `scripts/session_outcomes.test.ts`:
     - Add a merge fixture: a `git log --no-merges` output is just the non-merge
       commits, so the new test asserts the parser/builder behavior at the argv level.
       Add a `buildGitOutcomeArgs` assertion that the emitted args include
       `"--no-merges"` (both branch and no-branch variants).
     - Add a `computeSessionOutcome` test: with a runner returning output that contains
       ONLY non-merge commits (because `--no-merges` filtered the merge out), the
       reported commit count matches the non-merge commits and figures are non-zero.
       Document in a comment that the merge exclusion happens in git via the new flag,
       not in the parser.
  2. **Implementation** in `buildGitOutcomeArgs` (`scripts/session_outcomes.ts:52-58`):
     add `"--no-merges"` to the args array (after `log`, alongside the other flags).
     This single change fixes BOTH the per-session and per-day paths since both call
     this builder.
  3. Update the zero-network test's `expect(args).toEqual([...])` literals at
     `scripts/session_outcomes.test.ts:64-68` (and the no-branch case `:71-77`) to
     include the new flag, since they pin exact argv shape.
  4. Document the choice: add to the `buildGitOutcomeArgs` doc comment that merges are
     excluded (lines-produced heuristic), and update the `GitOutcomeStrip.svelte`
     tooltip (`:33`) to say the estimate excludes merge commits.
- Affected areas: `scripts/session_outcomes.ts` (builder + comment),
  `scripts/session_outcomes.test.ts` (new merge test + updated argv literals),
  `ui/src/lib/components/panels/GitOutcomeStrip.svelte` (tooltip text only).
- Dependencies: Q1 decision. Note the argv-literal test updates are required or the
  existing tests fail.
- Risks: changing the shared builder shifts day-rollup figures too (intended) — see
  Phase 4 / Q2 for persisted-row staleness.
- Validation: `bun test scripts/session_outcomes.test.ts`; confirm the day rollup tests
  still pass with the new flag (their fixtures contain no merge commits, so figures are
  unchanged). Manual: open a session that merged a branch; the strip shows a non-zero
  estimate, not `+0 −0`.

### Phase 2 — FINDING 2 (IMPORTANT): disambiguate deleted-branch from not-a-repo

- Objective: A valid repo whose `git_branch` was deleted falls back to a time-window
  -only result (`method:"window"`) instead of being mislabeled `not_a_repo`.
- Changes (test-first):
  1. **Test first** in `scripts/session_outcomes.test.ts`, `describe("computeSessionOutcome")`:
     - New test "deleted/unknown branch (exit 128, 'unknown revision') → falls back to
       window, applicable". Runner: first call returns
       `{ exitCode:128, stdout:"", stderr:"fatal: bad revision 'feat/gone'\nunknown revision or path not in the working tree" }`;
       second call (the fallback window-only invocation) returns `NUMSTAT_FIXTURE` with
       `exitCode:0`. Assert the result is `applicable:true, method:"window"` with the
       fixture figures.
     - Keep/strengthen the existing not-a-repo test (`:144-152`): exit 128 with stderr
       containing `"not a git repository"` must STILL map to `reason:"not_a_repo"`.
  2. **Implementation** in `computeSessionOutcome` (`scripts/session_outcomes.ts:104-111`):
     - When `proc.exitCode === 128`, inspect `proc.stderr`:
       - if it matches `/not a git repository/i` → `reason:"not_a_repo"` (unchanged).
       - if it matches `/unknown revision|bad revision/i` AND the original method was
         `branch_window` → rebuild args with `git_branch:null` (forcing `method:"window"`),
         re-run `runGit`, and parse that result. If the fallback itself exits 128/nonzero,
         degrade to `not_a_repo`/`git_failed` accordingly.
       - otherwise (unrecognized 128) → keep `reason:"not_a_repo"` as the conservative
         default, or `git_failed` (decide; recommend `not_a_repo` to preserve current
         behavior for the unknown case).
     - Factor the branch-strip fallback so it does ONE extra `runGit` at most (no loop).
  3. Mirror the fallback in `computeDayOutcome` only if cheap: currently a 128 session
     is skipped entirely (`:157` `exitCode !== 0` → continue). A deleted-branch session
     contributing nothing to a day is acceptable for the rollup; **document this as a
     known minor under-count** rather than adding a second runGit per session in the
     hot day path, UNLESS Scott wants parity. (Default: document, don't change the day
     path.)
- Affected areas: `scripts/session_outcomes.ts` (`computeSessionOutcome` exit-128
  branch), `scripts/session_outcomes.test.ts` (deleted-branch + reinforced not-a-repo
  tests). `GitOutcomeStrip.svelte` needs no new label (it already renders the `window`
  method).
- Dependencies: none (independent of Phase 1).
- Risks: stderr-string matching is git-version-dependent; 2.54.0 emits "unknown
  revision or path not in the working tree". Match both `unknown revision` and
  `bad revision` substrings to be resilient. The fallback adds at most one extra git
  spawn for the (rare) deleted-branch case — bounded by the existing 5s watchdog.
- Validation: `bun test scripts/session_outcomes.test.ts`. Confirm the not-a-repo path
  is unchanged for a true non-repo cwd.

### Phase 3 — FINDING 3 (IMPORTANT): normalize timestamps to explicit offset

- Objective: A no-offset fallback timestamp and a `Z`-suffixed timestamp produce the
  SAME git window, eliminating the UTC-offset skew A1 promised to prevent.
- Changes (test-first):
  1. **Test first** in `scripts/session_outcomes.test.ts`, `describe("buildGitOutcomeArgs")`:
     - "normalizes a no-offset timestamp to an explicit-offset form": pass
       `started_at:"2026-06-01 00:00:00"` (no offset) and assert the emitted `--since`
       value carries an explicit offset (e.g. ends with `Z` or `+NN:NN`).
     - "a `Z`-suffixed timestamp is passed through unchanged / produces the same window":
       assert `2026-06-01T00:00:00Z` and its no-offset local-equivalent normalize to the
       same `--since` string (the regression the finding asks for).
  2. **Implementation**: add a small pure helper `normalizeGitTimestamp(ts: string):
     string` in `scripts/session_outcomes.ts`. Rule: if the string already has an
     explicit offset (`Z` or `±HH:MM` / `±HHMM` suffix), pass through verbatim (do NOT
     reparse — preserves the empirically-working `Z` case). Otherwise, interpret the
     no-offset string and emit an explicit-offset ISO string. Decide the offset policy
     and DOCUMENT it: recommend treating a no-offset stored timestamp as UTC and
     appending `Z` (matches how the rest of the dashboard stores ISO/`Z` times), OR as
     local and appending the machine offset — pick based on Phase 0's finding of where
     no-offset values come from. Apply the helper to both `--since` and `--until` in
     `buildGitOutcomeArgs`.
  3. Update the exact-argv test literals (`:64-68`, `:71-77`) only if the chosen policy
     changes the already-`Z` fixture values — it should NOT (those are pass-through).
- Affected areas: `scripts/session_outcomes.ts` (new helper + two call sites in the
  builder), `scripts/session_outcomes.test.ts` (normalization tests).
- Dependencies: Phase 0's finding on where no-offset timestamps originate (drives the
  UTC-vs-local policy). Independent of Phases 1 and 2 mechanically; can land in any order.
- Risks: choosing the wrong UTC-vs-local interpretation would shift windows by the
  offset — exactly the bug being fixed. This is why Phase 0 verification gates the
  policy. Over-engineering risk: do not reparse already-offset strings (the finding
  explicitly says `Z` works today).
- Validation: `bun test scripts/session_outcomes.test.ts`; the no-offset vs `Z` window
  -equivalence test is the acceptance check.

### Phase 4 — Persisted-row staleness (gated on Q2)

- Objective: Past `git_output_daily` rows reflect the corrected merge/timestamp logic,
  not the old figures.
- Changes: depends on Q2.
  - If **(a) self-heal**: no code; document that past untouched days stay on old figures
    until next touch.
  - If **(b) one-time backfill** (recommended): add a bounded recompute that iterates
    existing `git_output_daily` dates and calls `upsertDayOutcome` for each (reusing the
    `ON CONFLICT DO UPDATE` path at `git_output_store.ts:91-99`). Test it in
    `scripts/git_output_store.test.ts` with an injected runner: seed a row with stale
    figures, run the backfill, assert the row now matches `computeDayOutcome`'s output.
  - If **(c) algo_version**: schema add + worker gate — heavier; only if Scott wants
    durable versioning.
- Affected areas: `scripts/git_output_store.ts`, `scripts/git_output_store.test.ts`,
  possibly the worker that calls `refreshGitOutput`.
- Dependencies: Phases 1 and 3 (the figure-changing fixes) must land first.
- Risks: a backfill spawns git per existing day — bound it (cap + the existing 5s
  watchdog per call) so it can't storm. For a localhost single-user DB this is small.
- Validation: `bun test scripts/git_output_store.test.ts`; spot-check one previously
  -persisted day after backfill.

### Phase 5 — Secondary suggestions (include if cheap, each independent)

- **5a — worded empty state for a genuine zero-commit window.** When `applicable:true
  && commits === 0`, `GitOutcomeStrip.svelte` (`:30-42`) renders `0 commits · +0 · −0 ·
  0 files`. Add a branch: if applicable and `commits === 0`, render a muted
  "no commits in this window" instead of the zero strip. Test in
  `ui/src/lib/components/panels/GitOutcomeStrip.svelte.test.ts` (mirror existing
  cases). Keep it neutral (no red/green). Note `DayOutputStrip.svelte` should get the
  same treatment for consistency.
- **5b — distinct operability reason codes.** `runGitLog` already separates spawn
  failure (`exitCode:127`) from timeout (`exitCode:null`) (`:195`, `:208`).
  In `computeSessionOutcome` (`:108`), branch the non-128 failure: `exitCode === 127`
  (or stderr `/could not be launched/`) → `reason:"git_not_found"`; `exitCode === null`
  (or stderr `/timed out/`) → `reason:"timeout"`; else → `reason:"git_failed"`. Log
  `proc.stderr` server-side (`console.error`, matching `refreshGitOutput`'s logging at
  `git_output_store.ts:76`) so a broken environment is diagnosable. Add the
  `git_not_found` and `timeout` labels to `GitOutcomeStrip.svelte` `REASON_LABEL`
  (`:17-23`) — neutral wording. Test each code with an injected runner returning the
  matching exit/stderr. (A4: `ui/src/lib/api.ts` `reason: string` already permits new
  codes — no type change needed.)
- **5c — rename-line handling in filesChanged.** `git log --numstat` renames appear as
  `old => new` or `dir/{old => new}/f`, which both parsers add verbatim to the file set,
  potentially double-counting. Either normalize to the post-rename path (parse the `=>`
  form) in `parseGitNumstat` (`:234`) and `parseGitCommits` (`:265`), OR document the
  over-count. Recommend a small normalizer with a rename fixture test. Lowest priority;
  drop if the other phases are large.
- Affected areas: `scripts/session_outcomes.ts`, `scripts/session_outcomes.test.ts`,
  `ui/src/lib/components/panels/GitOutcomeStrip.svelte` (+ its test),
  optionally `DayOutputStrip.svelte`.
- Dependencies: 5a/5b/5c independent of each other and of Phases 1-4.
- Validation: `bun test` for the affected backend + UI tests.

## Acceptance criteria

- [x] A session that merged a feature branch no longer reports `N commits, +0, −0, 0
      files`; merge commits are excluded from the commit count (Finding 1). A merge
      regression test exists and passes.
- [x] `buildGitOutcomeArgs` emits the chosen merge flag for BOTH branch and no-branch
      variants; the exact-argv tests are updated and green.
- [x] A valid repo with a since-deleted `git_branch` returns `applicable:true,
      method:"window"` (falls back to time-window only), NOT `reason:"not_a_repo"`
      (Finding 2). A deleted-branch test and a reinforced true-not-a-repo test both pass.
- [x] A no-offset timestamp and its `Z`-suffixed equivalent produce the SAME `--since`/
      `--until` window; already-offset strings (incl. `Z`) are passed through unchanged
      (Finding 3). The equivalence test passes.
- [x] ZERO-network invariant preserved: `buildGitOutcomeArgs` still produces only a
      local `log` (the forbidden-subcommand test still passes).
- [x] All figures remain badged ESTIMATED; no red/green color pairing is introduced.
- [x] No real subprocess in unit tests — every new test injects the git runner.
- [x] (Q2 = backfill) past `git_output_daily` rows reflect the corrected logic via
      `backfillExistingDayOutputs` + the one-shot `scripts/backfill_git_output.ts`, with
      a bounded recompute test.
- [x] A genuine zero-commit window shows a worded empty state ("no commits in this
      window"), not a zero strip; operability failures emit distinct reason codes
      (`git_not_found` / `timeout` / `git_failed`) with server-side stderr logging.
- [ ] DEFERRED (5c): rename-line handling in `filesChanged`. Lowest priority; dropped to
      keep the PR scoped. The existing parser counts `a => b` as one path (no double-count
      within a single window), so the over-count is a rare cross-window edge — logged as a
      follow-up rather than fixed here.

## Dependencies and risks (summary)

- **Q1 (merge strategy)** gates Phase 1 — recommend `--no-merges`; confirm with Scott.
- **Q2 (persisted-row staleness)** gates Phase 4 — recommend a bounded one-time
  backfill; confirm with Scott.
- **Phase 0 verification** right-sizes Phases 1 and 4 (real merge-row behavior) and
  Phase 3 (whether no-offset timestamps actually occur and where they come from).
- The shared `buildGitOutcomeArgs` is touched by Phases 1 and 3, so the exact-argv
  tests must be updated in lockstep or the suite fails.
- stderr-string matching (Phase 2, optional 5b) is git-version-coupled; match multiple
  substrings (`unknown revision`, `bad revision`) for resilience. Local git is 2.54.0.
- Day-rollup parity for deleted branches is intentionally deferred (documented
  under-count) to avoid a second git spawn per session in the hot path, unless Scott
  wants parity.

## References

- `scripts/session_outcomes.ts:47-60` — `buildGitOutcomeArgs` (Findings 1 + 3).
- `scripts/session_outcomes.ts:104-111` — `computeSessionOutcome` exit-code mapping
  (Finding 2, optional 5b).
- `scripts/session_outcomes.ts:219-238`, `:252-268` — the two parsers (optional 5c).
- `scripts/session_outcomes.ts:190-213` — `runGitLog`, already separates spawn-failure
  vs timeout (optional 5b).
- `scripts/session_outcomes.test.ts:58-86`, `:88-162` — argv + computeSessionOutcome
  tests to mirror/update.
- `scripts/git_output_store.ts:36-111` — persisted day store / backfill surface (Q2,
  Phase 4).
- `ui/src/lib/components/panels/GitOutcomeStrip.svelte:17-44` — reason labels + zero
  strip (optional 5a, 5b labels, Phase 1 tooltip).
- `ui/src/lib/api.ts:374-385` — `GitOutcome` type (`reason: string` permits new codes).
- `docs/plans/2026-06-15-feat-session-git-outcomes-tracer-plan.md` — the shipped
  feature this fixes (A1 is the unkept normalization promise).

## Next step

Confirm Q1 (`--no-merges` vs `-m --first-parent`) and Q2 (persisted-row backfill
scope), run Phase 0 verification, then `/work` this plan starting at Phase 1
(test-first: the merge fixture in `scripts/session_outcomes.test.ts`).
