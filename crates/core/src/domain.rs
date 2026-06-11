use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrimitiveKind {
    Skill,
    Agent,
    Command,
    CodexAgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Claude,
    Pi,
    Codex,
}

/// Discriminated description of a Kind's primary file naming rule.
/// `Fixed` carries the literal filename (e.g. `SKILL.md`); `Templated`
/// carries the extension to apply to the primitive's own name (e.g.
/// `<name>.md` becomes `Templated { extension: "md" }`). Crosses the
/// IPC boundary so the frontend can derive primary filenames without
/// hand-mirroring per-Kind logic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrimaryFilename {
    Fixed { value: String },
    Templated { extension: String },
}

impl PrimaryFilename {
    pub fn resolve(&self, name: &crate::PrimitiveName) -> String {
        match self {
            PrimaryFilename::Fixed { value } => value.clone(),
            PrimaryFilename::Templated { extension } => {
                format!("{}.{extension}", name.as_str())
            }
        }
    }
}

/// How the primary file's bytes are parsed. Frontmatter+body kinds run
/// through the YAML/markdown codec; raw-toml kinds pass through verbatim.
/// Lives on `KindMetadata` and is projected by `is_md_kind()`. Not exposed
/// over IPC — no frontend consumers today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFormat {
    FrontmatterAndBody,
    RawToml,
}

/// Per-Kind static metadata. The single source of truth for everything
/// that varies across Kinds independent of Target. Adding a new Kind
/// = adding one arm to `PrimitiveKind::metadata` + one field to
/// `KindInfoTable` (compiler enforces both). Per-`(Kind, Target)` data
/// continues to live on `KindTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindMetadata {
    pub dir_name: &'static str,
    pub primary_filename: PrimaryFilename,
    pub body_format: BodyFormat,
    pub allowed_targets: &'static [Target],
    /// True if `working/base/` may contain files alongside the primary
    /// (Skill, Agent today). False if the working copy is a single file
    /// (Command, CodexAgent).
    pub supports_ref_files: bool,
}

/// IPC-boundary projection of `KindMetadata` — the subset the frontend
/// consumes. Body format and dir name are Rust-internal and stay off the
/// wire.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KindInfo {
    pub primary_filename: PrimaryFilename,
    pub allowed_targets: Vec<Target>,
    pub supports_ref_files: bool,
}

/// Total per-Kind table exposed to the frontend. Named-fields shape (vs.
/// a map) so tauri-specta produces a total TS record — callers do
/// `table.skill.supports_ref_files` without optionality. Adding a Kind
/// requires adding a field here; Cargo refuses to compile if it's
/// missing.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KindInfoTable {
    pub skill: KindInfo,
    pub agent: KindInfo,
    pub command: KindInfo,
    pub codex_agent: KindInfo,
}

impl KindInfoTable {
    pub fn current() -> Self {
        Self {
            skill: PrimitiveKind::Skill.kind_info(),
            agent: PrimitiveKind::Agent.kind_info(),
            command: PrimitiveKind::Command.kind_info(),
            codex_agent: PrimitiveKind::CodexAgent.kind_info(),
        }
    }
}

impl PrimitiveKind {
    pub const ALL: &'static [PrimitiveKind] = &[
        PrimitiveKind::Skill,
        PrimitiveKind::Agent,
        PrimitiveKind::Command,
        PrimitiveKind::CodexAgent,
    ];

    /// Single source of truth for per-Kind static data. Existing per-field
    /// methods (`dir_name`, `is_md_kind`, `allowed_targets`,
    /// `primary_filename`) project from this table.
    pub fn metadata(self) -> KindMetadata {
        match self {
            PrimitiveKind::Skill => KindMetadata {
                dir_name: "skills",
                primary_filename: PrimaryFilename::Fixed {
                    value: "SKILL.md".into(),
                },
                body_format: BodyFormat::FrontmatterAndBody,
                allowed_targets: &[Target::Claude, Target::Pi, Target::Codex],
                supports_ref_files: true,
            },
            PrimitiveKind::Agent => KindMetadata {
                dir_name: "agents",
                primary_filename: PrimaryFilename::Fixed {
                    value: "agent.md".into(),
                },
                body_format: BodyFormat::FrontmatterAndBody,
                allowed_targets: &[Target::Claude, Target::Pi],
                supports_ref_files: true,
            },
            PrimitiveKind::Command => KindMetadata {
                dir_name: "commands",
                primary_filename: PrimaryFilename::Templated {
                    extension: "md".into(),
                },
                body_format: BodyFormat::FrontmatterAndBody,
                allowed_targets: &[Target::Claude, Target::Pi, Target::Codex],
                supports_ref_files: false,
            },
            PrimitiveKind::CodexAgent => KindMetadata {
                dir_name: "codex_agents",
                primary_filename: PrimaryFilename::Templated {
                    extension: "toml".into(),
                },
                body_format: BodyFormat::RawToml,
                allowed_targets: &[Target::Codex],
                supports_ref_files: false,
            },
        }
    }

    /// IPC-bound projection used by `KindInfoTable::current()`.
    fn kind_info(self) -> KindInfo {
        let m = self.metadata();
        KindInfo {
            primary_filename: m.primary_filename,
            allowed_targets: m.allowed_targets.to_vec(),
            supports_ref_files: m.supports_ref_files,
        }
    }

    pub fn dir_name(self) -> &'static str {
        self.metadata().dir_name
    }

    /// Canonical filename of the primitive's primary file inside
    /// `working/base/`. Skill and Agent use fixed names; Command and
    /// CodexAgent template the primitive's own name into the file.
    pub fn primary_filename(self, name: &crate::PrimitiveName) -> String {
        self.metadata().primary_filename.resolve(name)
    }

    /// True if the primary file is markdown with YAML frontmatter
    /// (`SKILL.md`/`agent.md`/`<name>.md`); false for raw TOML
    /// (`<name>.toml`).
    pub fn is_md_kind(self) -> bool {
        matches!(self.metadata().body_format, BodyFormat::FrontmatterAndBody)
    }

    pub fn from_dir_name(s: &str) -> Option<Self> {
        match s {
            "skills" => Some(PrimitiveKind::Skill),
            "agents" => Some(PrimitiveKind::Agent),
            "commands" => Some(PrimitiveKind::Command),
            "codex_agents" => Some(PrimitiveKind::CodexAgent),
            _ => None,
        }
    }

    /// Convenience projection of the install matrix for one kind. The matrix
    /// itself lives in `KindTarget::new` / `KindTarget::all` — consistency is
    /// enforced by `domain::tests::allowed_targets_matches_kind_target_all`.
    pub fn allowed_targets(self) -> &'static [Target] {
        self.metadata().allowed_targets
    }

    pub fn allows_target(self, target: Target) -> bool {
        self.allowed_targets().contains(&target)
    }
}

impl Target {
    pub const ALL: &'static [Target] = &[Target::Claude, Target::Pi, Target::Codex];

    pub fn dir_name(self) -> &'static str {
        match self {
            Target::Claude => "claude",
            Target::Pi => "pi",
            Target::Codex => "codex",
        }
    }

    pub fn from_dir_name(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Target::Claude),
            "pi" => Some(Target::Pi),
            "codex" => Some(Target::Codex),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitive_kind_dir_name_round_trip() {
        for kind in PrimitiveKind::ALL {
            assert_eq!(
                PrimitiveKind::from_dir_name(kind.dir_name()),
                Some(*kind),
                "round-trip failed for {kind:?}"
            );
        }
    }

    #[test]
    fn target_dir_name_round_trip() {
        for target in Target::ALL {
            assert_eq!(
                Target::from_dir_name(target.dir_name()),
                Some(*target),
                "round-trip failed for {target:?}"
            );
        }
    }

    #[test]
    fn unknown_dir_names_yield_none() {
        assert_eq!(PrimitiveKind::from_dir_name("nope"), None);
        assert_eq!(PrimitiveKind::from_dir_name(""), None);
        assert_eq!(Target::from_dir_name("nope"), None);
    }

    #[test]
    fn primitive_kind_dir_names_are_distinct() {
        let names: Vec<_> = PrimitiveKind::ALL.iter().map(|k| k.dir_name()).collect();
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(names.len(), unique.len());
    }

    #[test]
    fn target_dir_names_are_distinct() {
        let names: Vec<_> = Target::ALL.iter().map(|t| t.dir_name()).collect();
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(names.len(), unique.len());
    }

    #[test]
    fn allowed_targets_per_kind() {
        assert_eq!(
            PrimitiveKind::Skill.allowed_targets(),
            &[Target::Claude, Target::Pi, Target::Codex],
        );
        assert_eq!(
            PrimitiveKind::Agent.allowed_targets(),
            &[Target::Claude, Target::Pi],
        );
        assert_eq!(
            PrimitiveKind::Command.allowed_targets(),
            &[Target::Claude, Target::Pi, Target::Codex],
        );
        assert_eq!(
            PrimitiveKind::CodexAgent.allowed_targets(),
            &[Target::Codex],
        );
    }

    #[test]
    fn allows_target_matches_allowed_targets() {
        for kind in PrimitiveKind::ALL.iter().copied() {
            for target in Target::ALL.iter().copied() {
                let expected = kind.allowed_targets().contains(&target);
                assert_eq!(
                    kind.allows_target(target),
                    expected,
                    "mismatch for ({kind:?}, {target:?})"
                );
            }
        }
    }

    #[test]
    fn allowed_targets_matches_kind_target_all() {
        use crate::KindTarget;
        for kind in PrimitiveKind::ALL.iter().copied() {
            for target in Target::ALL.iter().copied() {
                let by_kind = kind.allows_target(target);
                let by_kt = KindTarget::new(kind, target).is_some();
                assert_eq!(
                    by_kind, by_kt,
                    "({kind:?}, {target:?}): allowed_targets says {by_kind} but KindTarget::new says {by_kt}",
                );
            }
        }
    }

    #[test]
    fn primary_filename_resolves_via_metadata() {
        let n = crate::PrimitiveName::try_new("diagnose").unwrap();
        assert_eq!(PrimitiveKind::Skill.primary_filename(&n), "SKILL.md");
        assert_eq!(PrimitiveKind::Agent.primary_filename(&n), "agent.md");
        assert_eq!(PrimitiveKind::Command.primary_filename(&n), "diagnose.md");
        assert_eq!(
            PrimitiveKind::CodexAgent.primary_filename(&n),
            "diagnose.toml"
        );
    }

    #[test]
    fn kind_info_table_projects_each_metadata_entry() {
        let table = KindInfoTable::current();
        for kind in PrimitiveKind::ALL.iter().copied() {
            let info = match kind {
                PrimitiveKind::Skill => &table.skill,
                PrimitiveKind::Agent => &table.agent,
                PrimitiveKind::Command => &table.command,
                PrimitiveKind::CodexAgent => &table.codex_agent,
            };
            let m = kind.metadata();
            assert_eq!(info.primary_filename, m.primary_filename, "{kind:?}");
            assert_eq!(info.allowed_targets.as_slice(), m.allowed_targets, "{kind:?}");
            assert_eq!(info.supports_ref_files, m.supports_ref_files, "{kind:?}");
        }
    }

    #[test]
    fn is_md_kind_matches_body_format() {
        for kind in PrimitiveKind::ALL.iter().copied() {
            let by_method = kind.is_md_kind();
            let by_metadata =
                matches!(kind.metadata().body_format, BodyFormat::FrontmatterAndBody);
            assert_eq!(
                by_method, by_metadata,
                "{kind:?}: is_md_kind says {by_method} but metadata says {by_metadata}",
            );
        }
    }
}
