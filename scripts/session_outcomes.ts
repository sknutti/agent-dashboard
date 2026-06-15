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

/** Build the `git log` argv array for a session's outcome window (Q1: scope to
 *  git_branch when present, else time-window only). ALWAYS a local `log` — the only
 *  subcommand this can ever produce, preserving the zero-network invariant. Argv
 *  array, never a shell string (mirrors library_bridge M1). Timestamps are ISO-8601
 *  from the adapters, which git --since/--until accept directly. */
export function buildGitOutcomeArgs(
  session: SessionGitInput,
): { args: string[]; method: CorrelationMethod } {
  const branch = session.git_branch?.trim() || null;
  const method: CorrelationMethod = branch ? "branch_window" : "window";
  const args = [
    "-C", session.cwd, "log",
    ...(branch ? [branch] : []),
    "--since", session.started_at,
    "--until", session.ended_at,
    "--numstat", "--format=%H",
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
  const proc = await runGit(args);
  // git exits 128 when cwd isn't a repository — a clean inapplicable state, not an
  // error. Any other non-zero/null exit is a genuine git failure (still not a 500).
  if (proc.exitCode === 128) return { status: 200, body: { applicable: false, reason: "not_a_repo" } };
  if (proc.exitCode !== 0) return { status: 200, body: { applicable: false, reason: "git_failed" } };

  const figures = parseGitNumstat(proc.stdout);
  return { status: 200, body: { applicable: true, fidelity: "estimated", method, ...figures } };
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
