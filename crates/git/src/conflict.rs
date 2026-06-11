//! `git pull --rebase` conflict introspection and resolution.
//!
//! When a pull stops with conflicts, the UI walks unmerged paths one at a
//! time and lets the user pick a side or skip. These helpers wrap the
//! plumbing commands needed to drive that wizard.
//!
//! # Side semantics
//!
//! During `git pull --rebase`, `HEAD` is the upstream tip and the local
//! commits are replayed on top. That swaps git's `--ours` / `--theirs`
//! relative to a regular merge:
//!
//! - Stage 2 (`--ours`) = upstream tip = **what came from the remote**
//! - Stage 3 (`--theirs`) = the local commit being replayed = **what
//!   was on this machine**
//!
//! The [`Side`] enum is in the caller's terms (Local vs. Remote) and
//! these helpers translate to the right stage / checkout flag. Callers
//! never need to think about the swap.
//!
//! Functions assume the repo is mid-rebase; behavior is undefined if it
//! isn't (use [`is_rebase_in_progress`] to gate first).

use crate::runner::{GitRunner, RunnerError};
use std::path::{Path, PathBuf};

/// Which side of a conflict the caller wants — in user terms, not git
/// terms. The mapping to `--ours` / `--theirs` is hidden in this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// What was on this machine before the pull.
    Local,
    /// What came in from the remote.
    Remote,
}

impl Side {
    /// Index stage for `git show :<n>:<path>`. See module docs for why
    /// Local maps to stage 3 during a rebase.
    fn stage(self) -> u8 {
        match self {
            Side::Local => 3,
            Side::Remote => 2,
        }
    }

    /// `git checkout` flag that materializes this side into the working
    /// tree. Inverse of [`Side::stage`] — `--ours` is stage 2, `--theirs`
    /// is stage 3, but during rebase the user-facing side is swapped.
    fn checkout_flag(self) -> &'static str {
        match self {
            Side::Local => "--theirs",
            Side::Remote => "--ours",
        }
    }
}

/// True if `repo_dir` has a rebase in progress. Pure filesystem check —
/// `.git/rebase-merge/` (interactive / `--rebase=merges`) or
/// `.git/rebase-apply/` (default `am`-based) is present iff the
/// previous pull stopped on a conflict and hasn't been continued or
/// aborted.
pub fn is_rebase_in_progress(repo_dir: &Path) -> bool {
    let git_dir = repo_dir.join(".git");
    git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir()
}

/// `git diff --name-only --diff-filter=U -z` — every path with unmerged
/// index entries (i.e. every conflict the user must resolve before the
/// rebase can continue).
pub async fn list_unmerged_paths<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
) -> Result<Vec<PathBuf>, RunnerError> {
    let output = runner
        .run(
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            repo_dir,
            &[],
        )
        .await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    output
        .stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| {
            std::str::from_utf8(s)
                .map(PathBuf::from)
                .map_err(|_| RunnerError::Spawn(format!("non-UTF8 path from git: {s:?}")))
        })
        .collect()
}

/// Read the bytes of `path` at the requested side of the conflict.
///
/// Returns `Ok(None)` when the side has no index entry — e.g. one side
/// deleted while the other modified, or the path was added on only one
/// side. `git show` exits non-zero in that case; we match on the
/// "exists in index" path via `git ls-files --stage` first to keep
/// missing-side as a normal value, not an error.
pub async fn read_conflict_side<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    path: &Path,
    side: Side,
) -> Result<Option<Vec<u8>>, RunnerError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| RunnerError::Spawn(format!("non-UTF8 path: {path:?}")))?;
    if !stage_exists(runner, repo_dir, path_str, side.stage()).await? {
        return Ok(None);
    }
    let spec = format!(":{}:{}", side.stage(), path_str);
    let output = runner.run(&["show", &spec], repo_dir, &[]).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(Some(output.stdout))
}

/// Whether `git ls-files --stage -- <path>` reports an entry at `stage`.
/// Output format: `<mode> <sha> <stage>\t<path>`, one line per stage.
async fn stage_exists<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    path: &str,
    stage: u8,
) -> Result<bool, RunnerError> {
    let output = runner
        .run(&["ls-files", "--stage", "--", path], repo_dir, &[])
        .await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let prefix = format!(" {stage}\t");
    let body = std::str::from_utf8(&output.stdout)
        .map_err(|_| RunnerError::Spawn("non-UTF8 ls-files output".into()))?;
    Ok(body.lines().any(|line| line.contains(&prefix)))
}

/// Resolve `path` by writing the requested side to the working tree and
/// staging it: `git checkout <flag> -- <path>` then `git add -- <path>`.
/// Caller is responsible for picking a path that's actually unmerged.
pub async fn resolve_with_side<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    path: &Path,
    side: Side,
) -> Result<(), RunnerError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| RunnerError::Spawn(format!("non-UTF8 path: {path:?}")))?;
    let checkout = runner
        .run(
            &["checkout", side.checkout_flag(), "--", path_str],
            repo_dir,
            &[],
        )
        .await?;
    if checkout.status != 0 {
        return Err(RunnerError::Failed {
            status: checkout.status,
            stderr: String::from_utf8_lossy(&checkout.stderr).into_owned(),
        });
    }
    let add = runner.run(&["add", "--", path_str], repo_dir, &[]).await?;
    if add.status != 0 {
        return Err(RunnerError::Failed {
            status: add.status,
            stderr: String::from_utf8_lossy(&add.stderr).into_owned(),
        });
    }
    Ok(())
}

/// Resume a paused rebase: `git rebase --continue`. `GIT_EDITOR=true`
/// suppresses the commit-message editor that git would otherwise pop up
/// when continuing — there's no human at a TTY here, and we don't
/// rewrite messages from the wizard.
///
/// Returns:
/// - `Ok(true)` — rebase finished cleanly.
/// - `Ok(false)` — rebase paused again on a fresh conflict (more work
///   for the wizard). Detected by checking [`is_rebase_in_progress`]
///   after a non-zero exit.
/// - `Err(_)` — anything else (corrupt repo, unstaged paths, …).
pub async fn rebase_continue<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
) -> Result<bool, RunnerError> {
    let output = runner
        .run(&["rebase", "--continue"], repo_dir, &[("GIT_EDITOR", "true")])
        .await?;
    if output.status == 0 {
        return Ok(true);
    }
    if is_rebase_in_progress(repo_dir) {
        return Ok(false);
    }
    Err(RunnerError::Failed {
        status: output.status,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// `git rebase --abort` — discard the in-progress rebase and restore the
/// branch to its pre-pull state.
pub async fn rebase_abort<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
) -> Result<(), RunnerError> {
    let output = runner.run(&["rebase", "--abort"], repo_dir, &[]).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{CommandOutput, FakeRunner, TokioProcessRunner};
    use std::path::PathBuf;

    #[test]
    fn is_rebase_in_progress_detects_rebase_merge_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git/rebase-merge")).unwrap();
        assert!(is_rebase_in_progress(tmp.path()));
    }

    #[test]
    fn is_rebase_in_progress_detects_rebase_apply_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git/rebase-apply")).unwrap();
        assert!(is_rebase_in_progress(tmp.path()));
    }

    #[test]
    fn is_rebase_in_progress_false_when_neither_dir_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        assert!(!is_rebase_in_progress(tmp.path()));
    }

    #[tokio::test]
    async fn list_unmerged_paths_invokes_diff_with_filter_u_and_z() {
        let runner = FakeRunner::default();
        list_unmerged_paths(&runner, &PathBuf::from("/repo"))
            .await
            .unwrap();
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].args,
            vec!["diff", "--name-only", "--diff-filter=U", "-z"],
        );
    }

    #[tokio::test]
    async fn list_unmerged_paths_parses_null_separated() {
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"current.txt\0versions/v3/skill.md\0".to_vec(),
            stderr: Vec::new(),
        });
        let paths = list_unmerged_paths(&runner, &PathBuf::from("/repo"))
            .await
            .unwrap();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("current.txt"),
                PathBuf::from("versions/v3/skill.md"),
            ],
        );
    }

    #[tokio::test]
    async fn list_unmerged_paths_empty_stdout_yields_empty() {
        let runner = FakeRunner::default();
        let paths = list_unmerged_paths(&runner, &PathBuf::from("/repo"))
            .await
            .unwrap();
        assert!(paths.is_empty());
    }

    #[tokio::test]
    async fn read_conflict_side_local_uses_stage_three() {
        // ls-files reports both stage 2 and stage 3, then we read stage 3
        // for Side::Local.
        let runner = FakeRunner::default().with_response_queue(vec![
            CommandOutput {
                status: 0,
                stdout: b"100644 abc 2\tcurrent.txt\n100644 def 3\tcurrent.txt\n".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: b"local-bytes".to_vec(),
                stderr: Vec::new(),
            },
        ]);
        let bytes = read_conflict_side(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("current.txt"),
            Side::Local,
        )
        .await
        .unwrap();
        assert_eq!(bytes.as_deref(), Some(b"local-bytes".as_slice()));

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].args,
            vec!["show", ":3:current.txt"],
            "Side::Local must read stage 3 during rebase",
        );
    }

    #[tokio::test]
    async fn read_conflict_side_remote_uses_stage_two() {
        let runner = FakeRunner::default().with_response_queue(vec![
            CommandOutput {
                status: 0,
                stdout: b"100644 abc 2\tcurrent.txt\n100644 def 3\tcurrent.txt\n".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: b"remote-bytes".to_vec(),
                stderr: Vec::new(),
            },
        ]);
        let bytes = read_conflict_side(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("current.txt"),
            Side::Remote,
        )
        .await
        .unwrap();
        assert_eq!(bytes.as_deref(), Some(b"remote-bytes".as_slice()));

        let calls = runner.captured_calls();
        assert_eq!(calls[1].args, vec!["show", ":2:current.txt"]);
    }

    #[tokio::test]
    async fn read_conflict_side_returns_none_when_stage_missing() {
        // ls-files only shows stage 2 (other side deleted) — Local must
        // be reported as None instead of erroring.
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"100644 abc 2\tcurrent.txt\n".to_vec(),
            stderr: Vec::new(),
        });
        let bytes = read_conflict_side(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("current.txt"),
            Side::Local,
        )
        .await
        .unwrap();
        assert!(bytes.is_none());
        // Only one call — we short-circuited before invoking `git show`.
        assert_eq!(runner.captured_calls().len(), 1);
    }

    #[tokio::test]
    async fn resolve_with_side_local_runs_checkout_theirs_then_add() {
        let runner = FakeRunner::default();
        resolve_with_side(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("current.txt"),
            Side::Local,
        )
        .await
        .unwrap();
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].args,
            vec!["checkout", "--theirs", "--", "current.txt"],
            "Side::Local must use --theirs during rebase",
        );
        assert_eq!(calls[1].args, vec!["add", "--", "current.txt"]);
    }

    #[tokio::test]
    async fn resolve_with_side_remote_runs_checkout_ours_then_add() {
        let runner = FakeRunner::default();
        resolve_with_side(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("current.txt"),
            Side::Remote,
        )
        .await
        .unwrap();
        let calls = runner.captured_calls();
        assert_eq!(
            calls[0].args,
            vec!["checkout", "--ours", "--", "current.txt"],
            "Side::Remote must use --ours during rebase",
        );
    }

    #[tokio::test]
    async fn rebase_continue_returns_true_when_clean() {
        // Need an isolated tmp dir so is_rebase_in_progress sees no marker.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        let runner = FakeRunner::default();
        let done = rebase_continue(&runner, tmp.path()).await.unwrap();
        assert!(done);
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["rebase", "--continue"]);
        assert_eq!(
            calls[0].env,
            vec![("GIT_EDITOR".to_string(), "true".to_string())],
        );
    }

    #[tokio::test]
    async fn rebase_continue_returns_false_when_more_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git/rebase-merge")).unwrap();
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 1,
            stdout: Vec::new(),
            stderr: b"CONFLICT (content): Merge conflict in current.txt\n".to_vec(),
        });
        let done = rebase_continue(&runner, tmp.path()).await.unwrap();
        assert!(!done, "still in rebase → caller has more work");
    }

    #[tokio::test]
    async fn rebase_continue_propagates_error_when_not_in_rebase() {
        // No rebase marker on disk + non-zero exit = a real error
        // (e.g. "fatal: no rebase in progress").
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: No rebase in progress?".to_vec(),
        });
        let err = rebase_continue(&runner, tmp.path()).await.unwrap_err();
        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 128);
                assert!(stderr.contains("No rebase in progress"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rebase_abort_invokes_abort() {
        let runner = FakeRunner::default();
        rebase_abort(&runner, &PathBuf::from("/repo")).await.unwrap();
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["rebase", "--abort"]);
    }

    /// End-to-end smoke test: drive a real git repo into a conflict
    /// state, walk our APIs, and confirm the rebase finishes clean.
    /// Exercises stage parsing, `--ours`/`--theirs` mapping, and the
    /// continue-vs-more-conflicts return value.
    #[tokio::test]
    async fn integration_resolve_and_continue_rebase() {
        let tmp = tempfile::tempdir().unwrap();
        let runner = TokioProcessRunner::new();

        // Bare repo as origin.
        let origin = tmp.path().join("origin.git");
        runner
            .run(&["init", "--bare", origin.to_str().unwrap()], tmp.path(), &[])
            .await
            .unwrap();

        // Helper: configure a fresh clone with identity.
        async fn configure(runner: &TokioProcessRunner, dir: &Path) {
            for args in [
                ["config", "user.email", "t@e.x"],
                ["config", "user.name", "t"],
                ["config", "commit.gpgsign", "false"],
            ] {
                let o = runner.run(&args, dir, &[]).await.unwrap();
                assert_eq!(o.status, 0, "{args:?} failed: {:?}", o.stderr);
            }
        }

        // Machine A: clone, write file, push.
        let a = tmp.path().join("a");
        let o = runner
            .run(
                &["clone", origin.to_str().unwrap(), a.to_str().unwrap()],
                tmp.path(),
                &[],
            )
            .await
            .unwrap();
        assert_eq!(o.status, 0, "clone a failed: {:?}", o.stderr);
        configure(&runner, &a).await;
        std::fs::write(a.join("current.txt"), b"v1\n").unwrap();
        runner.run(&["add", "."], &a, &[]).await.unwrap();
        runner
            .run(&["commit", "-m", "v1"], &a, &[])
            .await
            .unwrap();
        let push = runner
            .run(&["push", "-u", "origin", "HEAD:main"], &a, &[])
            .await
            .unwrap();
        assert_eq!(push.status, 0, "{:?}", push.stderr);

        // Machine B: clone, change current.txt, push.
        let b = tmp.path().join("b");
        runner
            .run(
                &["clone", "-b", "main", origin.to_str().unwrap(), b.to_str().unwrap()],
                tmp.path(),
                &[],
            )
            .await
            .unwrap();
        configure(&runner, &b).await;
        std::fs::write(b.join("current.txt"), b"remote\n").unwrap();
        runner.run(&["add", "."], &b, &[]).await.unwrap();
        runner
            .run(&["commit", "-m", "remote-change"], &b, &[])
            .await
            .unwrap();
        let push_b = runner.run(&["push", "origin", "main"], &b, &[]).await.unwrap();
        assert_eq!(push_b.status, 0, "{:?}", push_b.stderr);

        // Machine A: change same file differently, attempt pull --rebase.
        std::fs::write(a.join("current.txt"), b"local\n").unwrap();
        runner.run(&["add", "."], &a, &[]).await.unwrap();
        runner
            .run(&["commit", "-m", "local-change"], &a, &[])
            .await
            .unwrap();
        let pull = runner
            .run(
                &["-c", "rebase.autoStash=false", "pull", "--rebase", "origin", "main"],
                &a,
                &[],
            )
            .await
            .unwrap();
        assert_ne!(pull.status, 0, "expected conflict on pull");
        assert!(is_rebase_in_progress(&a), "rebase marker should exist");

        // Walk our APIs.
        let conflicts = list_unmerged_paths(&runner, &a).await.unwrap();
        assert_eq!(conflicts, vec![PathBuf::from("current.txt")]);

        let local = read_conflict_side(&runner, &a, &PathBuf::from("current.txt"), Side::Local)
            .await
            .unwrap();
        let remote = read_conflict_side(&runner, &a, &PathBuf::from("current.txt"), Side::Remote)
            .await
            .unwrap();
        assert_eq!(local.as_deref(), Some(b"local\n".as_slice()));
        assert_eq!(remote.as_deref(), Some(b"remote\n".as_slice()));

        // Resolve → continue.
        resolve_with_side(&runner, &a, &PathBuf::from("current.txt"), Side::Local)
            .await
            .unwrap();
        let done = rebase_continue(&runner, &a).await.unwrap();
        assert!(done, "rebase should finish after the only conflict resolved");
        assert!(!is_rebase_in_progress(&a), "rebase marker should be gone");

        // Local content wins.
        let after = std::fs::read(a.join("current.txt")).unwrap();
        assert_eq!(after, b"local\n");
    }
}
