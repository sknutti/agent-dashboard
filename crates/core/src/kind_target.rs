//! KindTarget — the typed seam every "where does this go on disk?" question
//! routes through.
//!
//! Per CONTEXT.md, a KindTarget is a legal `(Kind, Target)` pair backed by a
//! static table — it cannot represent an unsupported combination. Construction
//! (`KindTarget::new`) is the single source of truth for the install matrix;
//! `path_for` is therefore infallible.
//!
//! `InstallLayout` is the on-disk shape of the materialized primitive:
//! `SingleFile` (e.g. `<root>/<name>.md`) or `Directory` (e.g. `<root>/<name>/`).
//! Static for 7 of 8 KindTargets; `(Agent, Claude)` is adaptive based on the
//! materialized bundle shape.
//!
//! Layout is supplied to `path_for` from one of two sources:
//! - install-time: `Materialized::layout` (the materializer decides)
//! - uninstall/drift-time: `InstallRecord::layout()` (the record shape implies it)

use camino::Utf8PathBuf;

use crate::install_paths::InstallPaths;
use crate::{PrimitiveKind, PrimitiveName, Target};

/// On-disk shape of a Materialized Primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InstallLayout {
    SingleFile,
    Directory,
}

/// A legal `(Kind, Target)` pair. Constructible only for combinations in the
/// install matrix — having a value is a typed proof the pair is supported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KindTarget {
    kind: PrimitiveKind,
    target: Target,
}

impl KindTarget {
    /// Construct a KindTarget for a legal pair. Returns `None` for any
    /// combination outside the install matrix.
    pub fn new(kind: PrimitiveKind, target: Target) -> Option<Self> {
        match (kind, target) {
            (PrimitiveKind::Skill, Target::Claude)
            | (PrimitiveKind::Skill, Target::Pi)
            | (PrimitiveKind::Skill, Target::Codex)
            | (PrimitiveKind::Agent, Target::Claude)
            | (PrimitiveKind::Agent, Target::Pi)
            | (PrimitiveKind::Command, Target::Claude)
            | (PrimitiveKind::Command, Target::Pi)
            | (PrimitiveKind::Command, Target::Codex)
            | (PrimitiveKind::CodexAgent, Target::Codex) => Some(Self { kind, target }),
            _ => None,
        }
    }

    /// All legal KindTargets, in deterministic order. Matrix iteration entry
    /// point — sites previously walking `PrimitiveKind::ALL × Target::ALL`
    /// with a legality check should walk this instead.
    pub fn all() -> impl Iterator<Item = KindTarget> {
        const PAIRS: &[(PrimitiveKind, Target)] = &[
            (PrimitiveKind::Skill, Target::Claude),
            (PrimitiveKind::Skill, Target::Pi),
            (PrimitiveKind::Skill, Target::Codex),
            (PrimitiveKind::Agent, Target::Claude),
            (PrimitiveKind::Agent, Target::Pi),
            (PrimitiveKind::Command, Target::Claude),
            (PrimitiveKind::Command, Target::Pi),
            (PrimitiveKind::Command, Target::Codex),
            (PrimitiveKind::CodexAgent, Target::Codex),
        ];
        PAIRS.iter().map(|&(kind, target)| Self { kind, target })
    }

    pub fn kind(self) -> PrimitiveKind {
        self.kind
    }

    pub fn target(self) -> Target {
        self.target
    }

    /// The fixed install layout for this KindTarget, if it has one. Returns
    /// `None` for `(Agent, Claude)` — that pair's layout is adaptive and must
    /// be resolved from a `Materialized` or `InstallRecord` at use time.
    pub fn fixed_layout(self) -> Option<InstallLayout> {
        match (self.kind, self.target) {
            (PrimitiveKind::Agent, Target::Claude) => None,
            (PrimitiveKind::Command, _) | (PrimitiveKind::CodexAgent, _) => {
                Some(InstallLayout::SingleFile)
            }
            _ => Some(InstallLayout::Directory),
        }
    }

    /// Resolve install destination on disk. Infallible — legality is
    /// guaranteed by construction. `layout` only affects `(Agent, Claude)`;
    /// other arms ignore it.
    pub fn path_for(
        self,
        env: &InstallPaths,
        name: &PrimitiveName,
        layout: InstallLayout,
    ) -> Utf8PathBuf {
        let home = env.home();
        match (self.kind, self.target) {
            (PrimitiveKind::Skill, Target::Claude) => {
                home.join(".claude/skills").join(name.as_str())
            }
            (PrimitiveKind::Skill, Target::Pi) => {
                home.join(".pi/agent/skills").join(name.as_str())
            }
            (PrimitiveKind::Skill, Target::Codex) => {
                home.join(".codex/skills").join(name.as_str())
            }
            (PrimitiveKind::Agent, Target::Claude) => {
                let leaf = match layout {
                    InstallLayout::SingleFile => format!("{}.md", name.as_str()),
                    InstallLayout::Directory => name.as_str().to_owned(),
                };
                home.join(".claude/agents").join(leaf)
            }
            (PrimitiveKind::Agent, Target::Pi) => {
                home.join(".pi/agent/agents").join(name.as_str())
            }
            (PrimitiveKind::Command, Target::Claude) => home
                .join(".claude/commands")
                .join(format!("{}.md", name.as_str())),
            (PrimitiveKind::Command, Target::Pi) => home
                .join(".pi/agent/prompts")
                .join(format!("{}.md", name.as_str())),
            (PrimitiveKind::Command, Target::Codex) => home
                .join(".codex/prompts")
                .join(format!("{}.md", name.as_str())),
            (PrimitiveKind::CodexAgent, Target::Codex) => home
                .join(".codex/agents")
                .join(format!("{}.toml", name.as_str())),
            // Unreachable: KindTarget::new rejects every other (kind, target).
            _ => unreachable!("KindTarget construction guarantees legality"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn env() -> InstallPaths {
        InstallPaths::new("/home/test")
    }

    #[test]
    fn new_accepts_all_legal_pairs() {
        for (kind, target) in [
            (PrimitiveKind::Skill, Target::Claude),
            (PrimitiveKind::Skill, Target::Pi),
            (PrimitiveKind::Skill, Target::Codex),
            (PrimitiveKind::Agent, Target::Claude),
            (PrimitiveKind::Agent, Target::Pi),
            (PrimitiveKind::Command, Target::Claude),
            (PrimitiveKind::Command, Target::Pi),
            (PrimitiveKind::Command, Target::Codex),
            (PrimitiveKind::CodexAgent, Target::Codex),
        ] {
            assert!(
                KindTarget::new(kind, target).is_some(),
                "expected {kind:?},{target:?} to be legal"
            );
        }
    }

    #[test]
    fn new_rejects_illegal_pairs() {
        for (kind, target) in [
            (PrimitiveKind::Agent, Target::Codex),
            (PrimitiveKind::CodexAgent, Target::Claude),
            (PrimitiveKind::CodexAgent, Target::Pi),
        ] {
            assert!(
                KindTarget::new(kind, target).is_none(),
                "expected {kind:?},{target:?} to be rejected"
            );
        }
    }

    #[test]
    fn all_yields_distinct_legal_pairs() {
        let all: Vec<_> = KindTarget::all().collect();
        assert_eq!(all.len(), 9);
        let unique: std::collections::HashSet<_> =
            all.iter().map(|kt| (kt.kind(), kt.target())).collect();
        assert_eq!(unique.len(), 9);
        // Round-trip: each one re-constructs via new().
        for kt in all {
            assert!(KindTarget::new(kt.kind(), kt.target()).is_some());
        }
    }

    #[test]
    fn fixed_layout_is_directory_for_skill_and_agent_pi() {
        for kt in [
            KindTarget::new(PrimitiveKind::Skill, Target::Claude).unwrap(),
            KindTarget::new(PrimitiveKind::Skill, Target::Pi).unwrap(),
            KindTarget::new(PrimitiveKind::Skill, Target::Codex).unwrap(),
            KindTarget::new(PrimitiveKind::Agent, Target::Pi).unwrap(),
        ] {
            assert_eq!(kt.fixed_layout(), Some(InstallLayout::Directory));
        }
    }

    #[test]
    fn fixed_layout_is_single_file_for_command_and_codex_agent() {
        for kt in [
            KindTarget::new(PrimitiveKind::Command, Target::Claude).unwrap(),
            KindTarget::new(PrimitiveKind::Command, Target::Pi).unwrap(),
            KindTarget::new(PrimitiveKind::Command, Target::Codex).unwrap(),
            KindTarget::new(PrimitiveKind::CodexAgent, Target::Codex).unwrap(),
        ] {
            assert_eq!(kt.fixed_layout(), Some(InstallLayout::SingleFile));
        }
    }

    #[test]
    fn fixed_layout_is_none_for_agent_claude() {
        let kt = KindTarget::new(PrimitiveKind::Agent, Target::Claude).unwrap();
        assert_eq!(kt.fixed_layout(), None);
    }

    #[test]
    fn path_for_skill_per_target_is_directory() {
        let n = name("diagnose");
        let env = env();
        assert_eq!(
            KindTarget::new(PrimitiveKind::Skill, Target::Claude)
                .unwrap()
                .path_for(&env, &n, InstallLayout::Directory),
            Utf8PathBuf::from("/home/test/.claude/skills/diagnose"),
        );
        assert_eq!(
            KindTarget::new(PrimitiveKind::Skill, Target::Pi)
                .unwrap()
                .path_for(&env, &n, InstallLayout::Directory),
            Utf8PathBuf::from("/home/test/.pi/agent/skills/diagnose"),
        );
        assert_eq!(
            KindTarget::new(PrimitiveKind::Skill, Target::Codex)
                .unwrap()
                .path_for(&env, &n, InstallLayout::Directory),
            Utf8PathBuf::from("/home/test/.codex/skills/diagnose"),
        );
    }

    #[test]
    fn path_for_agent_claude_picks_leaf_by_layout() {
        let n = name("helper");
        let env = env();
        let kt = KindTarget::new(PrimitiveKind::Agent, Target::Claude).unwrap();
        assert_eq!(
            kt.path_for(&env, &n, InstallLayout::SingleFile),
            Utf8PathBuf::from("/home/test/.claude/agents/helper.md"),
        );
        assert_eq!(
            kt.path_for(&env, &n, InstallLayout::Directory),
            Utf8PathBuf::from("/home/test/.claude/agents/helper"),
        );
    }

    #[test]
    fn path_for_agent_pi_ignores_layout() {
        let n = name("helper");
        let env = env();
        let kt = KindTarget::new(PrimitiveKind::Agent, Target::Pi).unwrap();
        for layout in [InstallLayout::SingleFile, InstallLayout::Directory] {
            assert_eq!(
                kt.path_for(&env, &n, layout),
                Utf8PathBuf::from("/home/test/.pi/agent/agents/helper"),
            );
        }
    }

    #[test]
    fn path_for_command_lands_as_single_md_file() {
        let n = name("diag");
        let env = env();
        assert_eq!(
            KindTarget::new(PrimitiveKind::Command, Target::Claude)
                .unwrap()
                .path_for(&env, &n, InstallLayout::SingleFile),
            Utf8PathBuf::from("/home/test/.claude/commands/diag.md"),
        );
        assert_eq!(
            KindTarget::new(PrimitiveKind::Command, Target::Pi)
                .unwrap()
                .path_for(&env, &n, InstallLayout::SingleFile),
            Utf8PathBuf::from("/home/test/.pi/agent/prompts/diag.md"),
        );
        assert_eq!(
            KindTarget::new(PrimitiveKind::Command, Target::Codex)
                .unwrap()
                .path_for(&env, &n, InstallLayout::SingleFile),
            Utf8PathBuf::from("/home/test/.codex/prompts/diag.md"),
        );
    }

    #[test]
    fn path_for_codex_agent_is_single_toml_file() {
        let n = name("review");
        let env = env();
        assert_eq!(
            KindTarget::new(PrimitiveKind::CodexAgent, Target::Codex)
                .unwrap()
                .path_for(&env, &n, InstallLayout::SingleFile),
            Utf8PathBuf::from("/home/test/.codex/agents/review.toml"),
        );
    }
}
