use camino::{Utf8Path, Utf8PathBuf};

use crate::Target;

/// Holds the home directory the install tree is rooted at.
///
/// Constructed with an explicit home so tests can inject a `tempfile::TempDir`
/// root and the production caller (Tauri command layer) passes
/// `app.path().home_dir()`. This is the env binding `KindTarget::path_for`
/// resolves against — pure path math lives there, this struct just holds the
/// root.
#[derive(Debug, Clone)]
pub struct InstallPaths {
    home: Utf8PathBuf,
}

impl InstallPaths {
    pub fn new(home: impl Into<Utf8PathBuf>) -> Self {
        Self { home: home.into() }
    }

    pub fn home(&self) -> &Utf8Path {
        &self.home
    }

    /// All install roots (parent directories) the Phase-5 scanner enumerates
    /// for `target`. Order matches the install matrix for that target.
    pub fn roots_for(&self, target: Target) -> Vec<Utf8PathBuf> {
        match target {
            Target::Claude => vec![
                self.home.join(".claude/skills"),
                self.home.join(".claude/agents"),
                self.home.join(".claude/commands"),
            ],
            Target::Pi => vec![
                self.home.join(".pi/agent/skills"),
                self.home.join(".pi/agent/agents"),
                self.home.join(".pi/agent/prompts"),
            ],
            Target::Codex => vec![
                self.home.join(".codex/skills"),
                self.home.join(".codex/prompts"),
                self.home.join(".codex/agents"),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> InstallPaths {
        InstallPaths::new("/home/test")
    }

    #[test]
    fn home_returns_the_configured_root() {
        let p = paths();
        assert_eq!(p.home(), Utf8Path::new("/home/test"));
    }

    #[test]
    fn roots_for_claude_lists_skills_agents_commands() {
        let p = paths();
        assert_eq!(
            p.roots_for(Target::Claude),
            vec![
                Utf8PathBuf::from("/home/test/.claude/skills"),
                Utf8PathBuf::from("/home/test/.claude/agents"),
                Utf8PathBuf::from("/home/test/.claude/commands"),
            ],
        );
    }

    #[test]
    fn roots_for_pi_lists_skills_agents_prompts() {
        let p = paths();
        assert_eq!(
            p.roots_for(Target::Pi),
            vec![
                Utf8PathBuf::from("/home/test/.pi/agent/skills"),
                Utf8PathBuf::from("/home/test/.pi/agent/agents"),
                Utf8PathBuf::from("/home/test/.pi/agent/prompts"),
            ],
        );
    }

    #[test]
    fn roots_for_codex_lists_skills_prompts_agents() {
        let p = paths();
        assert_eq!(
            p.roots_for(Target::Codex),
            vec![
                Utf8PathBuf::from("/home/test/.codex/skills"),
                Utf8PathBuf::from("/home/test/.codex/prompts"),
                Utf8PathBuf::from("/home/test/.codex/agents"),
            ],
        );
    }
}
