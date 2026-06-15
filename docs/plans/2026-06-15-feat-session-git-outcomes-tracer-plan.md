# Session Git-Derived Outcomes — Tracer Bullet Plan

- Date: 2026-06-15
- Type: feat
- Status: completed (Q1 → (b) branch-scoped + time-window fallback, confirmed by Scott)
- Scope: per-session "what did this session actually produce" from local git — commits, insertions/deletions, files changed — as a thin end-to-end slice, badged ESTIMATED.

## Overview / Problem statement

Burn answers cost-vs-output on the spend side. The missing half is *output*: for a
given session, what landed in git — commits, lines added/removed, files touched.

The natural heuristic: a session has `cwd`, `git_branch`, `started_at`, `ended_at`
(`scripts/db.ts` `sessions` table). If `cwd` is a git repo, run `git log` over the
`[started_at, ended_at]` window (optionally scoped to `git_branch`) and sum
commits / insertions / deletions / files.

This correlation is inherently FUZZY:
- multiple agents/sessions overlap the same repo + time window
- commits can land *after* `ended_at`
- squash/amend/rebase rewrites history out from under the window
- `cwd` may not be a git repo (or may be gone)

Per the dashboard's strict Fidelity model (`CONTEXT.md`), every such figure is an
estimate and MUST be badged so it never visually passes as a measurement.

### Critical pre-existing fact (do not conflate)

`ProductivityPanel.svelte` + `GET /api/activity/productivity` (`scripts/routes.ts:966`)
ALREADY surface commits / PRs / lines added / removed — but sourced from **Claude
Code OTEL delta-temporality counters** (`claude_code.commit.count`,
`claude_code.lines_of_code.count`), aggregated per-range, Claude-only, and treated
as exact-native counters. This plan's git-derived signal is a **distinct, new,
per-session, all-agent, ESTIMATED** signal. It must not be merged into, badged
like, or routed through the existing Productivity surface. Keep them separate.

## Current-state facts (repository evidence)

- `sessions` table has exactly the inputs the heuristic needs: `cwd`, `git_branch`,
  `started_at`, `ended_at` (`scripts/db.ts:53–79`). Times are stored as TEXT.
- Session detail already has a backend core + route: `GET /api/sessions/:id/details`
  returns `{ session, tools }` (`scripts/routes.ts:492–506`). The page is
  `ui/src/routes/Session.svelte` with tabs (Errors / Messages).
- All current git shelling goes through the **Rust bridge** via
  `run(config.bridgePath, "<cmd>", …)` in `scripts/library_routes.ts` (configure_remote,
  pull_now, etc.). There is **no TypeScript-side git shell-out today** — this slice
  introduces the first one, in the Bun/scripts backend, per Scott's directive.
- Bun subprocess precedent exists and is battle-tested in `scripts/library_bridge.ts`
  `runBridge()`: `Bun.spawn([abs_path], …)` with an **argv array (never a shell
  string)**, a JS-timer watchdog that SIGKILLs on timeout, concurrent stdout+stderr
  drain to avoid pipe deadlock, and a transport-vs-application two-layer error model.
  Reuse this exact shape; do not use `sh -c`.
- Test pattern is "factor the core out of the route, test it directly": e.g.
  `buildSessionErrors(db, id)` (`scripts/routes.ts:151`) is exercised in
  `scripts/routes.test.ts` against an in-memory seeded DB. Mirror this.
- Fidelity-badging convention in the UI (`ui/src/lib/components/panels/BurnPanel.svelte`):
  estimates carry an `est` label and `≈` prefix, colored `var(--amber)`. No red/green
  pairing (Scott is red/green colorblind). `homeDir()` collapses `/Users/<name>` → `~`.
- Localhost-only, ZERO outbound network (`CONTEXT.md`). `git log` is purely local; this
  slice must never invoke a command that touches a remote (`fetch`/`pull`/`ls-remote`).

## Assumptions (plausible, unverified — labeled)

- A1: `started_at`/`ended_at` are ISO-8601 strings comparable to `git log --since/--until`
  inputs. The slice will normalize to a git-accepted timestamp explicitly rather than
  trust raw passthrough.
- A2: Ended sessions are the meaningful target; a still-live session has no stable
  `ended_at`, so its window is open-ended. The tracer targets **ended** sessions only
  and shows nothing (not a zero) for live ones.
- A3: One on-demand `git log` per session is cheap enough that the tracer can compute
  it live (no persistence) — matching the on-demand re-parse posture of the Errors/
  Messages endpoints. Caching is a follow-up, not part of the tracer.
- A4: `git` is on PATH in the dashboard's runtime environment (the Library track already
  relies on a working git for the bridge).

## Open Questions

### Q1 (BLOCKING — #1 decision for Scott) — correlation method

The whole slice's credibility rests on how a commit is attributed to a session. Options:

- **(a) Time-window only**: `git log --since=started_at --until=ended_at` in `cwd`.
  Simplest; over-counts when sessions overlap a repo, misses post-`ended_at` commits.
- **(b) Time-window + branch**: same, plus `git_branch` scoping. Tighter when agents
  work on distinct branches; useless when everyone shares `main` (this repo's default).
- **(c) Time-window + author/committer**: only attributable if the agent sets a distinct
  git identity per session — not evidenced anywhere yet, so likely not viable now.

Recommendation for the tracer: **(b) — time-window scoped to `git_branch` when present,
falling back to (a) when the session has no branch** — and badge the result ESTIMATED
regardless, with the method recorded in the response so the badge tooltip can state
*how* it was derived. This keeps the heuristic honest without pretending overlap is solved.

**Scott: confirm (a) / (b) / (c) / other before implementation. Everything else is settled.**

### Q2 (non-blocking, proceeding with assumption)

Surface as a small panel on `Session.svelte` (a third tab or a header strip) vs a new
panel on the dashboard. Assumption: render on the **session detail page** as a compact
inline strip (not a new tab), since the signal is per-session and the page already loads
session context. Revisit when aggregate/Burn-pairing lands.

## Proposed Plan

Planning depth: **Standard**, executed as one thin tracer slice + an explicitly deferred
follow-up list. The tracer goes through every layer (git shell → core fn → route → api →
UI badge) for ONE session before any aggregation.

### Phase 1 (the tracer): one ended session's git outcome, on demand, badged ESTIMATED

- Objective: Prove the correlation works against a real local repo, end to end, for a
  single session — commits / insertions / deletions / files changed, visibly badged as a
  heuristic estimate, with zero network and zero new persistence.

- Changes (test-first):
  1. New module `scripts/session_outcomes.ts` with a pure, testable core:
     - `buildGitOutcomeArgs(session, method)` → the exact `git log` **argv array**
       (e.g. `["-C", cwd, "log", "--since", ..., "--until", ..., "--numstat",
       "--format=%H", branchArg]`). Pure function, unit-tested for argv shape — never a
       shell string (mirror `library_bridge.ts` M1).
     - `parseGitNumstat(stdout)` → `{ commits, insertions, deletions, filesChanged }`.
       Pure parser over `git log --numstat` output, unit-tested against fixture text.
     - `computeSessionOutcome(db, id, spawn)` → resolves the session row, guards
       (not found → 404 shape; `cwd` absent → `{ applicable:false, reason:"no_cwd" }`;
       live/no `ended_at` → `{ applicable:false, reason:"live" }`), spawns git via an
       injected runner, returns `{ applicable:true, fidelity:"estimated", method,
       commits, insertions, deletions, filesChanged }` or a not-a-repo result. The spawn
       dependency is injected so tests run without a subprocess.
  2. Git runner reusing the `runBridge` shape: `Bun.spawn(["git", ...args])`, argv array,
     JS-timer SIGKILL watchdog (short timeout, ~5s), concurrent stdout/stderr drain,
     transport-vs-application error split. A non-repo `cwd` (`git` exit 128) maps to a
     clean `{ applicable:false, reason:"not_a_repo" }`, NOT a 500.
  3. New route `GET /api/sessions/:id/git-outcome` in `scripts/routes.ts`, delegating to
     `computeSessionOutcome` exactly as `:id/errors` delegates to `buildSessionErrors`.
  4. `getSessionGitOutcome(id)` in `ui/src/lib/api.ts` (mirror `getSessionDetail`).
  5. UI: a compact inline strip in `ui/src/routes/Session.svelte` header area showing
     commits · +insertions · −deletions · files, fetched via `resource()` (no raw
     `$effect`, no `useEffect`-equivalent). Use the BurnPanel badging convention:
     `est`/`≈` in `var(--amber)`, insertions cyan / deletions amber (the
     ProductivityPanel's existing colorblind-safe pos=cyan / neg=amber pairing — never
     red/green). A clear empty/"not a git repo"/"live session" state, not a zero.

- Affected areas:
  - New: `scripts/session_outcomes.ts`, `scripts/session_outcomes.test.ts`,
    test fixture(s) for `--numstat` output.
  - Edit: `scripts/routes.ts` (one route), `ui/src/lib/api.ts` (one fn + type),
    `ui/src/routes/Session.svelte` (inline strip).
  - Untouched (deliberately): `scripts/db.ts` (no schema change — on-demand, no cache),
    `ProductivityPanel.svelte` + `/api/activity/productivity` (distinct signal),
    the Rust bridge (git-outcome reads live in TS).

- Dependencies / sequencing:
  - BLOCKED on Q1 (correlation method) — that choice decides `buildGitOutcomeArgs`.
  - Otherwise self-contained; no schema migration, no new dependency.

- Risks:
  - Over/under-attribution from overlap (inherent — mitigated by the ESTIMATED badge +
    method-in-response, not by code).
  - Timestamp format mismatch between SQLite TEXT and git `--since/--until` (A1) —
    covered by an explicit normalization step + a test.
  - Spawning git on a path the user controls: argv-array only, absolute/quoted `cwd` via
    `-C`, short timeout, no shell. No network commands in the argv whitelist.
  - Performance if a repo's history is huge: bound by `--since` window; acceptable for a
    single on-demand call. Revisit under caching.

- Validation:
  - `bun test scripts/session_outcomes.test.ts`: argv shape; numstat parser on fixture;
    guards (no cwd / live / not-a-repo / not-found); estimated fidelity always set.
  - Manual: open a real ended session whose `cwd` is this repo, confirm the strip shows
    plausible commits/LOC/files and is visibly badged `est`.
  - Confirm a session with a non-repo `cwd` and a live session both render the empty
    state, not a misleading zero.
  - Grep the git argv builder to confirm no `fetch`/`pull`/`ls-remote`/remote-touching
    subcommand can be produced (ZERO-network invariant).

## Deferred follow-ups (explicitly NOT in the tracer)

- Per-day Burn-pairing (cost vs git output on one axis) and any aggregate rollup.
- Persistence/caching of computed outcomes (new column/table on `sessions` or a sidecar)
  — only after the on-demand path proves the heuristic.
- Cross-session overlap disambiguation (attributing a shared-repo commit to one of N
  overlapping sessions).
- Handling post-`ended_at` commits (grace window) and rebase/squash history rewrites.
- A dashboard-level "session outcomes" panel or leaderboard.

## Acceptance criteria

- [ ] `GET /api/sessions/:id/git-outcome` returns `{ applicable, fidelity:"estimated",
      method, commits, insertions, deletions, filesChanged }` for an ended session whose
      `cwd` is a git repo.
- [ ] Returns a clean `applicable:false` (with `reason`) for: no `cwd`, non-repo `cwd`,
      and live/no-`ended_at` sessions — never a 500, never a misleading 0.
- [ ] No outbound network: the git argv can only ever be a local `log` invocation.
- [ ] The figure is visibly badged ESTIMATED in `Session.svelte` using the existing
      amber `est`/`≈` convention; insertions/deletions use cyan/amber (no red/green).
- [ ] Core logic is covered by `bun test` against seeded DB + fixture numstat, with the
      spawn dependency injected (no real subprocess in unit tests).
- [ ] The existing OTEL-sourced Productivity surface is untouched and unconflated.

## Dependencies and risks (summary)

- Hard dependency: Q1 correlation-method decision (blocking).
- Inherent fuzziness is managed by Fidelity badging + method disclosure, not by code.
- Security/network: argv-array spawn, short SIGKILL watchdog, local-`log`-only whitelist.

## References

- `CONTEXT.md` — Fidelity, Burn, localhost-only / zero-network invariants.
- `scripts/db.ts:53–79` — `sessions` columns the heuristic consumes.
- `scripts/library_bridge.ts` `runBridge()` — the Bun.spawn + watchdog + error-model shape to reuse.
- `scripts/routes.ts:151` (`buildSessionErrors`), `:492` (`:id/details`), `:966` (existing OTEL Productivity — distinct signal).
- `ui/src/routes/Session.svelte` — host for the inline outcome strip.
- `ui/src/lib/components/panels/BurnPanel.svelte` — `est`/`≈` amber estimate-badging convention.
- `ui/src/lib/components/panels/ProductivityPanel.svelte` — the pre-existing, NON-git productivity signal to keep separate.

## Next step

Confirm Q1 (correlation method), then `/workflows:work` this plan starting at Phase 1
(test-first: `scripts/session_outcomes.test.ts`).
