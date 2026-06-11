use std::collections::HashMap;

use camino::{Utf8Path, Utf8PathBuf};

use crate::codex_agent::CodexAgentFile;
use crate::fs_helpers::{atomic_write, walk_into};
use crate::md_primitive::MdPrimitive;
use crate::working_files::validate_path_shape;
use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveName, Target};

/// In-memory snapshot of a primitive's `working/` tree.
///
/// Paths are relative to `working/base/` (for `base`) or
/// `working/targets/<target>/` (for `targets[target]`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverlayBytes {
    pub base: HashMap<Utf8PathBuf, Vec<u8>>,
    pub targets: HashMap<Target, HashMap<Utf8PathBuf, Vec<u8>>>,
}

/// Internal helper: read/write a primitive's mutable `working/` tree.
///
/// Per-file writes use temp-file + rename for atomicity. Reads filter via
/// the shared `is_ignored` allowlist (`.DS_Store`, etc.) so the ignore rules
/// are applied symmetrically with the materializer.
#[derive(Debug, Clone, Copy)]
pub struct WorkingCopy<'a> {
    layout: LibraryLayout<'a>,
}

impl<'a> WorkingCopy<'a> {
    pub fn new(layout: LibraryLayout<'a>) -> Self {
        Self { layout }
    }

    /// Write a file inside `working/base/` atomically.
    pub fn save_base_file(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        rel: &Utf8Path,
        bytes: &[u8],
    ) -> Result<(), Error> {
        validate_path_shape(rel)?;
        let dest = self.layout.working_base(kind, name).join(rel);
        atomic_write(&dest, bytes)
    }

    /// Write a file inside `working/targets/<target>/` atomically.
    pub fn save_target_file(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
        rel: &Utf8Path,
        bytes: &[u8],
    ) -> Result<(), Error> {
        validate_path_shape(rel)?;
        let dest = self.layout.working_target(kind, name, target).join(rel);
        atomic_write(&dest, bytes)
    }

    /// Save the primary base-file bytes for `(kind, name)`, validating that
    /// `bytes` parses for the kind first. MD-shaped kinds parse via
    /// [`MdPrimitive`]; CodexAgent parses via [`CodexAgentFile`]. Bad bytes
    /// never reach disk.
    pub fn save_primary_base(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        bytes: &[u8],
    ) -> Result<(), Error> {
        validate_primary_bytes(kind, bytes)?;
        let primary = kind.primary_filename(name);
        self.save_base_file(kind, name, Utf8Path::new(&primary), bytes)
    }

    /// Save the primary overlay bytes for `(kind, name, target)`, validating
    /// that `bytes` parses for the kind first.
    pub fn save_primary_target(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
        bytes: &[u8],
    ) -> Result<(), Error> {
        validate_primary_bytes(kind, bytes)?;
        let primary = kind.primary_filename(name);
        self.save_target_file(kind, name, target, Utf8Path::new(&primary), bytes)
    }

    /// Remove the primary overlay file for `(kind, name, target)`. Idempotent.
    pub fn remove_primary_target(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
    ) -> Result<(), Error> {
        let primary = kind.primary_filename(name);
        self.remove_target_file(kind, name, target, Utf8Path::new(&primary))
    }

    /// Remove a file inside `working/base/`. No-op if missing.
    pub fn remove_base_file(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        rel: &Utf8Path,
    ) -> Result<(), Error> {
        validate_path_shape(rel)?;
        let dest = self.layout.working_base(kind, name).join(rel);
        if !dest.exists() {
            return Ok(());
        }
        std::fs::remove_file(&dest).map_err(|source| Error::Io {
            path: dest.to_string(),
            source,
        })
    }

    /// Remove a file inside `working/targets/<target>/`. No-op if missing —
    /// we treat absence as the desired terminal state.
    pub fn remove_target_file(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
        rel: &Utf8Path,
    ) -> Result<(), Error> {
        validate_path_shape(rel)?;
        let dest = self.layout.working_target(kind, name, target).join(rel);
        if !dest.exists() {
            return Ok(());
        }
        std::fs::remove_file(&dest).map_err(|source| Error::Io {
            path: dest.to_string(),
            source,
        })
    }

    /// Load the entire `working/` tree into memory. Filters out ignored files.
    /// Returns an empty `OverlayBytes` if `working/` doesn't exist.
    pub fn load(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
    ) -> Result<OverlayBytes, Error> {
        let mut overlay = OverlayBytes::default();
        let base_dir = self.layout.working_base(kind, name);
        if base_dir.exists() {
            walk_into(&base_dir, &base_dir, &mut overlay.base)?;
        }
        for &target in Target::ALL {
            let target_dir = self.layout.working_target(kind, name, target);
            if target_dir.exists() {
                let mut files = HashMap::new();
                walk_into(&target_dir, &target_dir, &mut files)?;
                if !files.is_empty() {
                    overlay.targets.insert(target, files);
                }
            }
        }
        Ok(overlay)
    }
}

fn validate_primary_bytes(kind: PrimitiveKind, bytes: &[u8]) -> Result<(), Error> {
    if kind.is_md_kind() {
        MdPrimitive::parse(bytes)?;
    } else {
        CodexAgentFile::parse(bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Utf8PathBuf, PrimitiveName) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let name = PrimitiveName::try_new("diagnose").unwrap();
        (tmp, root, name)
    }

    #[test]
    fn save_then_load_round_trips_base_and_targets() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);

        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"# base body\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"# claude override\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Pi,
            Utf8Path::new("nested/extra.md"),
            b"pi extra\n",
        )
        .unwrap();

        let loaded = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(
            loaded.base.get(Utf8Path::new("SKILL.md")).map(|v| v.as_slice()),
            Some(&b"# base body\n"[..]),
        );
        assert_eq!(
            loaded.targets[&Target::Claude]
                .get(Utf8Path::new("SKILL.md"))
                .map(|v| v.as_slice()),
            Some(&b"# claude override\n"[..]),
        );
        assert_eq!(
            loaded.targets[&Target::Pi]
                .get(Utf8Path::new("nested/extra.md"))
                .map(|v| v.as_slice()),
            Some(&b"pi extra\n"[..]),
        );
        assert!(!loaded.targets.contains_key(&Target::Codex));
    }

    #[test]
    fn load_empty_when_working_dir_missing() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        let loaded = wc.load(PrimitiveKind::Agent, &name).unwrap();
        assert!(loaded.base.is_empty());
        assert!(loaded.targets.is_empty());
    }

    #[test]
    fn remove_target_file_drops_overlay_and_is_idempotent() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"override",
        )
        .unwrap();
        wc.remove_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
        )
        .unwrap();
        let loaded = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert!(!loaded.targets.contains_key(&Target::Claude));

        // Idempotent: removing again is fine.
        wc.remove_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
        )
        .unwrap();
    }

    #[test]
    fn save_overwrites_existing_atomically() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        let rel = Utf8Path::new("SKILL.md");
        wc.save_base_file(PrimitiveKind::Skill, &name, rel, b"v1").unwrap();
        wc.save_base_file(PrimitiveKind::Skill, &name, rel, b"v2").unwrap();
        let loaded = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(loaded.base[rel], b"v2");
    }

    #[test]
    fn no_temp_files_left_behind_after_save() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"body",
        )
        .unwrap();
        let dir = layout.working_base(PrimitiveKind::Skill, &name);
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["SKILL.md"]);
    }

    #[test]
    fn load_filters_ignored_files() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        // Plant a real file via the API.
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"ok",
        )
        .unwrap();
        // Plant a .DS_Store directly on disk.
        let ds = layout.working_base(PrimitiveKind::Skill, &name).join(".DS_Store");
        fs::write(&ds, b"junk").unwrap();
        let loaded = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert!(loaded.base.contains_key(Utf8Path::new("SKILL.md")));
        assert!(!loaded.base.contains_key(Utf8Path::new(".DS_Store")));
    }

    #[test]
    fn rejects_path_traversal() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        let err = wc
            .save_base_file(
                PrimitiveKind::Skill,
                &name,
                Utf8Path::new("../escaped"),
                b"x",
            )
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));

        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("./SKILL.md"),
            b"x",
        )
        .unwrap_err();

        wc.save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new(""), b"x")
            .unwrap_err();
    }

    #[test]
    fn nested_directories_created_on_demand() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Agent,
            &name,
            Target::Pi,
            Utf8Path::new("a/b/c/file.md"),
            b"deep",
        )
        .unwrap();
        let loaded = wc.load(PrimitiveKind::Agent, &name).unwrap();
        assert_eq!(loaded.targets[&Target::Pi][Utf8Path::new("a/b/c/file.md")], b"deep");
    }
}
