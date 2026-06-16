// Git-derived session outcomes (tracer) — "what did this session actually produce?"
// Correlates local git history to a session by TIME WINDOW (scoped to the session's
// git_branch when present), summing commits / insertions / deletions / files changed.
//
// This attribution is inherently FUZZY (overlapping sessions on one repo, commits
// landing after a session ends, history rewrites) so every figure is ESTIMATED per
// the dashboard's Fidelity model (CONTEXT.md) and must be badged so it never passes
// as a measurement. Pure helpers here (parser + argv builder) are unit-tested; the
// git spawn is injected into computeSessionOutcome so tests run with no subprocess.
//
// Distinct from the OTEL-sourced ProductivityPanel (Claude-only, exact counters) —
// this is per-session, all-agent, and estimated. Do not conflate the two.

import type { Database } from "bun:sqlite";

/** Injected git runner — the route supplies the real Bun.spawn-backed one; tests
 *  supply a stub so no subprocess runs. Returns the finished-process facts. */
export type GitRunner = (
  args: string[],
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** The git-output figures for one session. All are heuristic estimates. */
export interface GitOutcomeFigures {
  commits: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

/** How the window was correlated — recorded in the response so the UI badge can
 *  disclose *how* the estimate was derived (branch-scoped vs. time-window-only). */
export type CorrelationMethod = "branch_window" | "window";

/** The session inputs the heuristic consumes (a subset of the `sessions` row). */
export interface SessionGitInput {
  cwd: string;
  git_branch: string | null;
  started_at: string;
  ended_at: string;
}

/** Normalize a stored timestamp to a form `git --since/--until` can't misread.
 *  git interprets a timestamp WITHOUT an explicit offset as machine-LOCAL time, which
 *  would skew the window by the UTC offset. If the string already carries an offset
 *  (`Z` or `±HH:MM`/`±HHMM`) it is passed through verbatim — `Z` works today and must
 *  not be reparsed. A no-offset string has its wall-clock treated AS UTC (separator
 *  normalized, `Z` appended) — NOT date-parsed, which would apply the local offset and
 *  re-introduce the very skew this prevents. Defensive: every known writer already
 *  emits `Z` (`.toISOString()` / ISO-Z transcripts), so this is a guard, not a
 *  behavior change for existing data. */
export function normalizeGitTimestamp(ts: string): string {
  const t = ts.trim();
  if (/([Zz]|[+-]\d{2}:?\d{2})$/.test(t)) return t;
  return `${t.replace(" ", "T")}Z`;
}

/** Build the `git log` argv array for a session's outcome window (Q1: scope to
 *  git_branch when present, else time-window only). ALWAYS a local `log` — the only
 *  subcommand this can ever produce, preserving the zero-network invariant. Argv
 *  array, never a shell string (mirrors library_bridge M1). `--no-merges` excludes
 *  merge commits, which emit no numstat rows and would otherwise be counted as
 *  zero-LOC commits (an "honest lines produced" estimate). Timestamps are normalized
 *  to an explicit offset so git doesn't read them as machine-local. */
export function buildGitOutcomeArgs(
  session: SessionGitInput,
): { args: string[]; method: CorrelationMethod } {
  const branch = session.git_branch?.trim() || null;
  const method: CorrelationMethod = branch ? "branch_window" : "window";
  const args = [
    "-C", session.cwd, "log",
    ...(branch ? [branch] : []),
    "--since", normalizeGitTimestamp(session.started_at),
    "--until", normalizeGitTimestamp(session.ended_at),
    "--no-merges", "--numstat", "--format=%H",
  ];
  return { args, method };
}

/** The git-outcome response body. `applicable:false` carries a `reason` (no_cwd /
 *  live / not_a_repo / git_failed) so the UI shows a clear state, never a 0. */
export type GitOutcomeBody =
  | ({ applicable: true; fidelity: "estimated"; method: CorrelationMethod } & GitOutcomeFigures)
  | { applicable: false; reason: string };

interface SessionGitRow {
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** Core of GET /api/sessions/:id/git-outcome, factored out for direct unit testing
 *  with an injected git runner (mirrors buildSessionErrors). Resolves the session,
 *  guards the inapplicable cases (added incrementally), else runs `git log` over the
 *  correlation window and sums the figures. Always 200 for a known session — an
 *  inapplicable case is `applicable:false`, never a 500 or a misleading 0. */
export async function computeSessionOutcome(
  db: Database,
  id: string,
  runGit: GitRunner,
): Promise<{ status: 200 | 404; body: GitOutcomeBody | { error: string } }> {
  const row = db
    .query<SessionGitRow, [string]>(
      `SELECT cwd, git_branch, started_at, ended_at FROM sessions WHERE session_id = ?`,
    )
    .get(id);
  if (!row) return { status: 404, body: { error: "not found" } };

  // Guards (no git spawned): a session with no working dir can't be a repo; a still
  // -live session has no stable end bound, so its window is open-ended (A2).
  if (!row.cwd) return { status: 200, body: { applicable: false, reason: "no_cwd" } };
  if (!row.ended_at) return { status: 200, body: { applicable: false, reason: "live" } };
  if (!row.started_at) return { status: 200, body: { applicable: false, reason: "no_window" } };

  const { args, method } = buildGitOutcomeArgs({
    cwd: row.cwd,
    git_branch: row.git_branch,
    started_at: row.started_at,
    ended_at: row.ended_at,
  });
  let proc = await runGit(args);
  let activeMethod = method;

  // Finding 2: exit 128 is overloaded. "not a git repository" is a genuine inapplicable
  // state; "unknown/bad revision" means the recorded git_branch was deleted but the repo
  // is fine — fall back to a time-window-only query (one extra spawn at most) rather than
  // mislabeling a valid repo as not_a_repo.
  if (
    proc.exitCode === 128 &&
    method === "branch_window" &&
    /unknown revision|bad revision/i.test(proc.stderr) &&
    !/not a git repository/i.test(proc.stderr)
  ) {
    const { args: windowArgs } = buildGitOutcomeArgs({
      cwd: row.cwd,
      git_branch: null, // drop the dead branch → method "window"
      started_at: row.started_at,
      ended_at: row.ended_at,
    });
    proc = await runGit(windowArgs);
    activeMethod = "window";
  }

  // git exits 128 when cwd isn't a repository — a clean inapplicable state, not an error.
  if (proc.exitCode === 128) return { status: 200, body: { applicable: false, reason: "not_a_repo" } };
  // Any other non-zero/null exit is a genuine failure (still 200, never a misleading 0).
  // 5b: distinguish the operability cases so a broken environment is diagnosable, and log
  // stderr server-side rather than swallowing it into a permanent silent empty state.
  if (proc.exitCode !== 0) {
    const reason =
      proc.exitCode === 127 || /could not be launched/i.test(proc.stderr) ? "git_not_found"
      : proc.exitCode === null || /timed out/i.test(proc.stderr) ? "timeout"
      : "git_failed";
    console.error(`[git-outcome] git failed for session ${id} (${reason}): ${proc.stderr.trim()}`);
    return { status: 200, body: { applicable: false, reason } };
  }

  const figures = parseGitNumstat(proc.stdout);
  return { status: 200, body: { applicable: true, fidelity: "estimated", method: activeMethod, ...figures } };
}

/** A day's git output, summed over that day's ended sessions with per-hash dedupe
 *  (a commit landing in several overlapping sessions' windows counts once). Still
 *  ESTIMATED — dedupe removes the cross-session over-count, but agent-vs-human
 *  authorship of a commit remains a heuristic. Pairs with burn_daily's estimated
 *  rack-rate axis. `deduped:true` records that the over-count was removed. */
export interface DayOutcome {
  date: string;
  sessions: number;
  commits: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  fidelity: "estimated";
  deduped: true;
}

/** Roll a single day's git output up across its ENDED sessions, unioning commits by
 *  hash so an overlapping commit is counted once (Q2 dedupe). Buckets by
 *  DATE(started_at,'localtime') — the same key burn_daily uses — and reuses the
 *  per-session zero-network argv builder + per-commit parser. Injected runGit so the
 *  rollup is unit-tested with no subprocess. Always returns a body (empty day →
 *  zeros); a non-repo/failed session contributes nothing rather than aborting. */
export async function computeDayOutcome(
  db: Database,
  date: string,
  runGit: GitRunner,
): Promise<DayOutcome> {
  const rows = db
    .query<SessionGitRow & { cwd: string; started_at: string; ended_at: string }, [string]>(
      `SELECT cwd, git_branch, started_at, ended_at FROM sessions
       WHERE DATE(started_at,'localtime') = ? AND ended_at IS NOT NULL AND cwd IS NOT NULL`,
    )
    .all(date);

  const byHash = new Map<string, GitCommit>();
  for (const row of rows) {
    const { args } = buildGitOutcomeArgs({
      cwd: row.cwd,
      git_branch: row.git_branch,
      started_at: row.started_at,
      ended_at: row.ended_at,
    });
    const proc = await runGit(args);
    if (proc.exitCode !== 0) continue; // not_a_repo / git_failed contributes nothing
    for (const c of parseGitCommits(proc.stdout)) {
      if (!byHash.has(c.hash)) byHash.set(c.hash, c); // first wins; identical across windows
    }
  }

  let insertions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const c of byHash.values()) {
    insertions += c.insertions;
    deletions += c.deletions;
    for (const f of c.files) files.add(f);
  }

  return {
    date,
    sessions: rows.length,
    commits: byHash.size,
    insertions,
    deletions,
    filesChanged: files.size,
    fidelity: "estimated",
    deduped: true,
  };
}

/** The real git runner: spawn `git` with an argv array (never a shell string),
 *  drain stdout+stderr concurrently (no pipe deadlock), and SIGKILL on a short
 *  watchdog — the same shape as library_bridge.runBridge. stdin is closed; the
 *  argv can only be the local `log` invocation buildGitOutcomeArgs produces, so no
 *  network command is reachable. git-not-found / timeout surface as a non-zero/null
 *  exit, which computeSessionOutcome maps to a clean git_failed (never a 500). */
export const runGitLog: GitRunner = async (args) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: `git could not be launched: ${String(e)}` };
  }
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, 5_000);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (timedOut) return { exitCode: null, stdout: "", stderr: "git log timed out" };
    return { exitCode: proc.exitCode, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
};

/** Parse `git log --numstat --format=%H` output into summed figures. A commit is a
 *  40-hex hash line; numstat rows are `<added>\t<deleted>\t<path>` (binary files
 *  show `-` for both counts). filesChanged is the count of DISTINCT paths so a file
 *  touched by several commits in the window isn't double-counted. */
export function parseGitNumstat(stdout: string): GitOutcomeFigures {
  let commits = 0;
  let insertions = 0;
  let deletions = 0;
  const files = new Set<string>();

  for (const line of stdout.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commits += 1;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue; // blank lines and anything unexpected
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
    files.add(m[3]!);
  }

  return { commits, insertions, deletions, filesChanged: files.size };
}

/** One commit's figures, keyed by hash — the granularity a DAY rollup needs to
 *  dedupe a commit that lands inside several overlapping sessions' windows. */
export interface GitCommit {
  hash: string;
  insertions: number;
  deletions: number;
  files: string[];
}

/** Parse `git log --numstat --format=%H` into per-commit rows (vs parseGitNumstat's
 *  pre-summed scalars). A 40-hex line opens a commit; subsequent numstat rows attach
 *  to it. Used by computeDayOutcome to union commits by hash across a day's sessions. */
export function parseGitCommits(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  let cur: GitCommit | null = null;
  for (const line of stdout.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      cur = { hash: line, insertions: 0, deletions: 0, files: [] };
      commits.push(cur);
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m || !cur) continue;
    if (m[1] !== "-") cur.insertions += Number(m[1]);
    if (m[2] !== "-") cur.deletions += Number(m[2]);
    cur.files.push(m[3]!);
  }
  return commits;
}
