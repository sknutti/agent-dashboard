//! Rename a primitive's library directory and rewrite every install record
//! that references the old name.
//!
//! Scope: library-side only. Installed copies on the user's home keep the
//! old directory/filename until the user reinstalls — the rename dialog
//! surfaces this so it's not silent. The on-disk move is `fs::rename` (atomic
//! on macOS within a single filesystem); the `installs.json` rewrite happens
//! afterward and, if it fails, the next-launch library-drift scan will
//! self-heal by surfacing the orphaned records.

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::install_state::InstallsFile;
use crate::layout::LibraryLayout;
use crate::{Error, PrimitiveKind, PrimitiveName};

pub struct RenamePrimitiveRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub old_name: &'a PrimitiveName,
    pub new_name: &'a PrimitiveName,
}

/// Result of a successful [`rename_primitive`]. `install_records_updated` is
/// the number of `installs.json` records whose `name` field was rewritten —
/// the UI uses it for the "N installed copies will keep the old name until
/// reinstalled" caveat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RenamePrimitiveSummary {
    pub install_records_updated: u32,
}

pub fn rename_primitive(
    req: RenamePrimitiveRequest<'_>,
) -> Result<RenamePrimitiveSummary, Error> {
    let old_dir = req.layout.primitive_dir(req.kind, req.old_name);
    let new_dir = req.layout.primitive_dir(req.kind, req.new_name);

    if !old_dir.exists() {
        return Err(Error::PrimitiveNotFound {
            kind: req.kind,
            name: req.old_name.as_str().to_string(),
        });
    }
    if new_dir.exists() {
        return Err(Error::PrimitiveAlreadyExists {
            kind: req.kind,
            name: req.new_name.as_str().to_string(),
        });
    }

    std::fs::rename(old_dir.as_std_path(), new_dir.as_std_path()).map_err(|source| {
        Error::Io {
            path: old_dir.to_string(),
            source,
        }
    })?;

    let mut installs = InstallsFile::load(req.installs_file_path)?;
    let mut updated: u32 = 0;
    for r in installs.records.iter_mut() {
        if r.kind == req.kind && &r.name == req.old_name {
            r.name = req.new_name.clone();
            updated += 1;
        }
    }
    if updated > 0 {
        installs.save(req.installs_file_path)?;
    }

    Ok(RenamePrimitiveSummary {
        install_records_updated: updated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_state::InstallRecord;
    use crate::scaffold::scaffold_skill;
    use crate::{Target, VersionLabel};
    use camino::Utf8PathBuf;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
    }

    fn installs_path(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().join("installs.json")).unwrap()
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn record(kind: PrimitiveKind, n: &str, target: Target) -> InstallRecord {
        InstallRecord {
            kind,
            name: name(n),
            target,
            installed_version: VersionLabel::try_new("v1").unwrap(),
            file_hashes: BTreeMap::new(),
            last_known_install_hashes: BTreeMap::new(),
            mtimes: BTreeMap::new(),
            installed_at: "2026-05-06T00:00:00Z".into(),
        }
    }

    #[test]
    fn rename_moves_dir_and_rewrites_install_records() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let installs = installs_path(&tmp);

        let old = name("old-name");
        let new = name("new-name");

        scaffold_skill(layout, &old, "2026-05-04T00:00:00Z").unwrap();
        InstallsFile {
            records: vec![
                record(PrimitiveKind::Skill, "old-name", Target::Claude),
                record(PrimitiveKind::Skill, "old-name", Target::Pi),
                record(PrimitiveKind::Skill, "other", Target::Claude),
            ],
            ..Default::default()
        }
        .save(&installs)
        .unwrap();

        let summary = rename_primitive(RenamePrimitiveRequest {
            layout,
            installs_file_path: &installs,
            kind: PrimitiveKind::Skill,
            old_name: &old,
            new_name: &new,
        })
        .unwrap();

        assert_eq!(summary.install_records_updated, 2);
        assert!(!layout.primitive_dir(PrimitiveKind::Skill, &old).exists());
        assert!(layout.primitive_dir(PrimitiveKind::Skill, &new).exists());
        assert!(layout
            .primitive_metadata(PrimitiveKind::Skill, &new)
            .exists());

        let after = InstallsFile::load(&installs).unwrap();
        assert_eq!(after.records.len(), 3);
        let renamed: Vec<_> = after
            .records
            .iter()
            .filter(|r| r.name == new)
            .collect();
        assert_eq!(renamed.len(), 2, "both old-name records should now be new-name");
        let unrelated: Vec<_> = after
            .records
            .iter()
            .filter(|r| r.name.as_str() == "other")
            .collect();
        assert_eq!(unrelated.len(), 1, "unrelated record should remain");
    }

    #[test]
    fn refuses_when_target_name_already_exists() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let installs = installs_path(&tmp);

        let old = name("old-name");
        let new = name("taken");

        scaffold_skill(layout, &old, "2026-05-04T00:00:00Z").unwrap();
        scaffold_skill(layout, &new, "2026-05-04T00:00:00Z").unwrap();
        InstallsFile::default().save(&installs).unwrap();

        let err = rename_primitive(RenamePrimitiveRequest {
            layout,
            installs_file_path: &installs,
            kind: PrimitiveKind::Skill,
            old_name: &old,
            new_name: &new,
        })
        .unwrap_err();

        assert!(
            matches!(
                err,
                Error::PrimitiveAlreadyExists { kind: PrimitiveKind::Skill, ref name }
                    if name == "taken"
            ),
            "expected PrimitiveAlreadyExists, got {err:?}"
        );

        // Both directories untouched.
        assert!(layout.primitive_dir(PrimitiveKind::Skill, &old).exists());
        assert!(layout.primitive_dir(PrimitiveKind::Skill, &new).exists());
    }

    #[test]
    fn refuses_when_source_does_not_exist() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let installs = installs_path(&tmp);
        InstallsFile::default().save(&installs).unwrap();

        let err = rename_primitive(RenamePrimitiveRequest {
            layout,
            installs_file_path: &installs,
            kind: PrimitiveKind::Skill,
            old_name: &name("ghost"),
            new_name: &name("phantom"),
        })
        .unwrap_err();

        assert!(
            matches!(
                err,
                Error::PrimitiveNotFound { kind: PrimitiveKind::Skill, ref name }
                    if name == "ghost"
            ),
            "expected PrimitiveNotFound, got {err:?}"
        );
    }
}
