use std::collections::HashMap;

use camino::Utf8PathBuf;

use crate::{OverlayBytes, Target};

/// Deterministic overlay resolution: produce the effective file set for a
/// `(version, target)` pair. Target-overlay files shadow base files at the
/// same relative path. Pure; no FS access; no `Result` — overlay merge can't
/// fail.
pub fn merge(overlay: &OverlayBytes, target: Target) -> HashMap<Utf8PathBuf, Vec<u8>> {
    let mut effective = overlay.base.clone();
    if let Some(target_files) = overlay.targets.get(&target) {
        for (rel, bytes) in target_files {
            effective.insert(rel.clone(), bytes.clone());
        }
    }
    effective
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8Path;

    fn rel(p: &str) -> Utf8PathBuf {
        Utf8Path::new(p).to_owned()
    }

    fn overlay() -> OverlayBytes {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("SKILL.md"), b"base body".to_vec());
        o.base.insert(rel("shared.md"), b"shared".to_vec());

        let mut claude = HashMap::new();
        claude.insert(rel("SKILL.md"), b"claude override".to_vec());
        o.targets.insert(Target::Claude, claude);

        let mut pi = HashMap::new();
        pi.insert(rel("pi-only.md"), b"pi extra".to_vec());
        o.targets.insert(Target::Pi, pi);

        o
    }

    #[test]
    fn target_with_no_overlay_returns_base_only() {
        let merged = merge(&overlay(), Target::Codex);
        assert_eq!(merged[&rel("SKILL.md")], b"base body");
        assert_eq!(merged[&rel("shared.md")], b"shared");
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn target_overlay_shadows_base_on_conflict() {
        let merged = merge(&overlay(), Target::Claude);
        assert_eq!(merged[&rel("SKILL.md")], b"claude override");
        assert_eq!(merged[&rel("shared.md")], b"shared");
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn target_can_introduce_new_files() {
        let merged = merge(&overlay(), Target::Pi);
        assert_eq!(merged[&rel("SKILL.md")], b"base body");
        assert_eq!(merged[&rel("shared.md")], b"shared");
        assert_eq!(merged[&rel("pi-only.md")], b"pi extra");
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn empty_overlay_yields_empty_map() {
        let o = OverlayBytes::default();
        let merged = merge(&o, Target::Claude);
        assert!(merged.is_empty());
    }

    #[test]
    fn merge_does_not_mutate_input() {
        let o = overlay();
        let _ = merge(&o, Target::Claude);
        assert_eq!(o.base[&rel("SKILL.md")], b"base body");
        assert_eq!(
            o.targets[&Target::Claude][&rel("SKILL.md")],
            b"claude override"
        );
    }
}
