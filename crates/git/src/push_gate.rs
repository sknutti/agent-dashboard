//! Pre-push secret-scan gate. Walks a list of (path, bytes) pairs and
//! returns every secret finding across them. Caller decides whether to
//! block the push (typically: any findings → block until reviewed).

use crate::file_scan::{scan_file, FileFinding};
use crate::git_ops::{git_diff_changed_files, git_show_blob};
use crate::runner::{GitRunner, RunnerError};
use std::path::Path;

pub fn scan_for_push(files: &[(&Path, &[u8])]) -> Vec<FileFinding> {
    files
        .iter()
        .flat_map(|(path, bytes)| scan_file(path, bytes))
        .collect()
}

/// I/O-driven counterpart to [`scan_for_push`]: enumerate the paths
/// added or modified across `range`, fetch each blob at `HEAD`, and
/// scan them.
///
/// `range` is any valid git revision range (e.g. `origin/main..HEAD`,
/// or the empty-tree hash `4b825dc...:HEAD` for first push). Caller
/// decides whether non-empty findings should block the push or be
/// surfaced to UI for an explicit override.
pub async fn scan_pending_push<R: GitRunner>(
    runner: &R,
    repo_dir: &Path,
    range: &str,
) -> Result<Vec<FileFinding>, RunnerError> {
    let paths = git_diff_changed_files(runner, repo_dir, range).await?;
    let mut blobs: Vec<Vec<u8>> = Vec::with_capacity(paths.len());
    for path in &paths {
        blobs.push(git_show_blob(runner, repo_dir, "HEAD", path).await?);
    }
    let pairs: Vec<(&Path, &[u8])> = paths
        .iter()
        .zip(blobs.iter())
        .map(|(p, b)| (p.as_path(), b.as_slice()))
        .collect();
    Ok(scan_for_push(&pairs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_finding_from_a_single_dirty_file() {
        use crate::secret_scan::FindingKind;
        use std::path::Path;

        let token = format!("ghp_{}", "a".repeat(36));
        let path = Path::new("CLAUDE.md");
        let bytes = token.as_bytes();

        let findings = scan_for_push(&[(path, bytes)]);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].path, path);
        assert_eq!(findings[0].line, 1);
        assert_eq!(findings[0].finding.kind, FindingKind::GithubClassicPat);
    }

    #[test]
    fn empty_file_list_returns_no_findings() {
        assert_eq!(scan_for_push(&[]), vec![]);
    }

    #[tokio::test]
    async fn scan_pending_push_no_changed_files_returns_empty() {
        use crate::runner::FakeRunner;
        use std::path::PathBuf;

        let runner = FakeRunner::default();
        let findings = scan_pending_push(&runner, &PathBuf::from("/repo"), "x..HEAD")
            .await
            .unwrap();

        assert!(findings.is_empty());
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args[0], "diff");
    }

    #[tokio::test]
    async fn scan_pending_push_diffs_then_shows_each_file() {
        use crate::runner::{CommandOutput, FakeRunner};
        use std::path::PathBuf;

        let runner = FakeRunner::default().with_response_queue(vec![
            CommandOutput {
                status: 0,
                stdout: b"a.md\0b.md\0".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: b"clean content".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: b"also clean".to_vec(),
                stderr: Vec::new(),
            },
        ]);

        let findings = scan_pending_push(&runner, &PathBuf::from("/repo"), "x..HEAD")
            .await
            .unwrap();

        assert!(findings.is_empty());
        let calls = runner.captured_calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].args[0], "diff");
        assert_eq!(calls[1].args, vec!["show", "HEAD:a.md"]);
        assert_eq!(calls[2].args, vec!["show", "HEAD:b.md"]);
    }

    #[tokio::test]
    async fn scan_pending_push_surfaces_planted_secret() {
        use crate::runner::{CommandOutput, FakeRunner};
        use crate::secret_scan::FindingKind;
        use std::path::PathBuf;

        let token = format!("ghp_{}", "a".repeat(36));
        let dirty = format!("intro\n{token}\n");

        let runner = FakeRunner::default().with_response_queue(vec![
            CommandOutput {
                status: 0,
                stdout: b"clean.md\0CLAUDE.md\0".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: b"nothing interesting here".to_vec(),
                stderr: Vec::new(),
            },
            CommandOutput {
                status: 0,
                stdout: dirty.into_bytes(),
                stderr: Vec::new(),
            },
        ]);

        let findings = scan_pending_push(&runner, &PathBuf::from("/repo"), "origin/main..HEAD")
            .await
            .unwrap();

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].path, PathBuf::from("CLAUDE.md"));
        assert_eq!(findings[0].line, 2);
        assert_eq!(findings[0].finding.kind, FindingKind::GithubClassicPat);
    }

    #[tokio::test]
    async fn scan_pending_push_propagates_diff_failure() {
        use crate::runner::{CommandOutput, FakeRunner};
        use std::path::PathBuf;

        let runner = FakeRunner::default().with_response(CommandOutput {
            status: 128,
            stdout: Vec::new(),
            stderr: b"fatal: bad revision".to_vec(),
        });

        let err = scan_pending_push(&runner, &PathBuf::from("/repo"), "bogus..HEAD")
            .await
            .unwrap_err();

        match err {
            RunnerError::Failed { status, .. } => assert_eq!(status, 128),
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
