//! Drift detection for installed primitives.
//!
//! "Drift" = the on-disk install no longer matches what we recorded in
//! `installs.json`. Either a file's content was changed out-of-band, the
//! whole install path was deleted, or a new file appeared under a
//! directory install.
//!
//! Hashing is mtime-gated: if the recorded mtime matches what's on disk we
//! skip the hash entirely. This keeps a refresh of dozens of installs
//! ~free in the steady state. Only when mtime changes do we open the file
//! and re-hash. A touched-but-identical file (mtime bumped, content same)
//! still reports `Clean` — that's the whole point of the second hash
//! check.

use std::collections::BTreeMap;
use std::fs;
use std::time::UNIX_EPOCH;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::install_paths::InstallPaths;
use crate::install_state::{InstallRecord, InstallsFile};
use crate::kind_target::InstallLayout;
use crate::{is_ignored, Error, PrimitiveKind, PrimitiveName, Target};

/// One `(kind, name, target)` install's drift status. Kept flat per-target
/// so the inspector can render one badge per row without grouping logic on
/// the UI side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DriftReport {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub target: Target,
    pub status: DriftStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriftStatus {
    /// All recorded files exist with matching hashes (or only mtime changed).
    Clean,
    /// At least one file's hash diverges from `last_known_install_hashes`,
    /// or an unexpected file appeared under a directory install.
    Modified { conflicts: Vec<String> },
    /// The install path is gone entirely (or the recorded files within it
    /// are missing). Distinct from `Modified` so the UI can show
    /// "uninstalled externally" vs "edited externally".
    Missing { missing: Vec<String> },
}

/// Scan every record matching `(kind, name)` and report each target's
/// drift status. Returns an empty vec if nothing's installed for the
/// primitive.
pub fn scan_drift_for_primitive(
    install_paths: &InstallPaths,
    installs_file_path: &Utf8Path,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<Vec<DriftReport>, Error> {
    let installs = InstallsFile::load(installs_file_path)?;
    let mut out = Vec::new();
    for record in installs.records.iter() {
        if record.kind != kind || &record.name != name {
            continue;
        }
        let status = scan_one(install_paths, record)?;
        out.push(DriftReport {
            kind: record.kind,
            name: record.name.clone(),
            target: record.target,
            status,
        });
    }
    Ok(out)
}

/// Update the record's `last_known_install_hashes` and `mtimes` to the
/// current on-disk reality. The "Ignore" affordance: the user has decided
/// the on-disk content is the new truth, so future scans should not flag
/// it. Errors if the install path is gone (use uninstall instead).
pub fn acknowledge_drift(
    install_paths: &InstallPaths,
    installs_file_path: &Utf8Path,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    target: Target,
) -> Result<(), Error> {
    let mut installs = InstallsFile::load(installs_file_path)?;
    let Some(record) = installs.get(kind, name, target).cloned() else {
        return Err(Error::NoInstallRecord {
            kind,
            name: name.as_str().to_string(),
            target,
        });
    };

    let layout = record.layout();
    let single_file = matches!(layout, InstallLayout::SingleFile);
    let dest = record.kind_target().path_for(install_paths, name, layout);

    let (hashes, mtimes) = collect_disk_state(&dest, single_file, &record)
        .map_err(|(path, source)| Error::Io {
            path: path.to_string(),
            source,
        })?;

    let mut updated = record;
    updated.last_known_install_hashes = hashes;
    updated.mtimes = mtimes;
    installs.upsert(updated);
    installs.save(installs_file_path)?;
    Ok(())
}

/// Scan a single install record's on-disk state. Used by both the
/// per-primitive synchronous scan and the background channel scanner — the
/// latter parallelises this across `JoinSet` workers.
pub fn scan_record(
    install_paths: &InstallPaths,
    record: &InstallRecord,
) -> Result<DriftStatus, Error> {
    scan_one(install_paths, record)
}

fn scan_one(install_paths: &InstallPaths, record: &InstallRecord) -> Result<DriftStatus, Error> {
    let layout = record.layout();
    let single_file = matches!(layout, InstallLayout::SingleFile);
    let dest = record
        .kind_target()
        .path_for(install_paths, &record.name, layout);

    if !dest.exists() {
        let missing: Vec<String> = if single_file {
            vec![String::new()]
        } else {
            record
                .last_known_install_hashes
                .keys()
                .map(|p| p.to_string())
                .collect()
        };
        return Ok(DriftStatus::Missing { missing });
    }

    let mut conflicts = Vec::new();
    let mut missing = Vec::new();

    if single_file {
        let key = Utf8PathBuf::new();
        let expected_hash = record
            .last_known_install_hashes
            .get(&key)
            .expect("single-file record always has empty-key hash; guaranteed by InstallRecord::layout");
        let recorded_mtime = record.mtimes.get(&key).copied();
        match check_path(&dest, expected_hash, recorded_mtime).map_err(io_err)? {
            FileCheck::Match => {}
            FileCheck::Modified => conflicts.push(String::new()),
            FileCheck::Missing => missing.push(String::new()),
        }
    } else {
        for (rel, expected_hash) in &record.last_known_install_hashes {
            let path = dest.join(rel);
            let recorded_mtime = record.mtimes.get(rel).copied();
            match check_path(&path, expected_hash, recorded_mtime).map_err(io_err)? {
                FileCheck::Match => {}
                FileCheck::Modified => conflicts.push(rel.to_string()),
                FileCheck::Missing => missing.push(rel.to_string()),
            }
        }
        // Anything under `dest` that we didn't install is also drift —
        // user added junk that a `force=true` reinstall would wipe.
        let extras = walk_files(&dest, &dest).map_err(io_err)?;
        for rel in extras {
            if !record.last_known_install_hashes.contains_key(&rel) {
                conflicts.push(rel.to_string());
            }
        }
    }

    if conflicts.is_empty() && missing.is_empty() {
        Ok(DriftStatus::Clean)
    } else if conflicts.is_empty() {
        Ok(DriftStatus::Missing { missing })
    } else {
        // Mixed missing+modified: surface as Modified — UI's "Reset to
        // library" force-reinstall fixes both.
        let mut all = conflicts;
        all.extend(missing);
        Ok(DriftStatus::Modified { conflicts: all })
    }
}

enum FileCheck {
    Match,
    Modified,
    Missing,
}

/// Stat + (maybe) re-hash a single file. Mtime-gated: if the on-disk mtime
/// equals `recorded_mtime`, we trust the hash and skip the read. The hash
/// re-check is only paid when something has actually been written.
fn check_path(
    path: &Utf8Path,
    expected_hash: &str,
    recorded_mtime: Option<i64>,
) -> Result<FileCheck, (Utf8PathBuf, std::io::Error)> {
    let meta = match fs::metadata(path.as_std_path()) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileCheck::Missing)
        }
        Err(e) => return Err((path.to_owned(), e)),
    };
    let mtime = meta
        .modified()
        .map_err(|e| (path.to_owned(), e))?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if recorded_mtime == Some(mtime) && mtime != 0 {
        return Ok(FileCheck::Match);
    }
    let bytes = fs::read(path.as_std_path()).map_err(|e| (path.to_owned(), e))?;
    let h = blake3::hash(&bytes).to_hex().to_string();
    Ok(if h == expected_hash {
        FileCheck::Match
    } else {
        FileCheck::Modified
    })
}

type DiskState = (BTreeMap<Utf8PathBuf, String>, BTreeMap<Utf8PathBuf, i64>);
type DiskStateError = (Utf8PathBuf, std::io::Error);

fn collect_disk_state(
    dest: &Utf8Path,
    single_file: bool,
    record: &InstallRecord,
) -> Result<DiskState, DiskStateError> {
    let mut hashes = BTreeMap::new();
    let mut mtimes = BTreeMap::new();
    if single_file {
        let bytes = fs::read(dest.as_std_path()).map_err(|e| (dest.to_owned(), e))?;
        hashes.insert(
            Utf8PathBuf::new(),
            blake3::hash(&bytes).to_hex().to_string(),
        );
        mtimes.insert(Utf8PathBuf::new(), mtime_of(dest)?);
    } else {
        // Walk the install root to capture every file currently there,
        // including ones the user added (so future scans treat them as
        // expected baseline).
        let walked = walk_files(dest, dest)?;
        let mut all_keys: Vec<Utf8PathBuf> =
            record.last_known_install_hashes.keys().cloned().collect();
        for w in walked {
            if !record.last_known_install_hashes.contains_key(&w) {
                all_keys.push(w);
            }
        }
        for rel in all_keys {
            let path = dest.join(&rel);
            match fs::read(path.as_std_path()) {
                Ok(bytes) => {
                    hashes.insert(rel.clone(), blake3::hash(&bytes).to_hex().to_string());
                    mtimes.insert(rel, mtime_of(&path)?);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // File was in the record but is now gone — drop it
                    // from the new baseline.
                }
                Err(e) => return Err((path, e)),
            }
        }
    }
    Ok((hashes, mtimes))
}

fn mtime_of(path: &Utf8Path) -> Result<i64, (Utf8PathBuf, std::io::Error)> {
    let meta = fs::metadata(path.as_std_path()).map_err(|e| (path.to_owned(), e))?;
    let mtime = meta.modified().map_err(|e| (path.to_owned(), e))?;
    Ok(mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0))
}

fn walk_files(
    root: &Utf8Path,
    cur: &Utf8Path,
) -> Result<Vec<Utf8PathBuf>, (Utf8PathBuf, std::io::Error)> {
    let mut out = Vec::new();
    let entries = fs::read_dir(cur.as_std_path()).map_err(|e| (cur.to_owned(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| (cur.to_owned(), e))?;
        let path = Utf8PathBuf::from_path_buf(entry.path()).map_err(|p| {
            (
                Utf8PathBuf::from(p.to_string_lossy().as_ref()),
                std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF-8 path"),
            )
        })?;
        let rel = path
            .strip_prefix(root)
            .expect("walked under root")
            .to_owned();
        if is_ignored(&rel) {
            continue;
        }
        let ft = entry.file_type().map_err(|e| (path.clone(), e))?;
        if ft.is_dir() {
            out.extend(walk_files(root, &path)?);
        } else if ft.is_file() {
            out.push(rel);
        }
    }
    Ok(out)
}

fn io_err(
    (path, source): (Utf8PathBuf, std::io::Error),
) -> Error {
    Error::Io {
        path: path.to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::{install, InstallRequest};
    use crate::scaffold::scaffold_skill;
    use crate::version_store::{VersionMetadata, VersionStore};
    use crate::working_copy::WorkingCopy;
    use crate::{
        update_primitive_metadata, MetadataUpdate, PrimitiveKind, PrimitiveName, Target,
        VersionLabel,
    };
    use tempfile::TempDir;

    struct Fixture {
        _lib: TempDir,
        _home: TempDir,
        lib_root: Utf8PathBuf,
        home: Utf8PathBuf,
        installs_path: Utf8PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let lib = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            let lib_root = Utf8PathBuf::from_path_buf(lib.path().to_path_buf()).unwrap();
            let home_path = Utf8PathBuf::from_path_buf(home.path().to_path_buf()).unwrap();
            let installs_path = home_path.join("installs.json");
            Self {
                _lib: lib,
                _home: home,
                lib_root,
                home: home_path,
                installs_path,
            }
        }

        fn layout(&self) -> crate::LibraryLayout<'_> {
            crate::LibraryLayout::new(&self.lib_root)
        }

        fn install_paths(&self) -> InstallPaths {
            InstallPaths::new(&self.home)
        }
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn label(s: &str) -> VersionLabel {
        VersionLabel::try_new(s).unwrap()
    }

    fn install_a_skill(fx: &Fixture, allowed: Vec<Target>) -> PrimitiveName {
        let n = name("diagnose");
        scaffold_skill(fx.layout(), &n, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody-v1\n",
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Skill,
            &n,
            MetadataUpdate {
                allowed_targets: allowed.clone(),
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let store = VersionStore::new(fx.layout());
        store
            .snapshot(
                PrimitiveKind::Skill,
                &n,
                &label("v1"),
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();
        let ip = fx.install_paths();
        install(InstallRequest {
            layout: fx.layout(),
            install_paths: &ip,
            installs_file_path: &fx.installs_path,
            kind: PrimitiveKind::Skill,
            name: &n,
            targets: &allowed,
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();
        n
    }

    #[test]
    fn scan_returns_empty_when_no_records_exist() {
        let fx = Fixture::new();
        let n = name("nope");
        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert!(reports.is_empty());
    }

    #[test]
    fn fresh_install_scans_clean() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].target, Target::Claude);
        assert_eq!(reports[0].status, DriftStatus::Clean);
    }

    #[test]
    fn modified_file_scans_modified() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        // Sleep a tick so APFS records a different mtime than install
        // wrote it with — otherwise the mtime fast-path masks the hash.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        match &reports[0].status {
            DriftStatus::Modified { conflicts } => {
                assert!(
                    conflicts.iter().any(|c| c == "SKILL.md"),
                    "got: {conflicts:?}"
                );
            }
            other => panic!("expected Modified, got {other:?}"),
        }
    }

    #[test]
    fn deleted_install_path_scans_missing() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        std::fs::remove_dir_all(
            fx.home.join(".claude/skills/diagnose").as_std_path(),
        )
        .unwrap();

        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert!(matches!(reports[0].status, DriftStatus::Missing { .. }));
    }

    #[test]
    fn extra_file_under_dir_install_is_modified() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/EXTRA.md")
                .as_std_path(),
            b"junk",
        )
        .unwrap();

        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        match &reports[0].status {
            DriftStatus::Modified { conflicts } => {
                assert!(
                    conflicts.iter().any(|c| c == "EXTRA.md"),
                    "got: {conflicts:?}"
                );
            }
            other => panic!("expected Modified, got {other:?}"),
        }
    }

    #[test]
    fn touched_but_identical_content_still_scans_clean() {
        // mtime changes but bytes are the same — drift scanner re-hashes
        // because mtime diverges, then accepts because hash matches.
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");

        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Re-write identical bytes to bump mtime.
        let bytes = std::fs::read(installed.as_std_path()).unwrap();
        std::fs::write(installed.as_std_path(), &bytes).unwrap();

        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert_eq!(reports[0].status, DriftStatus::Clean);
    }

    #[test]
    fn acknowledge_drift_makes_subsequent_scan_clean() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-version\n").unwrap();

        // Confirm scan sees Modified first.
        let pre = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert!(matches!(pre[0].status, DriftStatus::Modified { .. }));

        acknowledge_drift(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
            Target::Claude,
        )
        .unwrap();

        let post = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert_eq!(post[0].status, DriftStatus::Clean);
    }

    #[test]
    fn acknowledge_includes_extras_in_new_baseline() {
        let fx = Fixture::new();
        let n = install_a_skill(&fx, vec![Target::Claude]);
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/EXTRA.md")
                .as_std_path(),
            b"now part of the truth",
        )
        .unwrap();
        acknowledge_drift(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
            Target::Claude,
        )
        .unwrap();
        let reports = scan_drift_for_primitive(
            &fx.install_paths(),
            &fx.installs_path,
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
        assert_eq!(reports[0].status, DriftStatus::Clean);
    }
}
