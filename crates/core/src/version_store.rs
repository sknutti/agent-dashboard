use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};

use crate::fs_helpers::{atomic_write, walk_into};
use crate::{
    Error, LibraryLayout, OverlayBytes, PrimitiveKind, PrimitiveName, Target, VersionLabel,
    WorkingCopy,
};

/// Per-version metadata stored as `version.yaml` inside each `versions/<label>/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct VersionMetadata {
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Internal helper: snapshot `working/` into `versions/<label>/`, manage
/// `current.txt`, and list/read frozen versions.
///
/// Snapshots are immutable once written: `snapshot` errors if the label
/// directory already exists.
#[derive(Debug, Clone, Copy)]
pub struct VersionStore<'a> {
    layout: LibraryLayout<'a>,
}

impl<'a> VersionStore<'a> {
    pub fn new(layout: LibraryLayout<'a>) -> Self {
        Self { layout }
    }

    /// Copy the entire `working/` tree into `versions/<label>/`, write
    /// `version.yaml`, and set `current.txt` to `label`. Errors if the
    /// version label already exists on disk (immutability).
    pub fn snapshot(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
        meta: &VersionMetadata,
    ) -> Result<(), Error> {
        let version_dir = self.layout.version_dir(kind, name, label);
        if version_dir.exists() {
            return Err(Error::VersionExists(label.as_str().into()));
        }

        let working = WorkingCopy::new(self.layout).load(kind, name)?;

        // Copy base/
        for (rel, bytes) in &working.base {
            let dest = self.layout.version_base(kind, name, label).join(rel);
            atomic_write(&dest, bytes)?;
        }

        // Copy each target overlay
        for (target, files) in &working.targets {
            for (rel, bytes) in files {
                let dest = self.layout.version_target(kind, name, label, *target).join(rel);
                atomic_write(&dest, bytes)?;
            }
        }

        // Always create the version_dir even if working/ was empty
        fs::create_dir_all(&version_dir).map_err(|e| Error::Io {
            path: version_dir.as_str().into(),
            source: e,
        })?;

        // Write version.yaml
        let yaml = serde_yaml_ng::to_string(meta)
            .map_err(|e| Error::MetadataSerialize(e.to_string()))?;
        let meta_path = self.layout.version_metadata(kind, name, label);
        atomic_write(&meta_path, yaml.as_bytes())?;

        // Set current.txt
        self.set_current(kind, name, label)?;

        Ok(())
    }

    /// Returns `None` if `current.txt` is missing.
    pub fn read_current(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
    ) -> Result<Option<VersionLabel>, Error> {
        let path = self.layout.current_marker(kind, name);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path).map_err(|e| Error::Io {
            path: path.as_str().into(),
            source: e,
        })?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(Error::InvalidCurrentMarker("empty".into()));
        }
        let label = VersionLabel::try_new(trimmed)
            .map_err(|_| Error::InvalidCurrentMarker(trimmed.into()))?;
        Ok(Some(label))
    }

    /// Sets `current.txt` to `label`. Errors if the version doesn't exist.
    pub fn set_current(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Result<(), Error> {
        let version_dir = self.layout.version_dir(kind, name, label);
        if !version_dir.exists() {
            return Err(Error::VersionNotFound(label.as_str().into()));
        }
        let path = self.layout.current_marker(kind, name);
        let mut contents = label.as_str().to_string();
        contents.push('\n');
        atomic_write(&path, contents.as_bytes())
    }

    /// All version labels present on disk, sorted by label string.
    pub fn list_versions(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
    ) -> Result<Vec<VersionLabel>, Error> {
        let dir = self.layout.versions_dir(kind, name);
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| Error::Io {
            path: dir.as_str().into(),
            source: e,
        })? {
            let entry = entry.map_err(|e| Error::Io {
                path: dir.as_str().into(),
                source: e,
            })?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if let Ok(label) = VersionLabel::try_new(s.as_ref()) {
                out.push(label);
            }
        }
        out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Ok(out)
    }

    /// Read a frozen version's bytes back into an `OverlayBytes` snapshot.
    pub fn read_version(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Result<OverlayBytes, Error> {
        let version_dir = self.layout.version_dir(kind, name, label);
        if !version_dir.exists() {
            return Err(Error::VersionNotFound(label.as_str().into()));
        }
        let mut overlay = OverlayBytes::default();
        let base_dir = self.layout.version_base(kind, name, label);
        if base_dir.exists() {
            walk_into(&base_dir, &base_dir, &mut overlay.base)?;
        }
        for &target in Target::ALL {
            let target_dir = self.layout.version_target(kind, name, label, target);
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

    pub fn read_version_metadata(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        label: &VersionLabel,
    ) -> Result<VersionMetadata, Error> {
        let path = self.layout.version_metadata(kind, name, label);
        let raw = fs::read_to_string(&path).map_err(|e| Error::Io {
            path: path.as_str().into(),
            source: e,
        })?;
        Ok(serde_yaml_ng::from_str(&raw)?)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use camino::{Utf8Path, Utf8PathBuf};
    use tempfile::TempDir;

    fn setup() -> (
        TempDir,
        Utf8PathBuf,
        PrimitiveName,
        VersionMetadata,
    ) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let name = PrimitiveName::try_new("diagnose").unwrap();
        let meta = VersionMetadata {
            created_at: "2026-04-30T12:00:00Z".into(),
            notes: Some("first publish".into()),
        };
        (tmp, root, name, meta)
    }

    fn write_working_skill(layout: LibraryLayout<'_>, name: &PrimitiveName, body: &[u8]) {
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("SKILL.md"), body)
            .unwrap();
    }

    #[test]
    fn snapshot_creates_version_dir_with_files_and_metadata() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        write_working_skill(layout, &name, b"# v1 body\n");
        let store = VersionStore::new(layout);
        let label = VersionLabel::try_new("v1").unwrap();

        store.snapshot(PrimitiveKind::Skill, &name, &label, &meta).unwrap();

        let read = store.read_version(PrimitiveKind::Skill, &name, &label).unwrap();
        assert_eq!(read.base[Utf8Path::new("SKILL.md")], b"# v1 body\n");

        let read_meta = store
            .read_version_metadata(PrimitiveKind::Skill, &name, &label)
            .unwrap();
        assert_eq!(read_meta, meta);
    }

    #[test]
    fn snapshot_sets_current_to_new_label() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        write_working_skill(layout, &name, b"# v1\n");
        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();
        assert_eq!(store.read_current(PrimitiveKind::Skill, &name).unwrap(), Some(v1));
    }

    #[test]
    fn snapshotting_v2_leaves_v1_unchanged() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);

        write_working_skill(layout, &name, b"original v1 body\n");
        let v1 = VersionLabel::try_new("v1").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();

        // Mutate working
        write_working_skill(layout, &name, b"updated v2 body\n");
        let v2 = VersionLabel::try_new("v2").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v2, &meta).unwrap();

        let v1_read = store.read_version(PrimitiveKind::Skill, &name, &v1).unwrap();
        assert_eq!(
            v1_read.base[Utf8Path::new("SKILL.md")],
            b"original v1 body\n",
            "v1 must remain immutable after v2 snapshot",
        );
        let v2_read = store.read_version(PrimitiveKind::Skill, &name, &v2).unwrap();
        assert_eq!(v2_read.base[Utf8Path::new("SKILL.md")], b"updated v2 body\n");
    }

    #[test]
    fn snapshot_rejects_existing_version_label() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);
        write_working_skill(layout, &name, b"x");
        let v1 = VersionLabel::try_new("v1").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();

        let err = store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap_err();
        assert!(matches!(err, Error::VersionExists(s) if s == "v1"));
    }

    #[test]
    fn set_current_overrides_default() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);
        write_working_skill(layout, &name, b"v1");
        store
            .snapshot(
                PrimitiveKind::Skill,
                &name,
                &VersionLabel::try_new("v1").unwrap(),
                &meta,
            )
            .unwrap();
        write_working_skill(layout, &name, b"v2");
        let v2 = VersionLabel::try_new("v2").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v2, &meta).unwrap();

        // Manually pin back to v1
        let v1 = VersionLabel::try_new("v1").unwrap();
        store.set_current(PrimitiveKind::Skill, &name, &v1).unwrap();
        assert_eq!(store.read_current(PrimitiveKind::Skill, &name).unwrap(), Some(v1));
    }

    #[test]
    fn set_current_rejects_unknown_version() {
        let (_tmp, root, name, _) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);
        let err = store
            .set_current(
                PrimitiveKind::Skill,
                &name,
                &VersionLabel::try_new("v99").unwrap(),
            )
            .unwrap_err();
        assert!(matches!(err, Error::VersionNotFound(s) if s == "v99"));
    }

    #[test]
    fn list_versions_returns_sorted_labels() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);
        for label in &["v1", "v3", "v2"] {
            write_working_skill(layout, &name, label.as_bytes());
            store
                .snapshot(
                    PrimitiveKind::Skill,
                    &name,
                    &VersionLabel::try_new(*label).unwrap(),
                    &meta,
                )
                .unwrap();
        }
        let labels: Vec<_> = store
            .list_versions(PrimitiveKind::Skill, &name)
            .unwrap()
            .into_iter()
            .map(|l| l.as_str().to_string())
            .collect();
        assert_eq!(labels, vec!["v1", "v2", "v3"]);
    }

    #[test]
    fn read_current_none_when_unset() {
        let (_tmp, root, name, _) = setup();
        let layout = LibraryLayout::new(&root);
        let store = VersionStore::new(layout);
        assert_eq!(store.read_current(PrimitiveKind::Skill, &name).unwrap(), None);
    }

    #[test]
    fn snapshot_includes_target_overlays() {
        let (_tmp, root, name, meta) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"base\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"claude override\n",
        )
        .unwrap();

        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();

        let read = store.read_version(PrimitiveKind::Skill, &name, &v1).unwrap();
        assert_eq!(read.base[Utf8Path::new("SKILL.md")], b"base\n");
        assert_eq!(
            read.targets[&Target::Claude][Utf8Path::new("SKILL.md")],
            b"claude override\n",
        );
    }
}
