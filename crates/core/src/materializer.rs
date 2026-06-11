use std::collections::HashMap;

use camino::{Utf8Path, Utf8PathBuf};

use crate::kind_target::InstallLayout;
use crate::{is_ignored, overlay_merge, Error, OverlayBytes, PrimitiveKind, PrimitiveName, Target};

/// Output of materialization: the bytes for a `(version, target)` pair plus
/// the on-disk layout the installer should produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Materialized {
    /// Effective files keyed by path *within the install destination*.
    /// When `layout` is `SingleFile`, this contains exactly one entry whose
    /// bytes should be written directly at the install path (no enclosing
    /// directory).
    pub files: HashMap<Utf8PathBuf, Vec<u8>>,
    /// On-disk layout for this `(kind, target)` and bundle. Static for 7 of
    /// 8 KindTargets; for `(Agent, Claude)` it depends on whether the
    /// effective tree is exactly `{ "agent.md": <bytes> }`.
    pub layout: InstallLayout,
}

const AGENT_MD: &str = "agent.md";

/// Pure: deterministic given inputs, no FS access.
///
/// Steps:
/// 1. Reject if `target` not in `allowed_targets`.
/// 2. Merge `overlay.base` with `overlay.targets[target]` (target shadows base).
/// 3. Drop any files whose path matches an ignore rule (defensive — callers
///    that build `OverlayBytes` from disk via `WorkingCopy`/`VersionStore`
///    have already filtered, but this guards against in-memory construction).
/// 4. Resolve `InstallLayout`: for `(Agent, Claude)` the bundle decides
///    (single `agent.md` → `SingleFile`, anything else → `Directory`); for
///    every other KindTarget the layout is fixed by the matrix.
pub fn materialize(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    allowed_targets: &[Target],
    overlay: &OverlayBytes,
    target: Target,
) -> Result<Materialized, Error> {
    if !allowed_targets.contains(&target) {
        return Err(Error::TargetNotAllowed {
            primitive: name.as_str().into(),
            target,
        });
    }

    let merged = overlay_merge::merge(overlay, target);

    let files: HashMap<Utf8PathBuf, Vec<u8>> = merged
        .into_iter()
        .filter(|(path, _)| !is_ignored(path))
        .collect();

    let layout = match (kind, target) {
        (PrimitiveKind::Agent, Target::Claude) => {
            if files.len() == 1 && files.contains_key(Utf8Path::new(AGENT_MD)) {
                InstallLayout::SingleFile
            } else {
                InstallLayout::Directory
            }
        }
        (PrimitiveKind::Command, _) | (PrimitiveKind::CodexAgent, _) => InstallLayout::SingleFile,
        _ => InstallLayout::Directory,
    };

    Ok(Materialized { files, layout })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> Utf8PathBuf {
        Utf8Path::new(p).to_owned()
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn skill_overlay() -> OverlayBytes {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("SKILL.md"), b"base body".to_vec());
        let mut claude = HashMap::new();
        claude.insert(rel("SKILL.md"), b"claude override".to_vec());
        o.targets.insert(Target::Claude, claude);
        o
    }

    #[test]
    fn skill_for_claude_returns_claude_override() {
        let o = skill_overlay();
        let m = materialize(
            PrimitiveKind::Skill,
            &name("diagnose"),
            &[Target::Claude, Target::Pi],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert_eq!(m.files[&rel("SKILL.md")], b"claude override");
        assert_eq!(
            m.layout,
            InstallLayout::Directory,
            "skills are always Directory"
        );
    }

    #[test]
    fn skill_for_pi_falls_back_to_base() {
        let o = skill_overlay();
        let m = materialize(
            PrimitiveKind::Skill,
            &name("diagnose"),
            &[Target::Claude, Target::Pi],
            &o,
            Target::Pi,
        )
        .unwrap();
        assert_eq!(m.files[&rel("SKILL.md")], b"base body");
    }

    #[test]
    fn target_not_allowed_returns_error() {
        let o = skill_overlay();
        let err = materialize(
            PrimitiveKind::Skill,
            &name("diagnose"),
            &[Target::Pi], // claude not allowed
            &o,
            Target::Claude,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            Error::TargetNotAllowed { primitive, target: Target::Claude } if primitive == "diagnose"
        ));
    }

    #[test]
    fn agent_claude_single_file_flattens() {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("agent.md"), b"agent body".to_vec());
        let m = materialize(
            PrimitiveKind::Agent,
            &name("helper"),
            &[Target::Claude],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert_eq!(
            m.layout,
            InstallLayout::SingleFile,
            "(Agent, Claude) with sole agent.md flattens to SingleFile"
        );
        assert_eq!(m.files[&rel("agent.md")], b"agent body");
        assert_eq!(m.files.len(), 1);
    }

    #[test]
    fn agent_claude_with_extra_files_does_not_flatten() {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("agent.md"), b"agent body".to_vec());
        o.base.insert(rel("scripts/run.sh"), b"#!/bin/sh\n".to_vec());
        let m = materialize(
            PrimitiveKind::Agent,
            &name("helper"),
            &[Target::Claude],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert_eq!(
            m.layout,
            InstallLayout::Directory,
            "extra files block flatten — layout stays Directory"
        );
        assert_eq!(m.files.len(), 2);
    }

    #[test]
    fn agent_pi_never_flattens_even_with_single_agent_md() {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("agent.md"), b"agent body".to_vec());
        let m = materialize(
            PrimitiveKind::Agent,
            &name("helper"),
            &[Target::Pi],
            &o,
            Target::Pi,
        )
        .unwrap();
        assert_eq!(
            m.layout,
            InstallLayout::Directory,
            "flatten only fires for Claude — Pi is always Directory"
        );
    }

    #[test]
    fn ignored_files_are_dropped_defensively() {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("SKILL.md"), b"good".to_vec());
        o.base.insert(rel(".DS_Store"), b"junk".to_vec());
        o.base.insert(rel("nested/._junk.md"), b"junk".to_vec());
        let m = materialize(
            PrimitiveKind::Skill,
            &name("x"),
            &[Target::Claude],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert!(m.files.contains_key(&rel("SKILL.md")));
        assert!(!m.files.contains_key(&rel(".DS_Store")));
        assert!(!m.files.contains_key(&rel("nested/._junk.md")));
    }

    #[test]
    fn round_trip_identity_across_targets() {
        // A skill with byte-identical content shared via base only;
        // re-materializing for each allowed target reproduces the same bytes.
        let mut o = OverlayBytes::default();
        o.base.insert(rel("SKILL.md"), b"shared body".to_vec());
        o.base.insert(rel("notes.md"), b"shared notes".to_vec());

        let allowed = [Target::Claude, Target::Pi, Target::Codex];
        for &target in &allowed {
            let m = materialize(
                PrimitiveKind::Skill,
                &name("identity"),
                &allowed,
                &o,
                target,
            )
            .unwrap();
            assert_eq!(m.files[&rel("SKILL.md")], b"shared body");
            assert_eq!(m.files[&rel("notes.md")], b"shared notes");
        }
    }

    #[test]
    fn target_only_files_appear_only_for_that_target() {
        let mut o = OverlayBytes::default();
        o.base.insert(rel("SKILL.md"), b"base".to_vec());
        let mut claude = HashMap::new();
        claude.insert(rel("claude-only.md"), b"claude extra".to_vec());
        o.targets.insert(Target::Claude, claude);

        let claude_m = materialize(
            PrimitiveKind::Skill,
            &name("x"),
            &[Target::Claude, Target::Pi],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert!(claude_m.files.contains_key(&rel("claude-only.md")));

        let pi_m = materialize(
            PrimitiveKind::Skill,
            &name("x"),
            &[Target::Claude, Target::Pi],
            &o,
            Target::Pi,
        )
        .unwrap();
        assert!(!pi_m.files.contains_key(&rel("claude-only.md")));
    }

    #[test]
    fn empty_overlay_yields_empty_materialization() {
        let o = OverlayBytes::default();
        let m = materialize(
            PrimitiveKind::Skill,
            &name("empty"),
            &[Target::Claude],
            &o,
            Target::Claude,
        )
        .unwrap();
        assert!(m.files.is_empty());
        // Skill is always Directory; (Agent, Claude) with empty bundle fails the
        // "exactly one agent.md" predicate so it falls through to Directory too.
        assert_eq!(m.layout, InstallLayout::Directory);
    }

    #[test]
    fn materialize_does_not_mutate_overlay() {
        let original = skill_overlay();
        let snapshot = original.clone();
        let _ = materialize(
            PrimitiveKind::Skill,
            &name("x"),
            &[Target::Claude, Target::Pi],
            &original,
            Target::Claude,
        )
        .unwrap();
        assert_eq!(original, snapshot, "materialize must be pure");
    }
}
