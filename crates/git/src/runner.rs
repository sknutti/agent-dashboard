//! Abstraction over invoking the system `git` binary so call sites can be
//! unit-tested without spawning real processes. The real implementation
//! lives below; tests use [`FakeRunner`].

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    pub fn success() -> Self {
        Self {
            status: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("git exited with status {status}: {stderr}")]
    Failed { status: i32, stderr: String },
    #[error("failed to spawn git: {0}")]
    Spawn(String),
    #[error("git timed out")]
    TimedOut,
}

pub trait GitRunner: Send + Sync {
    fn run(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send;

    /// Run git with `stdin` bytes piped into the child process. Used by
    /// commit-message delivery (`commit -F -`) so messages bypass argv
    /// length limits and never get stripped by the shell.
    fn run_with_stdin(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
        stdin: &[u8],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send;
}

/// Default runner that shells out to the system `git` via [`tokio::process`].
#[derive(Debug, Default, Clone, Copy)]
pub struct TokioProcessRunner;

impl TokioProcessRunner {
    pub fn new() -> Self {
        Self
    }
}

/// Augment the inherited `PATH` with common Unix bin directories.
///
/// macOS GUI apps (anything launched via `launchd`/Finder/Dock rather than a
/// terminal) inherit a stripped PATH that omits Homebrew locations, so a bare
/// `Command::new("git")` fails with ENOENT even when git is installed. We
/// always append fallbacks rather than replacing — the caller's environment
/// stays authoritative; we only widen the search.
fn augmented_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    for fallback in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        if !parts.iter().any(|p| p == fallback) {
            parts.push(fallback.to_string());
        }
    }
    parts.join(":")
}

impl GitRunner for TokioProcessRunner {
    fn run(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let cwd = cwd.to_path_buf();
        let path_override = if env.iter().any(|(k, _)| *k == "PATH") {
            None
        } else {
            Some(augmented_path())
        };
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        async move {
            let mut cmd = tokio::process::Command::new("git");
            cmd.args(&args).current_dir(&cwd);
            if let Some(p) = path_override {
                cmd.env("PATH", p);
            }
            for (k, v) in &env {
                cmd.env(k, v);
            }
            let output = cmd
                .output()
                .await
                .map_err(|e| RunnerError::Spawn(e.to_string()))?;
            Ok(CommandOutput {
                status: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        }
    }

    fn run_with_stdin(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
        stdin: &[u8],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let cwd = cwd.to_path_buf();
        let path_override = if env.iter().any(|(k, _)| *k == "PATH") {
            None
        } else {
            Some(augmented_path())
        };
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let stdin_bytes = stdin.to_vec();
        async move {
            use tokio::io::AsyncWriteExt;
            let mut cmd = tokio::process::Command::new("git");
            cmd.args(&args).current_dir(&cwd);
            if let Some(p) = path_override {
                cmd.env("PATH", p);
            }
            for (k, v) in &env {
                cmd.env(k, v);
            }
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|e| RunnerError::Spawn(e.to_string()))?;
            if let Some(mut child_stdin) = child.stdin.take() {
                child_stdin
                    .write_all(&stdin_bytes)
                    .await
                    .map_err(|e| RunnerError::Spawn(format!("write stdin: {e}")))?;
                child_stdin
                    .shutdown()
                    .await
                    .map_err(|e| RunnerError::Spawn(format!("close stdin: {e}")))?;
            }
            let output = child
                .wait_with_output()
                .await
                .map_err(|e| RunnerError::Spawn(e.to_string()))?;
            Ok(CommandOutput {
                status: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        }
    }
}

#[cfg(test)]
mod tokio_runner_tests {
    use super::*;

    /// Sanity check that `run_with_stdin` on the real runner actually
    /// pipes bytes through stdin. We use `git hash-object --stdin` since
    /// it requires no repo and echoes back a deterministic hash for the
    /// piped content.
    #[tokio::test]
    async fn tokio_runner_pipes_stdin_to_git() {
        let tmp = tempfile::tempdir().unwrap();
        let runner = TokioProcessRunner::new();
        let output = runner
            .run_with_stdin(
                &["hash-object", "--stdin"],
                tmp.path(),
                &[],
                b"hello\n",
            )
            .await
            .unwrap();
        assert_eq!(output.status, 0, "stderr={:?}", String::from_utf8_lossy(&output.stderr));
        let hash = String::from_utf8(output.stdout).unwrap();
        // blob hash of "hello\n" is well-known.
        assert_eq!(hash.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    /// Verifies that the real runner forwards env vars to the child
    /// process. We use git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
    /// `GIT_CONFIG_VALUE_n` mechanism: setting these envs injects
    /// ad-hoc config that `git config --get` can read back. If the
    /// runner silently dropped env, `--get` would print nothing and
    /// exit with status 1.
    ///
    /// Pairs with the askpass/PAT path, which depends on env-only
    /// delivery — a regression here would let the PAT path break with
    /// no other test failing.
    #[tokio::test]
    async fn tokio_runner_forwards_env_to_git() {
        let tmp = tempfile::tempdir().unwrap();
        let runner = TokioProcessRunner::new();

        // `git config --get` needs to run inside a repo if scope isn't
        // forced — init a throwaway one.
        runner.run(&["init", "-q"], tmp.path(), &[]).await.unwrap();

        let env: &[(&str, &str)] = &[
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_CONFIG_KEY_0", "test.envprop"),
            ("GIT_CONFIG_VALUE_0", "fromenv"),
        ];
        let output = runner
            .run(&["config", "--get", "test.envprop"], tmp.path(), env)
            .await
            .unwrap();

        assert_eq!(
            output.status,
            0,
            "git config --get failed; env was not forwarded. stderr={:?}",
            String::from_utf8_lossy(&output.stderr),
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "fromenv");
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedCall {
    pub args: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub env: Vec<(String, String)>,
    pub stdin: Option<Vec<u8>>,
}

#[cfg(test)]
pub struct FakeRunner {
    response: std::sync::Mutex<CommandOutput>,
    queue: std::sync::Mutex<std::collections::VecDeque<CommandOutput>>,
    delay: std::sync::Mutex<Option<std::time::Duration>>,
    calls: std::sync::Mutex<Vec<CapturedCall>>,
}

#[cfg(test)]
impl FakeRunner {
    pub fn new() -> Self {
        Self {
            response: std::sync::Mutex::new(CommandOutput::success()),
            queue: std::sync::Mutex::new(std::collections::VecDeque::new()),
            delay: std::sync::Mutex::new(None),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn with_response(self, response: CommandOutput) -> Self {
        *self.response.lock().unwrap() = response;
        self
    }

    /// Enqueue per-call responses. Each `run` pops the next entry; once
    /// the queue empties, calls fall back to the default response set
    /// by [`Self::with_response`] (or [`CommandOutput::success`]).
    pub fn with_response_queue(self, responses: Vec<CommandOutput>) -> Self {
        *self.queue.lock().unwrap() = responses.into();
        self
    }

    /// Sleep for `delay` before returning each canned response. Pair
    /// with `#[tokio::test(start_paused = true)]` for instantaneous
    /// virtual-time advancement when testing timeout paths.
    pub fn with_delay(self, delay: std::time::Duration) -> Self {
        *self.delay.lock().unwrap() = Some(delay);
        self
    }

    pub fn captured_calls(&self) -> Vec<CapturedCall> {
        self.calls.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl Default for FakeRunner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl GitRunner for FakeRunner {
    fn run(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send {
        self.calls.lock().unwrap().push(CapturedCall {
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.to_path_buf(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            stdin: None,
        });
        let response = self
            .queue
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.response.lock().unwrap().clone());
        let delay = *self.delay.lock().unwrap();
        async move {
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            Ok(response)
        }
    }

    fn run_with_stdin(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
        stdin: &[u8],
    ) -> impl std::future::Future<Output = Result<CommandOutput, RunnerError>> + Send {
        self.calls.lock().unwrap().push(CapturedCall {
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.to_path_buf(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            stdin: Some(stdin.to_vec()),
        });
        let response = self
            .queue
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.response.lock().unwrap().clone());
        let delay = *self.delay.lock().unwrap();
        async move {
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            Ok(response)
        }
    }
}
