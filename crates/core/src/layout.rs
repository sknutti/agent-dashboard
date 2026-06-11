use camino::{Utf8Path, Utf8PathBuf};

use crate::{PrimitiveKind, PrimitiveName, Target, VersionLabel};

/// Builds canonical paths within a library directory.
///
/// Pure: no FS access. All methods return owned `Utf8PathBuf`.
#[derive(Debug, Clone, Copy)]
pub struct LibraryLayout<'a> {
    root: &'a Utf8Path,
}

impl<'a> LibraryLayout<'a> {
    pub fn new(root: &'a Utf8Path) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Utf8Path {
        self.root
    }

    pub fn gitignore(&self) -> Utf8PathBuf {
        self.root.join(".gitignore")
    }

    pub fn library_marker(&self) -> Utf8PathBuf {
        self.root.join(".prompt-library")
    }

    pub fn kind_dir(&self, kind: PrimitiveKind) -> Utf8PathBuf {
        self.root.join(kind.dir_name())
    }

    pub fn primitive_dir(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.kind_dir(kind).join(name.as_str())
    }

    pub fn primitive_metadata(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.primitive_dir(kind, name).join("metadata.yaml")
    }

    pub fn current_marker(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.primitive_dir(kind, name).join("current.txt")
    }

    pub fn working_dir(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.primitive_dir(kind, name).join("working")
    }

    pub fn working_base(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.working_dir(kind, name).join("base")
    }

    pub fn working_target(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
    ) -> Utf8PathBuf {
        self.working_dir(kind, name)
            .join("targets")
            .join(target.dir_name())
    }

    pub fn versions_dir(&self, kind: PrimitiveKind, name: &PrimitiveName) -> Utf8PathBuf {
        self.primitive_dir(kind, name).join("versions")
    }

    pub fn version_dir(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Utf8PathBuf {
        self.versions_dir(kind, name).join(label.as_str())
    }

    pub fn version_metadata(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Utf8PathBuf {
        self.version_dir(kind, name, label).join("version.yaml")
    }

    pub fn version_base(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Utf8PathBuf {
        self.version_dir(kind, name, label).join("base")
    }

    pub fn version_target(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
        target: Target,
    ) -> Utf8PathBuf {
        self.version_dir(kind, name, label)
            .join("targets")
            .join(target.dir_name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Utf8PathBuf, PrimitiveName, VersionLabel) {
        (
            Utf8PathBuf::from("/lib"),
            PrimitiveName::try_new("diagnose").unwrap(),
            VersionLabel::try_new("v1").unwrap(),
        )
    }

    #[test]
    fn primitive_dir_nests_kind_then_name() {
        let (root, name, _) = fixture();
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            layout.primitive_dir(PrimitiveKind::Skill, &name),
            Utf8PathBuf::from("/lib/skills/diagnose"),
        );
    }

    #[test]
    fn working_target_path_full_nesting() {
        let (root, name, _) = fixture();
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            layout.working_target(PrimitiveKind::Agent, &name, Target::Claude),
            Utf8PathBuf::from("/lib/agents/diagnose/working/targets/claude"),
        );
    }

    #[test]
    fn version_target_path_full_nesting() {
        let (root, name, label) = fixture();
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            layout.version_target(PrimitiveKind::Command, &name, &label, Target::Pi),
            Utf8PathBuf::from("/lib/commands/diagnose/versions/v1/targets/pi"),
        );
    }

    #[test]
    fn metadata_paths() {
        let (root, name, label) = fixture();
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            layout.primitive_metadata(PrimitiveKind::Skill, &name),
            Utf8PathBuf::from("/lib/skills/diagnose/metadata.yaml"),
        );
        assert_eq!(
            layout.current_marker(PrimitiveKind::Skill, &name),
            Utf8PathBuf::from("/lib/skills/diagnose/current.txt"),
        );
        assert_eq!(
            layout.version_metadata(PrimitiveKind::Skill, &name, &label),
            Utf8PathBuf::from("/lib/skills/diagnose/versions/v1/version.yaml"),
        );
    }

    #[test]
    fn codex_agent_uses_underscore_dir() {
        let (root, name, _) = fixture();
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            layout.primitive_dir(PrimitiveKind::CodexAgent, &name),
            Utf8PathBuf::from("/lib/codex_agents/diagnose"),
        );
    }

    #[test]
    fn gitignore_at_root() {
        let layout = LibraryLayout::new(Utf8Path::new("/lib"));
        assert_eq!(layout.gitignore(), Utf8PathBuf::from("/lib/.gitignore"));
    }
}
