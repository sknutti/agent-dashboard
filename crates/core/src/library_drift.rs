//! Detect primitives that `installs.json` still references but whose library
//! directory no longer exists on disk.
//!
//! Triggered at launch — surfaces a reconcile dialog so the user can either
//! drop the stale install records (`forget_primitive`) or, in the future,
//! recover from a snapshot. Pure path-existence check; no hashing.

use std::collections::HashMap;

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::install_paths::InstallPaths;
use crate::install_state::InstallsFile;
use crate::installer::{uninstall, UninstallRequest, UninstallSummary};
use crate::layout::LibraryLayout;
use crate::{Error, PrimitiveKind, PrimitiveName, Target};

/// One primitive that `installs.json` references but whose library directory
/// is gone from disk. `install_targets` is the list of targets it was tracked
/// at — UI renders them as context so the user knows what they're cleaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MissingPrimitive {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub install_targets: Vec<Target>,
}

/// Walk every `(kind, name)` referenced in `installs` and report the ones
/// whose library directory no longer exists on disk. Output is sorted by
/// `(kind, name)` for stable UI rendering.
///
/// Single duplicate target collapses to one entry — `install_targets` is
/// deduped before return.
pub fn scan_library_drift(
    layout: LibraryLayout<'_>,
    installs: &InstallsFile,
) -> Vec<MissingPrimitive> {
    let mut by_key: HashMap<(PrimitiveKind, PrimitiveName), Vec<Target>> = HashMap::new();
    for record in &installs.records {
        by_key
            .entry((record.kind, record.name.clone()))
            .or_default()
            .push(record.target);
    }
    let mut missing: Vec<MissingPrimitive> = by_key
        .into_iter()
        .filter_map(|((kind, name), mut targets)| {
            if layout.primitive_dir(kind, &name).exists() {
                return None;
            }
            targets.sort_by_key(|t| *t as u8);
            targets.dedup();
            Some(MissingPrimitive {
                kind,
                name,
                install_targets: targets,
            })
        })
        .collect();
    missing.sort_by(|a, b| {
        (a.kind as u8, a.name.as_str()).cmp(&(b.kind as u8, b.name.as_str()))
    });
    missing
}

/// Drop every install record matching `(kind, name)` from `installs.json`.
/// Used by the Reconcile dialog's "Mark removed" action — the on-disk
/// installed copies are *not* touched (the primitive's library directory is
/// already gone, so the source of truth for an uninstall doesn't exist).
///
/// Returns `Ok(true)` if any record was removed, `Ok(false)` if the install
/// state had no records for that pair (idempotent).
pub fn forget_primitive(
    installs_file_path: &Utf8Path,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<bool, Error> {
    let mut installs = InstallsFile::load(installs_file_path)?;
    let before = installs.records.len();
    installs
        .records
        .retain(|r| !(r.kind == kind && &r.name == name));
    let removed = installs.records.len() != before;
    if removed {
        installs.save(installs_file_path)?;
    }
    Ok(removed)
}

pub struct DeletePrimitiveRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub install_paths: &'a InstallPaths,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub name: &'a PrimitiveName,
}

/// Result of a [`delete_primitive`] call. The uninstall summary is the same
/// shape `uninstall` returns (per-target outcomes + failures); the bool
/// reports whether the library directory existed and was removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeletePrimitiveSummary {
    pub uninstall: UninstallSummary,
    pub library_dir_removed: bool,
}

/// Wipe `(kind, name)` from the library entirely: uninstall every recorded
/// target with `force=true` (the user has consented to drift loss by
/// confirming the destructive action), `rm -rf` the library directory, and
/// clear any remaining install records.
///
/// Skips `rm -rf` and the final `forget_primitive` call if any per-target
/// uninstall ended in `failures` — those are real I/O errors and the caller
/// should see them before we go further. Drift outcomes are not failures and
/// don't gate the directory removal because we always force.
pub fn delete_primitive(
    req: DeletePrimitiveRequest<'_>,
) -> Result<DeletePrimitiveSummary, Error> {
    let installs = InstallsFile::load(req.installs_file_path)?;
    let mut targets: Vec<Target> = installs
        .records
        .iter()
        .filter(|r| r.kind == req.kind && &r.name == req.name)
        .map(|r| r.target)
        .collect();
    targets.sort_by_key(|t| *t as u8);
    targets.dedup();

    let uninstall_summary = uninstall(UninstallRequest {
        install_paths: req.install_paths,
        installs_file_path: req.installs_file_path,
        kind: req.kind,
        name: req.name,
        targets: &targets,
        force: true,
    })?;

    if !uninstall_summary.failures.is_empty() {
        return Ok(DeletePrimitiveSummary {
            uninstall: uninstall_summary,
            library_dir_removed: false,
        });
    }

    let dir = req.layout.primitive_dir(req.kind, req.name);
    let library_dir_removed = if dir.exists() {
        std::fs::remove_dir_all(dir.as_std_path()).map_err(|source| Error::Io {
            path: dir.to_string(),
            source,
        })?;
        true
    } else {
        false
    };

    // Idempotent — uninstall already pruned per-target records on success;
    // this catches anything stale that uninstall didn't touch (e.g. a record
    // pointing at an unsupported KindTarget after a matrix change).
    forget_primitive(req.installs_file_path, req.kind, req.name)?;

    Ok(DeletePrimitiveSummary {
        uninstall: uninstall_summary,
        library_dir_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_state::InstallRecord;
    use crate::scaffold::scaffold_skill;
    use crate::VersionLabel;
    use camino::Utf8PathBuf;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
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
    fn empty_installs_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        assert_eq!(
            scan_library_drift(layout, &InstallsFile::default()),
            vec![]
        );
    }

    #[test]
    fn primitive_present_on_disk_is_not_missing() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let n = name("diagnose");
        scaffold_skill(layout, &n, "2026-05-04T00:00:00Z").unwrap();

        let installs = InstallsFile {
            records: vec![record(PrimitiveKind::Skill, "diagnose", Target::Claude)],
            ..Default::default()
        };
        assert_eq!(scan_library_drift(layout, &installs), vec![]);
    }

    #[test]
    fn primitive_referenced_but_dir_missing_is_reported() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let installs = InstallsFile {
            records: vec![record(PrimitiveKind::Skill, "diagnose", Target::Claude)],
            ..Default::default()
        };
        let missing = scan_library_drift(layout, &installs);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].kind, PrimitiveKind::Skill);
        assert_eq!(missing[0].name.as_str(), "diagnose");
        assert_eq!(missing[0].install_targets, vec![Target::Claude]);
    }

    #[test]
    fn multiple_targets_for_same_primitive_collapse_into_one_entry() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let installs = InstallsFile {
            records: vec![
                record(PrimitiveKind::Skill, "diagnose", Target::Claude),
                record(PrimitiveKind::Skill, "diagnose", Target::Pi),
                record(PrimitiveKind::Skill, "diagnose", Target::Codex),
            ],
            ..Default::default()
        };
        let missing = scan_library_drift(layout, &installs);
        assert_eq!(missing.len(), 1);
        assert_eq!(
            missing[0].install_targets,
            vec![Target::Claude, Target::Pi, Target::Codex],
        );
    }

    #[test]
    fn results_sorted_by_kind_then_name() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let installs = InstallsFile {
            records: vec![
                record(PrimitiveKind::Command, "zeta", Target::Claude),
                record(PrimitiveKind::Skill, "alpha", Target::Claude),
                record(PrimitiveKind::Skill, "mu", Target::Claude),
            ],
            ..Default::default()
        };
        let missing = scan_library_drift(layout, &installs);
        let names: Vec<_> = missing.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "mu", "zeta"]);
    }

    #[test]
    fn forget_primitive_drops_all_targets_and_returns_true() {
        let tmp = TempDir::new().unwrap();
        let installs_path =
            Utf8PathBuf::from_path_buf(tmp.path().join("installs.json")).unwrap();

        let original = InstallsFile {
            records: vec![
                record(PrimitiveKind::Skill, "diagnose", Target::Claude),
                record(PrimitiveKind::Skill, "diagnose", Target::Pi),
                record(PrimitiveKind::Skill, "keep", Target::Claude),
            ],
            ..Default::default()
        };
        original.save(&installs_path).unwrap();

        let removed =
            forget_primitive(&installs_path, PrimitiveKind::Skill, &name("diagnose")).unwrap();
        assert!(removed);

        let after = InstallsFile::load(&installs_path).unwrap();
        assert_eq!(after.records.len(), 1);
        assert_eq!(after.records[0].name.as_str(), "keep");
    }

    #[test]
    fn forget_primitive_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let installs_path =
            Utf8PathBuf::from_path_buf(tmp.path().join("installs.json")).unwrap();
        InstallsFile::default().save(&installs_path).unwrap();

        let removed =
            forget_primitive(&installs_path, PrimitiveKind::Skill, &name("never")).unwrap();
        assert!(!removed);
    }

    /// Helper for delete_primitive tests: builds a fresh library + installs
    /// file in `tmp` and returns the paths plus an [`InstallPaths`] rooted at
    /// a synthetic home (the uninstall path treats missing on-disk installs
    /// as already-removed, so we don't need a real materialized install).
    fn delete_fixture(
        tmp: &TempDir,
    ) -> (Utf8PathBuf, Utf8PathBuf, InstallPaths) {
        let library_root = root(tmp);
        let installs_path =
            Utf8PathBuf::from_path_buf(tmp.path().join("installs.json")).unwrap();
        let home =
            Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        (library_root, installs_path, InstallPaths::new(home))
    }

    #[test]
    fn delete_primitive_with_no_installs_removes_library_dir() {
        let tmp = TempDir::new().unwrap();
        let (library_root, installs_path, install_paths) = delete_fixture(&tmp);
        let layout = LibraryLayout::new(&library_root);
        let n = name("diagnose");
        scaffold_skill(layout, &n, "2026-05-04T00:00:00Z").unwrap();
        InstallsFile::default().save(&installs_path).unwrap();

        let summary = delete_primitive(DeletePrimitiveRequest {
            layout,
            install_paths: &install_paths,
            installs_file_path: &installs_path,
            kind: PrimitiveKind::Skill,
            name: &n,
        })
        .unwrap();

        assert!(summary.library_dir_removed);
        assert!(summary.uninstall.successes.is_empty());
        assert!(summary.uninstall.failures.is_empty());
        assert!(!layout.primitive_dir(PrimitiveKind::Skill, &n).exists());
    }

    #[test]
    fn delete_primitive_uninstalls_recorded_targets_and_drops_records() {
        let tmp = TempDir::new().unwrap();
        let (library_root, installs_path, install_paths) = delete_fixture(&tmp);
        let layout = LibraryLayout::new(&library_root);
        let n = name("diagnose");
        scaffold_skill(layout, &n, "2026-05-04T00:00:00Z").unwrap();
        let installs = InstallsFile {
            records: vec![
                record(PrimitiveKind::Skill, "diagnose", Target::Claude),
                record(PrimitiveKind::Skill, "diagnose", Target::Pi),
                record(PrimitiveKind::Skill, "keep", Target::Claude),
            ],
            ..Default::default()
        };
        installs.save(&installs_path).unwrap();

        let summary = delete_primitive(DeletePrimitiveRequest {
            layout,
            install_paths: &install_paths,
            installs_file_path: &installs_path,
            kind: PrimitiveKind::Skill,
            name: &n,
        })
        .unwrap();

        assert!(summary.library_dir_removed);
        assert_eq!(summary.uninstall.successes.len(), 2);
        assert!(summary.uninstall.failures.is_empty());

        let after = InstallsFile::load(&installs_path).unwrap();
        assert_eq!(after.records.len(), 1);
        assert_eq!(after.records[0].name.as_str(), "keep");
    }

    #[test]
    fn delete_primitive_when_library_dir_already_missing_is_no_op_ish() {
        let tmp = TempDir::new().unwrap();
        let (library_root, installs_path, install_paths) = delete_fixture(&tmp);
        let layout = LibraryLayout::new(&library_root);
        let n = name("ghost");
        InstallsFile::default().save(&installs_path).unwrap();

        let summary = delete_primitive(DeletePrimitiveRequest {
            layout,
            install_paths: &install_paths,
            installs_file_path: &installs_path,
            kind: PrimitiveKind::Skill,
            name: &n,
        })
        .unwrap();

        assert!(!summary.library_dir_removed);
        assert!(summary.uninstall.successes.is_empty());
        assert!(summary.uninstall.failures.is_empty());
    }
}
