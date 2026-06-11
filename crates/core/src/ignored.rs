use camino::Utf8Path;

/// Files and directories that the materializer, scanner, and installer
/// all silently drop. Single source of truth.
///
/// Returns `true` if `path` (or any segment of it) matches an ignore rule.
pub fn is_ignored(path: &Utf8Path) -> bool {
    path.components().any(|c| segment_matches(c.as_str()))
}

fn segment_matches(s: &str) -> bool {
    matches!(s, ".DS_Store" | "Thumbs.db" | ".git")
        || s.starts_with("._")
        || s.ends_with('~')
        || s.ends_with(".swp")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ignored(p: &str) -> bool {
        is_ignored(Utf8Path::new(p))
    }

    #[test]
    fn ignores_ds_store_at_root() {
        assert!(ignored(".DS_Store"));
    }

    #[test]
    fn ignores_ds_store_nested() {
        assert!(ignored("base/sub/.DS_Store"));
    }

    #[test]
    fn ignores_thumbs_db() {
        assert!(ignored("Thumbs.db"));
        assert!(ignored("base/Thumbs.db"));
    }

    #[test]
    fn ignores_apple_metadata_files() {
        assert!(ignored("._foo"));
        assert!(ignored("base/._foo.md"));
    }

    #[test]
    fn ignores_backup_tilde() {
        assert!(ignored("foo~"));
        assert!(ignored("base/file.md~"));
    }

    #[test]
    fn ignores_swap_files() {
        assert!(ignored("foo.swp"));
        assert!(ignored(".foo.md.swp"));
    }

    #[test]
    fn ignores_git_dir_anywhere_in_path() {
        assert!(ignored(".git"));
        assert!(ignored(".git/HEAD"));
        assert!(ignored("nested/.git/objects"));
    }

    #[test]
    fn does_not_ignore_normal_files() {
        assert!(!ignored("README.md"));
        assert!(!ignored("base/agent.md"));
        assert!(!ignored("targets/claude/SKILL.md"));
        assert!(!ignored("metadata.yaml"));
    }

    #[test]
    fn does_not_ignore_swp_substring() {
        assert!(!ignored("not-swp.md"));
        assert!(!ignored("swp_thing.md"));
    }
}
