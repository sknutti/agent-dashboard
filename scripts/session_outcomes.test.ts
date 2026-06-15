// Git-derived session outcomes (tracer). The parser + argv builder are pure and
// unit-tested here; computeSessionOutcome injects the git spawn so these run with
// NO subprocess. Correlation is ESTIMATED (CONTEXT.md Fidelity) — these tests pin
// the heuristic's mechanics, not its (inherently fuzzy) attribution accuracy.

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./db.ts";
import { parseGitNumstat, buildGitOutcomeArgs, computeSessionOutcome } from "./session_outcomes.ts";

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

describe("buildGitOutcomeArgs (Q1: branch-scoped + window fallback)", () => {
  const base = { cwd: "/repo", started_at: "2026-06-01T00:00:00Z", ended_at: "2026-06-01T02:00:00Z" };

  test("scopes to the branch and the time window when git_branch is present", () => {
    const { args, method } = buildGitOutcomeArgs({ ...base, git_branch: "feat/x" });
    expect(method).toBe("branch_window");
    expect(args).toEqual([
      "-C", "/repo", "log", "feat/x",
      "--since", "2026-06-01T00:00:00Z", "--until", "2026-06-01T02:00:00Z",
      "--numstat", "--format=%H",
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
});
