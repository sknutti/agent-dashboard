use std::collections::BTreeMap;
use std::fs::OpenOptions;

use camino::{Utf8Path, Utf8PathBuf};
use fd_lock::RwLock;
use serde::{Deserialize, Serialize};

use crate::fs_helpers::atomic_write;
use crate::kind_target::{InstallLayout, KindTarget};
use crate::{Error, PrimitiveKind, PrimitiveName, Target, VersionLabel};

/// Current schema version of `installs.json`. Bump on breaking changes.
pub const FORMAT_VERSION: u32 = 1;

/// Per-target install state for a single primitive.
///
/// Multiple records can share `(kind, name)` — one per target the primitive
/// has been installed to. The tuple `(kind, name, target)` is the unique key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallRecord {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub target: Target,
    pub installed_version: VersionLabel,
    /// Hashes of the bytes we wrote, keyed by relpath under the install
    /// destination. Single-file installs use the single key `""` (empty
    /// relpath). Always BTreeMap so JSON output is stable for diff-friendly
    /// review.
    pub file_hashes: BTreeMap<Utf8PathBuf, String>,
    /// Re-hash of the install path immediately *after* the rename completes
    /// (TOCTOU mitigation per plan: drift self-corrects on next launch by
    /// updating from post-write reality, not from what we intended to write).
    pub last_known_install_hashes: BTreeMap<Utf8PathBuf, String>,
    /// Modification times observed at install/scan time (seconds since epoch).
    /// Drift detection mtime-gates the re-hash using this map.
    pub mtimes: BTreeMap<Utf8PathBuf, i64>,
    /// RFC3339 UTC timestamp of the install.
    pub installed_at: String,
}

impl InstallRecord {
    /// The KindTarget slot this record was installed at. Infallible — the
    /// record was created with a legal pair (`installer::install` constructs
    /// records via `KindTarget::new`).
    pub fn kind_target(&self) -> KindTarget {
        KindTarget::new(self.kind, self.target)
            .expect("InstallRecord constructed with legal (kind, target) by installer")
    }

    /// The on-disk layout this record represents. Static for 7 of 8
    /// KindTargets; for `(Agent, Claude)` it reads the record shape — a
    /// single empty-key entry in `last_known_install_hashes` means the
    /// flatten rule fired at install time.
    pub fn layout(&self) -> InstallLayout {
        if let Some(fixed) = self.kind_target().fixed_layout() {
            return fixed;
        }
        // (Agent, Claude): adaptive — derive from the record shape.
        if self.last_known_install_hashes.len() == 1
            && self
                .last_known_install_hashes
                .contains_key(Utf8Path::new(""))
        {
            InstallLayout::SingleFile
        } else {
            InstallLayout::Directory
        }
    }
}

/// Top-level shape of `installs.json`. Versioned to allow forward-compatible
/// schema bumps; readers should fall back to a rebuild on a version mismatch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallsFile {
    pub format_version: u32,
    pub records: Vec<InstallRecord>,
}

impl Default for InstallsFile {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            records: Vec::new(),
        }
    }
}

impl InstallsFile {
    /// Load `installs.json` from `path`. Returns `Self::default()` when the
    /// file does not exist (no installs yet). Parse errors surface as
    /// `Error::InstallsParse` so the caller can decide whether to rebuild from
    /// disk or surface the error to the user (P4.2 wraps with rebuild).
    pub fn load(path: &Utf8Path) -> Result<Self, Error> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| Error::InstallsParse(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(source) => Err(Error::Io {
                path: path.to_string(),
                source,
            }),
        }
    }

    /// Save atomically (temp file + rename) under an exclusive `fd-lock`
    /// advisory lock held on a `.lock` sidecar. The lock prevents concurrent
    /// writers (e.g. two app processes launching simultaneously) from
    /// interleaving partial state.
    pub fn save(&self, path: &Utf8Path) -> Result<(), Error> {
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| Error::InstallsSerialize(e.to_string()))?;

        let lock_path = lock_sidecar(path);
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| Error::Io {
                path: parent.to_string(),
                source,
            })?;
        }
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path.as_std_path())
            .map_err(|source| Error::Io {
                path: lock_path.to_string(),
                source,
            })?;
        let mut lock = RwLock::new(lock_file);
        let _guard = lock.write().map_err(|source| Error::Io {
            path: lock_path.to_string(),
            source,
        })?;

        atomic_write(path, &body)
    }

    /// Replace the record matching `(kind, name, target)` if present; else
    /// append. The unique-key invariant (one record per triple) is enforced
    /// here so callers don't have to.
    pub fn upsert(&mut self, record: InstallRecord) {
        if let Some(slot) = self.records.iter_mut().find(|r| {
            r.kind == record.kind && r.name == record.name && r.target == record.target
        }) {
            *slot = record;
        } else {
            self.records.push(record);
        }
    }

    /// Drop the record matching `(kind, name, target)`. Returns true if a
    /// record was removed.
    pub fn remove(&mut self, kind: PrimitiveKind, name: &PrimitiveName, target: Target) -> bool {
        let before = self.records.len();
        self.records
            .retain(|r| !(r.kind == kind && &r.name == name && r.target == target));
        self.records.len() != before
    }

    /// Look up the record for `(kind, name, target)`, if any.
    pub fn get(
        &self,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        target: Target,
    ) -> Option<&InstallRecord> {
        self.records
            .iter()
            .find(|r| r.kind == kind && &r.name == name && r.target == target)
    }
}

fn lock_sidecar(path: &Utf8Path) -> Utf8PathBuf {
    let parent = path.parent().unwrap_or(Utf8Path::new("."));
    let leaf = path.file_name().unwrap_or("installs.json");
    parent.join(format!("{leaf}.lock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn installs_path(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().join("installs.json")).unwrap()
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn version(s: &str) -> VersionLabel {
        VersionLabel::try_new(s).unwrap()
    }

    fn sample_record() -> InstallRecord {
        let mut file_hashes = BTreeMap::new();
        file_hashes.insert(Utf8PathBuf::from("SKILL.md"), "abc123".into());
        let mtimes = {
            let mut m = BTreeMap::new();
            m.insert(Utf8PathBuf::from("SKILL.md"), 1_714_588_800);
            m
        };
        InstallRecord {
            kind: PrimitiveKind::Skill,
            name: name("diagnose"),
            target: Target::Claude,
            installed_version: version("v1"),
            file_hashes: file_hashes.clone(),
            last_known_install_hashes: file_hashes,
            mtimes,
            installed_at: "2026-04-30T19:02:00Z".into(),
        }
    }

    #[test]
    fn load_returns_default_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let loaded = InstallsFile::load(&installs_path(&tmp)).unwrap();
        assert_eq!(loaded, InstallsFile::default());
        assert_eq!(loaded.format_version, FORMAT_VERSION);
        assert!(loaded.records.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_a_populated_record() {
        let tmp = TempDir::new().unwrap();
        let path = installs_path(&tmp);
        let original = InstallsFile {
            format_version: FORMAT_VERSION,
            records: vec![sample_record()],
        };
        original.save(&path).unwrap();
        let loaded = InstallsFile::load(&path).unwrap();
        assert_eq!(loaded, original);
    }

    #[test]
    fn save_creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let nested = Utf8PathBuf::from_path_buf(
            tmp.path().join("does/not/exist/installs.json"),
        )
        .unwrap();
        InstallsFile::default().save(&nested).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn load_surfaces_parse_error_on_garbage() {
        let tmp = TempDir::new().unwrap();
        let path = installs_path(&tmp);
        std::fs::write(&path, b"not valid json").unwrap();
        let err = InstallsFile::load(&path).unwrap_err();
        assert!(matches!(err, Error::InstallsParse(_)), "got {err:?}");
    }

    #[test]
    fn upsert_replaces_matching_kind_name_target() {
        let mut file = InstallsFile::default();
        file.upsert(sample_record());

        let mut updated = sample_record();
        updated.installed_version = version("v2");
        updated.installed_at = "2026-05-04T17:00:00Z".into();
        file.upsert(updated.clone());

        assert_eq!(file.records.len(), 1, "should not duplicate");
        assert_eq!(file.records[0], updated);
    }

    #[test]
    fn upsert_appends_when_target_differs() {
        let mut file = InstallsFile::default();
        file.upsert(sample_record());

        let mut other_target = sample_record();
        other_target.target = Target::Pi;
        file.upsert(other_target.clone());

        assert_eq!(file.records.len(), 2);
        assert_eq!(
            file.get(PrimitiveKind::Skill, &name("diagnose"), Target::Claude),
            Some(&sample_record()),
        );
        assert_eq!(
            file.get(PrimitiveKind::Skill, &name("diagnose"), Target::Pi),
            Some(&other_target),
        );
    }

    #[test]
    fn remove_drops_matching_record_and_returns_true() {
        let mut file = InstallsFile::default();
        file.upsert(sample_record());
        let mut other_target = sample_record();
        other_target.target = Target::Pi;
        file.upsert(other_target);

        assert!(file.remove(PrimitiveKind::Skill, &name("diagnose"), Target::Claude));
        assert_eq!(file.records.len(), 1);
        assert_eq!(file.records[0].target, Target::Pi);

        // Re-removing the same triple is a no-op and returns false.
        assert!(!file.remove(PrimitiveKind::Skill, &name("diagnose"), Target::Claude));
    }

    #[test]
    fn save_writes_lock_sidecar_alongside_installs_json() {
        let tmp = TempDir::new().unwrap();
        let path = installs_path(&tmp);
        InstallsFile::default().save(&path).unwrap();
        let sidecar = path.parent().unwrap().join("installs.json.lock");
        assert!(sidecar.exists(), "advisory lock sidecar should exist");
    }
}
