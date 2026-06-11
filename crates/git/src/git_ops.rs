//! High-level git operations on top of [`crate::runner::GitRunner`].

use crate::runner::{GitRunner, RunnerError};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub async fn git_push<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    askpass_path: &Path,
    pat: &str,
) -> Result<(), RunnerError> {
    let askpass_str = askpass_path.to_str().ok_or_else(|| {
        RunnerError::Spawn(format!("non-UTF8 askpass path: {askpass_path:?}"))
    })?;
    let env = [("GIT_ASKPASS", askpass_str), ("PROMPT_LIBRARY_PAT", pat)];
    let output = runner.run(&["push"], repo_dir, &env).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// `git pull --rebase` with a wall-clock timeout. On expiry, returns
/// [`RunnerError::TimedOut`] so the caller can surface an "offline
/// mode" toast and unblock first paint. PAT delivered via env, never
/// argv, same as [`git_push`].
pub async fn git_pull<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    askpass_path: &Path,
    pat: &str,
    timeout: Duration,
) -> Result<(), RunnerError> {
    let askpass_str = askpass_path.to_str().ok_or_else(|| {
        RunnerError::Spawn(format!("non-UTF8 askpass path: {askpass_path:?}"))
    })?;
    let env = [("GIT_ASKPASS", askpass_str), ("PROMPT_LIBRARY_PAT", pat)];
    let output = tokio::time::timeout(timeout, runner.run(&["pull", "--rebase"], repo_dir, &env))
        .await
        .map_err(|_| RunnerError::TimedOut)??;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// List paths added or modified across `range` (e.g. `origin/main..HEAD`).
///
/// Uses `git diff --name-only --diff-filter=AM -z <range>` so deletions
/// are skipped (their HEAD content does not exist) and paths are
/// null-separated for safety.
pub async fn git_diff_changed_files<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    range: &str,
) -> Result<Vec<PathBuf>, RunnerError> {
    let output = runner
        .run(
            &["diff", "--name-only", "--diff-filter=AM", "-z", range],
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

/// Read the bytes of `path` at git revision `git_ref` via `git show`.
pub async fn git_show_blob<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    git_ref: &str,
    path: &Path,
) -> Result<Vec<u8>, RunnerError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| RunnerError::Spawn(format!("non-UTF8 path: {path:?}")))?;
    let spec = format!("{git_ref}:{path_str}");
    let output = runner.run(&["show", &spec], repo_dir, &[]).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(output.stdout)
}

/// `git push -u origin <branch>` — for the first push on a new branch.
///
/// Subsequent pushes use [`git_push`] (no upstream flag) once the
/// remote tracking branch exists. Caller picks via
/// [`remote_branch_exists`].
pub async fn git_push_with_upstream<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    askpass_path: &Path,
    pat: &str,
    branch: &str,
) -> Result<(), RunnerError> {
    let askpass_str = askpass_path.to_str().ok_or_else(|| {
        RunnerError::Spawn(format!("non-UTF8 askpass path: {askpass_path:?}"))
    })?;
    let env = [("GIT_ASKPASS", askpass_str), ("PROMPT_LIBRARY_PAT", pat)];
    let output = runner
        .run(&["push", "-u", "origin", branch], repo_dir, &env)
        .await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// Read the current branch name (`git rev-parse --abbrev-ref HEAD`).
///
/// Returns the trimmed branch name. Detached HEAD shows up as `"HEAD"`;
/// caller is responsible for treating that as an error if it cares.
pub async fn current_branch<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
) -> Result<String, RunnerError> {
    let output = runner
        .run(&["rev-parse", "--abbrev-ref", "HEAD"], repo_dir, &[])
        .await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let s = std::str::from_utf8(&output.stdout)
        .map_err(|_| RunnerError::Spawn(format!("non-UTF8 branch name: {:?}", output.stdout)))?;
    Ok(s.trim().to_string())
}

/// Whether `refs/remotes/origin/<branch>` exists locally.
///
/// Uses `git rev-parse --verify --quiet`. Exit status 1 with empty
/// output is the documented "ref does not exist" path — that returns
/// `Ok(false)`, not [`RunnerError::Failed`]. Other non-zero exits
/// surface as failures.
pub async fn remote_branch_exists<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    branch: &str,
) -> Result<bool, RunnerError> {
    let refspec = format!("refs/remotes/origin/{branch}");
    let output = runner
        .run(&["rev-parse", "--verify", "--quiet", &refspec], repo_dir, &[])
        .await?;
    match output.status {
        0 => Ok(true),
        1 if output.stderr.is_empty() => Ok(false),
        _ => Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
    }
}

/// `git add -- <paths>`. Empty `paths` is a no-op (no command issued).
///
/// Caller controls the path list — we never spread to `add .` from here
/// because the plan restricts commits to `versions/`, `metadata.yaml`,
/// `current.txt`, `.gitignore`, and a root README. [`git_add_all`] is
/// the explicit "everything" path used at library init.
pub async fn git_add<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    paths: &[&str],
) -> Result<(), RunnerError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend_from_slice(paths);
    let output = runner.run(&args, repo_dir, &[]).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// `git add -A` — stage everything (additions, modifications, deletions)
/// honoring `.gitignore`. Used only at library init to seed the first
/// commit; routine commits use [`git_add`] with an explicit path list.
pub async fn git_add_all<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
) -> Result<(), RunnerError> {
    let output = runner.run(&["add", "-A"], repo_dir, &[]).await?;
    if output.status != 0 {
        return Err(RunnerError::Failed {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// `git commit -F -` with `message` piped on stdin. Stdin avoids argv
/// length limits and the shell's control-char stripping that would
/// otherwise mangle release notes.
///
/// Returns `Ok(true)` on a successful commit, `Ok(false)` if there was
/// nothing staged (`nothing to commit, working tree clean`). Other
/// non-zero exits surface as [`RunnerError::Failed`].
pub async fn git_commit<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    message: &str,
) -> Result<bool, RunnerError> {
    // `--allow-empty-message` is intentionally omitted: callers must
    // supply a non-empty message. We do NOT pass `--allow-empty` either —
    // an empty staging area should fall through the "nothing to commit"
    // detection below, not silently produce an empty commit.
    let output = runner
        .run_with_stdin(&["commit", "-F", "-"], repo_dir, &[], message.as_bytes())
        .await?;
    if output.status == 0 {
        return Ok(true);
    }
    // git exits 1 when there's nothing to commit — surface as Ok(false)
    // rather than Failed so publish-without-changes doesn't error.
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status == 1 && combined.contains("nothing to commit") {
        return Ok(false);
    }
    Err(RunnerError::Failed {
        status: output.status,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub async fn git_init<R: GitRunner>(runner: &R, target: &Path) -> Result<(), RunnerError> {
    let target_str = target
        .to_str()
        .ok_or_else(|| RunnerError::Spawn(format!("non-UTF8 target path: {target:?}")))?;
    let cwd = target.parent().unwrap_or(Path::new("."));
    let output = runner.run(&["init", target_str], cwd, &[]).await?;
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
    use crate::runner::FakeRunner;
    use std::path::PathBuf;

    #[tokio::test]
    async fn git_push_passes_askpass_path_and_pat_via_env() {
        let runner = FakeRunner::default();
        let askpass = PathBuf::from("/state/git-askpass.sh");
        let pat = "ghp_token";

        git_push(&runner, &PathBuf::from("/repo"), &askpass, pat)
            .await
            .unwrap();

        let calls = runner.captured_calls();
        let env: std::collections::HashMap<&str, &str> = calls[0]
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(env.get("GIT_ASKPASS"), Some(&"/state/git-askpass.sh"));
        assert_eq!(env.get("PROMPT_LIBRARY_PAT"), Some(&pat));
    }

    #[tokio::test]
    async fn git_push_never_leaks_pat_into_argv() {
        let runner = FakeRunner::default();
        let pat = "ghp_supersecrettoken1234567890abcdefghij";

        git_push(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/askpass"),
            pat,
        )
        .await
        .unwrap();

        for call in runner.captured_calls() {
            for arg in &call.args {
                assert!(
                    !arg.contains(pat),
                    "PAT leaked into argv: {arg:?} contains {pat:?}",
                );
                assert!(
                    !arg.contains("ghp_"),
                    "argv contains a ghp_ prefix substring: {arg:?}",
                );
            }
        }
    }

    #[tokio::test]
    async fn git_push_invokes_runner_with_push_in_repo_dir() {
        let runner = FakeRunner::default();
        let repo = PathBuf::from("/repo");
        let askpass = PathBuf::from("/state/git-askpass.sh");

        git_push(&runner, &repo, &askpass, "ghp_token").await.unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["push"]);
        assert_eq!(calls[0].cwd, repo);
    }

    #[tokio::test]
    async fn integration_git_init_creates_dot_git() {
        use crate::runner::TokioProcessRunner;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("repo");

        let runner = TokioProcessRunner::new();
        git_init(&runner, &target).await.unwrap();

        assert!(
            target.join(".git").is_dir(),
            "expected .git directory at {target:?}",
        );
    }

    #[tokio::test]
    async fn git_init_propagates_non_zero_exit_as_failed() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: cannot mkdir /nope".to_vec(),
        });

        let err = git_init(&runner, &PathBuf::from("/nope/foo")).await.unwrap_err();

        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 128);
                assert!(stderr.contains("cannot mkdir"), "stderr={stderr:?}");
            }
            other => panic!("expected RunnerError::Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_init_invokes_init_with_target_path() {
        let runner = FakeRunner::default();
        let target = PathBuf::from("/tmp/foo");

        git_init(&runner, &target).await.unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["init", "/tmp/foo"]);
    }

    #[tokio::test]
    async fn git_diff_changed_files_invokes_diff_with_filter_and_z() {
        let runner = FakeRunner::default();
        git_diff_changed_files(&runner, &PathBuf::from("/repo"), "origin/main..HEAD")
            .await
            .unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].args,
            vec![
                "diff",
                "--name-only",
                "--diff-filter=AM",
                "-z",
                "origin/main..HEAD"
            ],
        );
    }

    #[tokio::test]
    async fn git_diff_changed_files_parses_null_separated_paths() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"a.md\0sub/b.md\0c with space.md\0".to_vec(),
            stderr: Vec::new(),
        });

        let paths = git_diff_changed_files(&runner, &PathBuf::from("/repo"), "x..y")
            .await
            .unwrap();

        assert_eq!(
            paths,
            vec![
                PathBuf::from("a.md"),
                PathBuf::from("sub/b.md"),
                PathBuf::from("c with space.md"),
            ],
        );
    }

    #[tokio::test]
    async fn git_diff_changed_files_empty_stdout_yields_empty_vec() {
        let runner = FakeRunner::default();
        let paths = git_diff_changed_files(&runner, &PathBuf::from("/repo"), "x..y")
            .await
            .unwrap();
        assert!(paths.is_empty());
    }

    #[tokio::test]
    async fn git_diff_changed_files_propagates_failure() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: bad revision".to_vec(),
        });

        let err = git_diff_changed_files(&runner, &PathBuf::from("/repo"), "bogus..HEAD")
            .await
            .unwrap_err();

        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 128);
                assert!(stderr.contains("bad revision"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_show_blob_invokes_show_with_refspec() {
        let runner = FakeRunner::default();
        git_show_blob(
            &runner,
            &PathBuf::from("/repo"),
            "HEAD",
            &PathBuf::from("a.md"),
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["show", "HEAD:a.md"]);
    }

    #[tokio::test]
    async fn git_show_blob_returns_stdout_bytes() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"hello world".to_vec(),
            stderr: Vec::new(),
        });

        let bytes = git_show_blob(
            &runner,
            &PathBuf::from("/repo"),
            "HEAD",
            &PathBuf::from("a.md"),
        )
        .await
        .unwrap();

        assert_eq!(bytes, b"hello world");
    }

    #[tokio::test]
    async fn git_pull_invokes_pull_rebase() {
        let runner = FakeRunner::default();
        git_pull(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/state/git-askpass.sh"),
            "ghp_token",
            Duration::from_secs(2),
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["pull", "--rebase"]);
        assert_eq!(calls[0].cwd, PathBuf::from("/repo"));
    }

    #[tokio::test]
    async fn git_pull_passes_askpass_path_and_pat_via_env() {
        let runner = FakeRunner::default();
        git_pull(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/state/git-askpass.sh"),
            "ghp_token",
            Duration::from_secs(2),
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        let env: std::collections::HashMap<&str, &str> = calls[0]
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(env.get("GIT_ASKPASS"), Some(&"/state/git-askpass.sh"));
        assert_eq!(env.get("PROMPT_LIBRARY_PAT"), Some(&"ghp_token"));
    }

    #[tokio::test]
    async fn git_pull_never_leaks_pat_into_argv() {
        let runner = FakeRunner::default();
        let pat = "ghp_supersecrettoken1234567890abcdefghij";
        git_pull(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/askpass"),
            pat,
            Duration::from_secs(2),
        )
        .await
        .unwrap();

        for call in runner.captured_calls() {
            for arg in &call.args {
                assert!(!arg.contains(pat), "PAT leaked into argv: {arg:?}");
                assert!(!arg.contains("ghp_"), "ghp_ prefix in argv: {arg:?}");
            }
        }
    }

    #[tokio::test]
    async fn git_pull_returns_timed_out_when_runner_exceeds_timeout() {
        let runner = FakeRunner::default().with_delay(Duration::from_millis(500));
        let err = git_pull(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/askpass"),
            "ghp_token",
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, RunnerError::TimedOut),
            "expected TimedOut, got {err:?}",
        );
    }

    #[tokio::test]
    async fn git_pull_propagates_runner_failure() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 1,
            stdout: Vec::new(),
            stderr: b"error: cannot pull with rebase: You have unstaged changes.".to_vec(),
        });

        let err = git_pull(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/askpass"),
            "ghp_token",
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();

        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 1);
                assert!(stderr.contains("unstaged changes"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_push_with_upstream_invokes_push_dash_u_origin_branch() {
        let runner = FakeRunner::default();
        git_push_with_upstream(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/state/git-askpass.sh"),
            "ghp_token",
            "main",
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["push", "-u", "origin", "main"]);
    }

    #[tokio::test]
    async fn git_push_with_upstream_passes_pat_via_env_only() {
        let runner = FakeRunner::default();
        let pat = "ghp_supersecrettoken1234567890abcdefghij";
        git_push_with_upstream(
            &runner,
            &PathBuf::from("/repo"),
            &PathBuf::from("/state/git-askpass.sh"),
            pat,
            "feature/x",
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        let env: std::collections::HashMap<&str, &str> = calls[0]
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(env.get("GIT_ASKPASS"), Some(&"/state/git-askpass.sh"));
        assert_eq!(env.get("PROMPT_LIBRARY_PAT"), Some(&pat));
        for arg in &calls[0].args {
            assert!(!arg.contains("ghp_"), "PAT leaked into argv: {arg:?}");
        }
    }

    #[tokio::test]
    async fn current_branch_returns_trimmed_stdout() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"main\n".to_vec(),
            stderr: Vec::new(),
        });
        let branch = current_branch(&runner, &PathBuf::from("/repo")).await.unwrap();
        assert_eq!(branch, "main");

        let calls = runner.captured_calls();
        assert_eq!(calls[0].args, vec!["rev-parse", "--abbrev-ref", "HEAD"]);
    }

    #[tokio::test]
    async fn remote_branch_exists_status_zero_returns_true() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 0,
            stdout: b"abcdef0123\n".to_vec(),
            stderr: Vec::new(),
        });
        let exists = remote_branch_exists(&runner, &PathBuf::from("/repo"), "main")
            .await
            .unwrap();
        assert!(exists);

        let calls = runner.captured_calls();
        assert_eq!(
            calls[0].args,
            vec!["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
        );
    }

    #[tokio::test]
    async fn remote_branch_exists_status_one_quiet_returns_false() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 1,
            stdout: Vec::new(),
            stderr: Vec::new(),
        });
        let exists = remote_branch_exists(&runner, &PathBuf::from("/repo"), "main")
            .await
            .unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn remote_branch_exists_unexpected_failure_propagates() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: not a git repository".to_vec(),
        });
        let err = remote_branch_exists(&runner, &PathBuf::from("/repo"), "main")
            .await
            .unwrap_err();
        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 128);
                assert!(stderr.contains("not a git repository"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_commit_invokes_commit_dash_f_stdin() {
        let runner = FakeRunner::default();
        let ok = git_commit(&runner, &PathBuf::from("/repo"), "first commit")
            .await
            .unwrap();
        assert!(ok);

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["commit", "-F", "-"]);
        assert_eq!(calls[0].stdin.as_deref(), Some(b"first commit".as_slice()));
        assert_eq!(calls[0].cwd, PathBuf::from("/repo"));
    }

    #[tokio::test]
    async fn git_commit_never_passes_message_via_argv() {
        let runner = FakeRunner::default();
        let secret_looking_msg = "ghp_supersecrettoken1234567890abcdefghij in notes";
        git_commit(&runner, &PathBuf::from("/repo"), secret_looking_msg)
            .await
            .unwrap();

        for call in runner.captured_calls() {
            for arg in &call.args {
                assert!(
                    !arg.contains("ghp_"),
                    "commit message leaked into argv: {arg:?}"
                );
                assert!(
                    !arg.contains("notes"),
                    "commit message leaked into argv: {arg:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn git_commit_treats_nothing_to_commit_as_ok_false() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 1,
            stdout: b"On branch main\nnothing to commit, working tree clean\n".to_vec(),
            stderr: Vec::new(),
        });

        let committed = git_commit(&runner, &PathBuf::from("/repo"), "noop")
            .await
            .unwrap();
        assert!(!committed, "nothing-to-commit should be Ok(false)");
    }

    #[tokio::test]
    async fn git_commit_propagates_other_failures() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: not a git repository".to_vec(),
        });

        let err = git_commit(&runner, &PathBuf::from("/repo"), "msg")
            .await
            .unwrap_err();
        match err {
            RunnerError::Failed { status, stderr } => {
                assert_eq!(status, 128);
                assert!(stderr.contains("not a git repository"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_add_invokes_add_dashdash_with_paths() {
        let runner = FakeRunner::default();
        git_add(
            &runner,
            &PathBuf::from("/repo"),
            &["versions/v1", "metadata.yaml", "current.txt"],
        )
        .await
        .unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].args,
            vec![
                "add",
                "--",
                "versions/v1",
                "metadata.yaml",
                "current.txt",
            ],
        );
    }

    #[tokio::test]
    async fn git_add_empty_paths_is_noop() {
        let runner = FakeRunner::default();
        git_add(&runner, &PathBuf::from("/repo"), &[]).await.unwrap();
        assert!(
            runner.captured_calls().is_empty(),
            "empty paths must not invoke git",
        );
    }

    #[tokio::test]
    async fn git_add_all_invokes_add_dash_a() {
        let runner = FakeRunner::default();
        git_add_all(&runner, &PathBuf::from("/repo")).await.unwrap();

        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args, vec!["add", "-A"]);
    }

    #[tokio::test]
    async fn integration_init_add_commit_produces_real_commit() {
        use crate::runner::TokioProcessRunner;
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");

        let runner = TokioProcessRunner::new();
        git_init(&runner, &repo).await.unwrap();

        // Set identity locally so commit doesn't depend on global config.
        let cfg_email = runner
            .run(&["config", "user.email", "test@example.com"], &repo, &[])
            .await
            .unwrap();
        assert_eq!(cfg_email.status, 0);
        let cfg_name = runner
            .run(&["config", "user.name", "Test"], &repo, &[])
            .await
            .unwrap();
        assert_eq!(cfg_name.status, 0);

        std::fs::write(repo.join("hello.txt"), b"hello\n").unwrap();
        git_add_all(&runner, &repo).await.unwrap();
        let committed = git_commit(&runner, &repo, "Initial commit").await.unwrap();
        assert!(committed);

        // `git log -1 --format=%s` reads back the most recent commit
        // subject — verifies the message round-tripped through stdin.
        let log = runner
            .run(&["log", "-1", "--format=%s"], &repo, &[])
            .await
            .unwrap();
        assert_eq!(log.status, 0);
        let subject = String::from_utf8(log.stdout).unwrap();
        assert_eq!(subject.trim(), "Initial commit");
    }

    #[tokio::test]
    async fn integration_commit_with_nothing_staged_returns_ok_false() {
        use crate::runner::TokioProcessRunner;
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");

        let runner = TokioProcessRunner::new();
        git_init(&runner, &repo).await.unwrap();
        runner
            .run(&["config", "user.email", "test@example.com"], &repo, &[])
            .await
            .unwrap();
        runner
            .run(&["config", "user.name", "Test"], &repo, &[])
            .await
            .unwrap();

        let committed = git_commit(&runner, &repo, "empty").await.unwrap();
        assert!(!committed, "fresh repo with no staging should be Ok(false)");
    }

    #[tokio::test]
    async fn git_show_blob_propagates_failure() {
        use crate::runner::CommandOutput;
        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: path 'gone.md' does not exist".to_vec(),
        });

        let err = git_show_blob(
            &runner,
            &PathBuf::from("/repo"),
            "HEAD",
            &PathBuf::from("gone.md"),
        )
        .await
        .unwrap_err();

        match err {
            RunnerError::Failed { status, .. } => assert_eq!(status, 128),
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
