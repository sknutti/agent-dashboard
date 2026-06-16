// Git-derived session outcomes (tracer). The parser + argv builder are pure and
// unit-tested here; computeSessionOutcome injects the git spawn so these run with
// NO subprocess. Correlation is ESTIMATED (CONTEXT.md Fidelity) — these tests pin
// the heuristic's mechanics, not its (inherently fuzzy) attribution accuracy.

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./db.ts";
import {
  parseGitNumstat,
  parseGitCommits,
  buildGitOutcomeArgs,
  computeSessionOutcome,
  computeDayOutcome,
} from "./session_outcomes.ts";

// `git log --numstat --format=%H` output: a 40-hex hash line per commit, a blank
// line, then `<added>\t<deleted>\t<path>` rows (binary files show `-\t-\tpath`).
const NUMSTAT_FIXTURE = [
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "",
  "10\t2\tsrc/foo.ts",
  "5\t0\tsrc/bar.ts",
  "b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1",
  "",
  "3\t3\tsrc/foo.ts", // foo.ts again — distinct file count must not double it
  "-\t-\tassets/logo.png", // binary: counts as a file, 0 ins/del
].join("\n");

describe("parseGitNumstat", () => {
  test("sums commits, insertions, deletions, and DISTINCT files changed", () => {
    expect(parseGitNumstat(NUMSTAT_FIXTURE)).toEqual({
      commits: 2,
      insertions: 18, // 10 + 5 + 3
      deletions: 5, //   2 + 0 + 3
      filesChanged: 3, // foo.ts, bar.ts, logo.png (foo.ts once)
    });
  });

  test("empty output is an all-zero outcome", () => {
    expect(parseGitNumstat("")).toEqual({ commits: 0, insertions: 0, deletions: 0, filesChanged: 0 });
  });
});

describe("parseGitCommits (per-commit rows, for day-level hash dedupe)", () => {
  test("splits output into per-commit figures keyed by hash", () => {
    expect(parseGitCommits(NUMSTAT_FIXTURE)).toEqual([
      { hash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", insertions: 15, deletions: 2, files: ["src/foo.ts", "src/bar.ts"] },
      { hash: "b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1", insertions: 3, deletions: 3, files: ["src/foo.ts", "assets/logo.png"] },
    ]);
  });

  test("empty output yields no commits", () => {
    expect(parseGitCommits("")).toEqual([]);
  });
});

describe("buildGitOutcomeArgs (Q1: branch-scoped + window fallback)", () => {
  const base = { cwd: "/repo", started_at: "2026-06-01T00:00:00Z", ended_at: "2026-06-01T02:00:00Z" };

  test("scopes to the branch and the time window when git_branch is present", () => {
    const { args, method } = buildGitOutcomeArgs({ ...base, git_branch: "feat/x" });
    expect(method).toBe("branch_window");
    expect(args).toEqual([
      "-C", "/repo", "log", "feat/x",
      "--since", "2026-06-01T00:00:00Z", "--until", "2026-06-01T02:00:00Z",
      "--no-merges", "--numstat", "--format=%H",
    ]);
  });

  test("falls back to time-window-only when there is no branch", () => {
    const { args, method } = buildGitOutcomeArgs({ ...base, git_branch: null });
    expect(method).toBe("window");
    expect(args).not.toContain("feat/x");
    // log is still the only subcommand
    expect(args[2]).toBe("log");
  });

  test("ZERO-network invariant: the argv can only ever be a local `log`", () => {
    const { args } = buildGitOutcomeArgs({ ...base, git_branch: "main" });
    const forbidden = ["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"];
    for (const bad of forbidden) expect(args).not.toContain(bad);
    // the subcommand slot (after `-C <cwd>`) is exactly `log`
    expect(args[2]).toBe("log");
  });

  // Finding 1: merge commits emit NO numstat rows, so counting their %H line inflates
  // the commit count with zero LOC/files. --no-merges excludes them in git, keeping the
  // estimate an honest "lines produced" figure (decided: Q1 = --no-merges).
  test("excludes merge commits via --no-merges (both branch and no-branch variants)", () => {
    expect(buildGitOutcomeArgs({ ...base, git_branch: "feat/x" }).args).toContain("--no-merges");
    expect(buildGitOutcomeArgs({ ...base, git_branch: null }).args).toContain("--no-merges");
  });

  // Finding 3: an already-offset timestamp (incl. Z, which works today) is passed
  // through verbatim — no reparse, no skew.
  test("passes an already-offset timestamp through unchanged", () => {
    const { args } = buildGitOutcomeArgs({ ...base, git_branch: null });
    expect(args[args.indexOf("--since") + 1]).toBe("2026-06-01T00:00:00Z");
    expect(args[args.indexOf("--until") + 1]).toBe("2026-06-01T02:00:00Z");
  });

  // Finding 3: a no-offset timestamp would be read by git as machine-LOCAL time,
  // skewing the window. Normalize it to the same explicit-UTC form as its Z-equivalent.
  test("normalizes a no-offset timestamp to explicit UTC (same window as its Z form)", () => {
    const { args } = buildGitOutcomeArgs({
      cwd: "/repo", git_branch: null,
      started_at: "2026-06-01 00:00:00", ended_at: "2026-06-01T02:00:00",
    });
    expect(args[args.indexOf("--since") + 1]).toBe("2026-06-01T00:00:00Z");
    expect(args[args.indexOf("--until") + 1]).toBe("2026-06-01T02:00:00Z");
  });
});

describe("computeSessionOutcome", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    return db;
  }
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  const ended = {
    session_id: "s1", cwd: "/repo", git_branch: "feat/x",
    started_at: "2026-06-01T00:00:00Z", ended_at: "2026-06-01T02:00:00Z",
  };
  const okRunner = async () => ({ exitCode: 0, stdout: NUMSTAT_FIXTURE, stderr: "" });

  test("ended session in a git repo → applicable, ESTIMATED, figures from git", async () => {
    const db = freshDb();
    seed(db, ended);
    const { status, body } = await computeSessionOutcome(db, "s1", okRunner);
    expect(status).toBe(200);
    expect(body).toEqual({
      applicable: true, fidelity: "estimated", method: "branch_window",
      commits: 2, insertions: 18, deletions: 5, filesChanged: 3,
    });
    db.close();
  });

  test("unknown session id → 404", async () => {
    const db = freshDb();
    const { status } = await computeSessionOutcome(db, "nope", okRunner);
    expect(status).toBe(404);
    db.close();
  });

  // git must NOT run for the inapplicable cases — a runner that throws proves it.
  const neverRunner: typeof okRunner = async () => { throw new Error("git should not run"); };

  test("session with no cwd → applicable:false reason no_cwd, without running git", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s2", cwd: null });
    const { status, body } = await computeSessionOutcome(db, "s2", neverRunner);
    expect(status).toBe(200);
    expect(body).toEqual({ applicable: false, reason: "no_cwd" });
    db.close();
  });

  test("live session (no ended_at) → applicable:false reason live, without running git", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s3", ended_at: null });
    const { body } = await computeSessionOutcome(db, "s3", neverRunner);
    expect(body).toEqual({ applicable: false, reason: "live" });
    db.close();
  });

  test("non-repo cwd (git exit 128) → applicable:false reason not_a_repo, not a 500", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s4" });
    const exit128 = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" });
    const { status, body } = await computeSessionOutcome(db, "s4", exit128);
    expect(status).toBe(200);
    expect(body).toEqual({ applicable: false, reason: "not_a_repo" });
    db.close();
  });

  test("other git failure (non-zero, non-128) → applicable:false reason git_failed", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s5" });
    const exit1 = async () => ({ exitCode: 1, stdout: "", stderr: "fatal: bad revision" });
    const { body } = await computeSessionOutcome(db, "s5", exit1);
    expect(body).toEqual({ applicable: false, reason: "git_failed" });
    db.close();
  });

  // Finding 2: a recorded git_branch that was deleted makes `git log <branch>` exit 128
  // with "unknown revision" — a VALID repo. Fall back to time-window-only instead of
  // mislabeling it not_a_repo.
  test("deleted branch (exit 128, 'unknown revision') → falls back to window, applicable", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s6" }); // git_branch: "feat/x"
    const deletedBranch = async (args: string[]) =>
      args.includes("feat/x")
        ? { exitCode: 128, stdout: "", stderr: "fatal: bad revision 'feat/x'\nunknown revision or path not in the working tree" }
        : { exitCode: 0, stdout: NUMSTAT_FIXTURE, stderr: "" };
    const { status, body } = await computeSessionOutcome(db, "s6", deletedBranch);
    expect(status).toBe(200);
    expect(body).toEqual({
      applicable: true, fidelity: "estimated", method: "window",
      commits: 2, insertions: 18, deletions: 5, filesChanged: 3,
    });
    db.close();
  });

  // Finding 2 (reinforced): a TRUE non-repo (exit 128, "not a git repository") must still
  // map to not_a_repo, never trigger the deleted-branch window fallback.
  test("true not-a-repo (exit 128, 'not a git repository') still → not_a_repo (no fallback)", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s7" });
    const notRepo = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories)" });
    const { body } = await computeSessionOutcome(db, "s7", notRepo);
    expect(body).toEqual({ applicable: false, reason: "not_a_repo" });
    db.close();
  });

  // 5b: distinct operability reasons so a broken environment is diagnosable, not a
  // permanent silent "git_failed".
  test("spawn failure (exit 127) → reason git_not_found", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s8" });
    const notFound = async () => ({ exitCode: 127, stdout: "", stderr: "git could not be launched: ENOENT" });
    const { body } = await computeSessionOutcome(db, "s8", notFound);
    expect(body).toEqual({ applicable: false, reason: "git_not_found" });
    db.close();
  });

  test("timeout (exit null) → reason timeout", async () => {
    const db = freshDb();
    seed(db, { ...ended, session_id: "s9" });
    const timedOut = async () => ({ exitCode: null, stdout: "", stderr: "git log timed out" });
    const { body } = await computeSessionOutcome(db, "s9", timedOut);
    expect(body).toEqual({ applicable: false, reason: "timeout" });
    db.close();
  });
});

describe("computeDayOutcome (per-hash dedupe across a day's sessions)", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    return db;
  }
  function seed(db: Database, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => row[k] as any));
  }
  // The day key the same way the rollup buckets it, so the test is TZ-independent.
  const dayKey = (db: Database, iso: string): string =>
    (db.query<{ d: string }, [string]>("SELECT DATE(?, 'localtime') d").get(iso)!).d;

  const H1 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const H2 = "b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1";
  const H3 = "c1c2c3c4c5c6c7c8c9c0c1c2c3c4c5c6c7c8c9c0";
  // Session 1's window sees commits H1 + H2; session 2's window sees H2 + H3.
  // H2 is shared — the day rollup must count it exactly once.
  const FIX_A = [H1, "", "10\t2\tsrc/foo.ts", "5\t0\tsrc/bar.ts", H2, "", "3\t3\tsrc/foo.ts", "-\t-\tassets/logo.png"].join("\n");
  const FIX_B = [H2, "", "3\t3\tsrc/foo.ts", "-\t-\tassets/logo.png", H3, "", "7\t1\tsrc/baz.ts"].join("\n");
  // Keyed on the window's --since so each session gets its own git output.
  const dayRunner = async (args: string[]) => {
    const since = args[args.indexOf("--since") + 1];
    if (since === "2026-06-10T12:00:00Z") return { exitCode: 0, stdout: FIX_A, stderr: "" };
    if (since === "2026-06-10T14:00:00Z") return { exitCode: 0, stdout: FIX_B, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  test("unions commits by hash — a shared commit is counted ONCE, not summed twice", async () => {
    const db = freshDb();
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", git_branch: null, started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    seed(db, { session_id: "s2", cwd: "/repo", git_branch: null, started_at: "2026-06-10T14:00:00Z", ended_at: "2026-06-10T15:00:00Z" });
    const body = await computeDayOutcome(db, date, dayRunner);
    expect(body).toEqual({
      date, sessions: 2,
      commits: 3, // H1, H2, H3 — H2 deduped (raw sum would be 4)
      insertions: 25, // 15 + 3 + 7  (H2's 3 counted once, not twice → not 28)
      deletions: 6, //   2 + 3 + 1
      filesChanged: 4, // foo, bar, logo, baz (distinct across deduped commits)
      fidelity: "estimated", deduped: true,
    });
    db.close();
  });

  test("excludes live (no ended_at) sessions from the day", async () => {
    const db = freshDb();
    const date = dayKey(db, "2026-06-10T12:00:00Z");
    seed(db, { session_id: "s1", cwd: "/repo", git_branch: null, started_at: "2026-06-10T12:00:00Z", ended_at: "2026-06-10T13:00:00Z" });
    seed(db, { session_id: "live", cwd: "/repo", git_branch: null, started_at: "2026-06-10T14:00:00Z", ended_at: null });
    const body = await computeDayOutcome(db, date, dayRunner);
    expect(body.sessions).toBe(1); // only the ended session
    expect(body.commits).toBe(2); // H1, H2 from FIX_A only
    db.close();
  });

  test("a day with no ended sessions returns zeros, never throws", async () => {
    const db = freshDb();
    const never = async () => { throw new Error("git should not run"); };
    const body = await computeDayOutcome(db, "2020-01-01", never);
    expect(body).toEqual({
      date: "2020-01-01", sessions: 0, commits: 0, insertions: 0, deletions: 0,
      filesChanged: 0, fidelity: "estimated", deduped: true,
    });
    db.close();
  });
});
