//! Idempotent installer for the git askpass helper script.
//!
//! Git invokes the program named by `GIT_ASKPASS` once per credential
//! prompt with the prompt text as `argv[1]`. Our helper answers
//! `x-access-token` for the Username prompt and `$PROMPT_LIBRARY_PAT`
//! for the Password prompt — keeping the PAT in env, never in argv.
//!
//! [`init_askpass_script`] is meant to be called at app launch. The
//! script body is fully static, so unconditional overwrite is safe and
//! avoids a "first push" race.

use std::io;
use std::path::{Path, PathBuf};

const SCRIPT_NAME: &str = "git-askpass.sh";
const SCRIPT_BODY: &str = "#!/bin/sh
case \"$1\" in
  Username*) echo \"x-access-token\" ;;
  Password*) echo \"$PROMPT_LIBRARY_PAT\" ;;
esac
";

#[derive(Debug, thiserror::Error)]
pub enum AskpassError {
    #[error("failed to create state dir {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to install askpass script at {path}: {source}")]
    Install {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Install the askpass helper at `state_dir/git-askpass.sh`.
///
/// Creates `state_dir` if missing. Writes atomically via a `.tmp`
/// sibling + rename so a partial write is never observable at the
/// final path. Returns the final path.
pub fn init_askpass_script(state_dir: &Path) -> Result<PathBuf, AskpassError> {
    std::fs::create_dir_all(state_dir).map_err(|source| AskpassError::CreateDir {
        path: state_dir.to_path_buf(),
        source,
    })?;
    let final_path = state_dir.join(SCRIPT_NAME);
    let tmp_path = state_dir.join(format!("{SCRIPT_NAME}.tmp"));

    let install = || -> io::Result<()> {
        std::fs::write(&tmp_path, SCRIPT_BODY)?;
        set_executable(&tmp_path)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(())
    };
    install().map_err(|source| AskpassError::Install {
        path: final_path.clone(),
        source,
    })?;
    Ok(final_path)
}

#[cfg(unix)]
fn set_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn installs_script_with_expected_body() {
        let tmp = TempDir::new().unwrap();
        let path = init_askpass_script(tmp.path()).unwrap();

        assert_eq!(path, tmp.path().join("git-askpass.sh"));
        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body, SCRIPT_BODY);
    }

    #[test]
    fn body_does_not_embed_the_pat_value() {
        // Defensive: the PAT must come from env at runtime, never be
        // substituted into the script body.
        assert!(SCRIPT_BODY.contains("$PROMPT_LIBRARY_PAT"));
        assert!(!SCRIPT_BODY.contains("ghp_"));
        assert!(!SCRIPT_BODY.contains("github_pat_"));
    }

    #[test]
    fn creates_state_dir_if_missing() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("a").join("b");
        let path = init_askpass_script(&nested).unwrap();
        assert!(path.exists());
        assert!(nested.is_dir());
    }

    #[test]
    fn idempotent_overwrite_leaves_no_tmp_behind() {
        let tmp = TempDir::new().unwrap();
        let p1 = init_askpass_script(tmp.path()).unwrap();
        let p2 = init_askpass_script(tmp.path()).unwrap();

        assert_eq!(p1, p2);
        assert_eq!(std::fs::read_to_string(&p1).unwrap(), SCRIPT_BODY);
        assert!(!tmp.path().join("git-askpass.sh.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn installed_script_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let path = init_askpass_script(tmp.path()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "expected user/group/other exec bits set, got mode={mode:o}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn script_returns_x_access_token_for_username_prompt() {
        let tmp = TempDir::new().unwrap();
        let path = init_askpass_script(tmp.path()).unwrap();

        let out = std::process::Command::new(&path)
            .arg("Username for 'https://github.com': ")
            .output()
            .unwrap();
        assert!(out.status.success(), "stderr={:?}", out.stderr);
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "x-access-token\n");
    }

    #[cfg(unix)]
    #[test]
    fn script_returns_pat_from_env_for_password_prompt() {
        let tmp = TempDir::new().unwrap();
        let path = init_askpass_script(tmp.path()).unwrap();

        let out = std::process::Command::new(&path)
            .arg("Password for 'https://x-access-token@github.com': ")
            .env("PROMPT_LIBRARY_PAT", "ghp_fixturetoken")
            .output()
            .unwrap();
        assert!(out.status.success(), "stderr={:?}", out.stderr);
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "ghp_fixturetoken\n");
    }

    #[cfg(unix)]
    #[test]
    fn script_emits_nothing_for_unknown_prompt() {
        let tmp = TempDir::new().unwrap();
        let path = init_askpass_script(tmp.path()).unwrap();

        let out = std::process::Command::new(&path)
            .arg("totally unrelated prompt")
            .output()
            .unwrap();
        assert!(out.status.success(), "stderr={:?}", out.stderr);
        assert!(out.stdout.is_empty(), "stdout={:?}", out.stdout);
    }
}
