//! Per-target install orchestrator.
//!
//! Materializes a primitive at its current pinned version, hash-compares the
//! bytes against what's already on disk at the install path, and stages +
//! atomic-renames the new content into place. Each target is processed
//! independently — a failure on one target does not roll back another.
//!
//! `Installer::install` is pure-sync, takes a `LibraryLayout` and an
//! `InstallPaths` plus a path to `installs.json`, and returns an
//! `InstallSummary` with per-target outcomes. The Tauri command layer wraps
//! this in `spawn_blocking` and feeds the summary back to the UI.

use std::collections::BTreeMap;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::fs_helpers::atomic_write;
use crate::install_paths::InstallPaths;
use crate::install_state::{InstallRecord, InstallsFile};
use crate::kind_target::{InstallLayout, KindTarget};
use crate::materializer::materialize;
use crate::metadata::PrimitiveMetadata;
use crate::version_store::VersionStore;
use crate::{
    is_ignored, Error, LibraryLayout, PrimitiveKind, PrimitiveName, Target, VersionLabel,
};

/// Per-primitive aggregate result of `install`. Successes and failures live
/// in separate vecs per the plan (UI shows each list distinctly with retry
/// affordance per failure).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InstallSummary {
    pub successes: Vec<TargetResult>,
    pub failures: Vec<TargetFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TargetResult {
    pub target: Target,
    pub outcome: TargetOutcome,
}

/// What happened (or didn't) for one target. `CollidingContent` is *not* a
/// failure — it's a normal result the UI uses to prompt the user, who then
/// re-issues the call with `force = true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TargetOutcome {
    /// Bytes were written (or were already correct under `force`).
    Installed { version: VersionLabel },
    /// On-disk content already matched; no write performed.
    NoOpIdentical { version: VersionLabel },
    /// Existing files differ from what we would write. Lists the conflicting
    /// install-relative paths so the UI can show a diff/overwrite prompt.
    /// Paths are strings (not `Utf8PathBuf`) so the type can cross the IPC
    /// boundary via specta — `Utf8PathBuf` lacks a `Type` impl.
    CollidingContent {
        version: VersionLabel,
        conflicts: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TargetFailure {
    pub target: Target,
    pub reason: InstallFailureKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallFailureKind {
    /// Pre-flight `metadata` check found a directory where we expected a
    /// file (or vice versa). Aborts before any write per plan: "Never
    /// blindly delete."
    OccupiedByUnexpectedKind {
        path: String,
        expected: String,
        actual: String,
    },
    Io {
        path: String,
        message: String,
    },
    Other {
        message: String,
    },
}

/// Inputs to `install`. Bundled into a struct so the call site is readable
/// and additional fields (e.g. `dry_run`) can be added without rippling.
pub struct InstallRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub install_paths: &'a InstallPaths,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub name: &'a PrimitiveName,
    pub targets: &'a [Target],
    /// On `false`, `CollidingContent` is reported and no write happens. On
    /// `true`, the on-disk content is overwritten via stage-and-rename.
    pub force: bool,
    /// RFC3339 UTC timestamp recorded into `installs.json`. Caller passes
    /// from a single clock so tests are deterministic and multiple-target
    /// runs share an `installed_at`.
    pub installed_at: &'a str,
}

/// Drive the install for `targets`, returning per-target outcomes.
///
/// Errors at this top-level signal primitive-wide failures (no current
/// version pinned, metadata.yaml unreadable, installs.json save failed) —
/// per-target failures (io, occupied) live in `summary.failures` instead.
pub fn install(req: InstallRequest<'_>) -> Result<InstallSummary, Error> {
    let metadata_raw = fs::read_to_string(req.layout.primitive_metadata(req.kind, req.name))
        .map_err(|source| Error::Io {
            path: req
                .layout
                .primitive_metadata(req.kind, req.name)
                .to_string(),
            source,
        })?;
    let metadata = PrimitiveMetadata::from_yaml(&metadata_raw)?;

    let store = VersionStore::new(req.layout);
    let label = match store.read_current(req.kind, req.name)? {
        Some(l) => l,
        None => return Err(Error::NoCurrentVersionForInstall),
    };
    let overlay = store.read_version(req.kind, req.name, &label)?;

    let mut installs = InstallsFile::load(req.installs_file_path)?;
    let mut summary = InstallSummary {
        successes: Vec::new(),
        failures: Vec::new(),
    };

    for &target in req.targets {
        match install_one(
            req.install_paths,
            req.kind,
            req.name,
            &metadata.allowed_targets,
            &overlay,
            target,
            &label,
            req.force,
            req.installed_at,
        ) {
            Ok((outcome, maybe_record)) => {
                if let Some(record) = maybe_record {
                    installs.upsert(record);
                }
                summary.successes.push(TargetResult { target, outcome });
            }
            Err(reason) => {
                summary.failures.push(TargetFailure { target, reason });
            }
        }
    }

    installs.save(req.installs_file_path)?;
    Ok(summary)
}

/// Per-primitive aggregate result of `uninstall`. Mirrors `InstallSummary`'s
/// shape so the IPC layer and UI can treat both flows the same way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UninstallSummary {
    pub successes: Vec<TargetUninstallResult>,
    pub failures: Vec<TargetFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TargetUninstallResult {
    pub target: Target,
    pub outcome: UninstallOutcome,
}

/// What happened (or didn't) when removing one target's install. `Drifted` is
/// not a failure — it's a normal result the UI uses to prompt before issuing
/// `force = true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UninstallOutcome {
    /// File/dir removed and record dropped from `installs.json`.
    Removed,
    /// No record existed for `(kind, name, target)`. Idempotent uninstall.
    NotInstalled,
    /// On-disk content differs from the last-known install hashes; the
    /// caller can re-issue with `force = true` to delete anyway. Lists the
    /// install-relative paths whose hashes diverge or that we don't recognize.
    Drifted { conflicts: Vec<String> },
}

pub struct UninstallRequest<'a> {
    pub install_paths: &'a InstallPaths,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub name: &'a PrimitiveName,
    pub targets: &'a [Target],
    /// On `false`, content drift returns `Drifted` and disk is untouched. On
    /// `true`, we delete the install path regardless of drift.
    pub force: bool,
}

/// Drive uninstall for `targets`, returning per-target outcomes. Errors at
/// this top-level are I/O-on-installs.json failures; per-target failures
/// (e.g. mid-walk io) live in `summary.failures`.
pub fn uninstall(req: UninstallRequest<'_>) -> Result<UninstallSummary, Error> {
    let mut installs = InstallsFile::load(req.installs_file_path)?;
    let mut summary = UninstallSummary {
        successes: Vec::new(),
        failures: Vec::new(),
    };

    for &target in req.targets {
        match uninstall_one(req.install_paths, req.kind, req.name, target, &installs, req.force) {
            Ok(outcome) => {
                if matches!(outcome, UninstallOutcome::Removed) {
                    installs.remove(req.kind, req.name, target);
                }
                summary
                    .successes
                    .push(TargetUninstallResult { target, outcome });
            }
            Err(reason) => summary.failures.push(TargetFailure { target, reason }),
        }
    }

    installs.save(req.installs_file_path)?;
    Ok(summary)
}

fn uninstall_one(
    install_paths: &InstallPaths,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    target: Target,
    installs: &InstallsFile,
    force: bool,
) -> Result<UninstallOutcome, InstallFailureKind> {
    let Some(record) = installs.get(kind, name, target) else {
        return Ok(UninstallOutcome::NotInstalled);
    };

    let kt = KindTarget::new(kind, target).ok_or_else(|| {
        other_failure(Error::InstallNotSupported { kind, target })
    })?;
    let layout = record.layout();
    let single_file = matches!(layout, InstallLayout::SingleFile);
    let dest = kt.path_for(install_paths, name, layout);

    // If the path is already gone (user deleted it), treat as success — we
    // still drop the record. Drift-checking a non-existent path doesn't make
    // sense.
    if !dest.exists() {
        return Ok(UninstallOutcome::Removed);
    }

    if !force {
        let conflicts =
            uninstall_drift(&dest, single_file, &record.last_known_install_hashes)
                .map_err(io_from_path)?;
        if !conflicts.is_empty() {
            return Ok(UninstallOutcome::Drifted { conflicts });
        }
    }

    if single_file {
        std::fs::remove_file(dest.as_std_path()).map_err(|e| InstallFailureKind::Io {
            path: dest.to_string(),
            message: e.to_string(),
        })?;
    } else {
        std::fs::remove_dir_all(dest.as_std_path()).map_err(|e| InstallFailureKind::Io {
            path: dest.to_string(),
            message: e.to_string(),
        })?;
    }
    Ok(UninstallOutcome::Removed)
}

/// List install-relative paths whose on-disk hash differs from the recorded
/// `last_known_install_hashes` (or that exist on disk but weren't installed
/// by us — extras under a directory install).
fn uninstall_drift(
    dest: &Utf8Path,
    single_file: bool,
    last_known: &BTreeMap<Utf8PathBuf, String>,
) -> Result<Vec<String>, (Utf8PathBuf, std::io::Error)> {
    let mut conflicts = Vec::new();
    if single_file {
        let bytes = read_file_or_io(dest)?;
        let h = hash_bytes(&bytes);
        let expected = last_known
            .get(Utf8Path::new(""))
            .expect("single-file install record has empty key");
        if &h != expected {
            conflicts.push(String::new());
        }
    } else {
        for (rel, expected) in last_known {
            let path = dest.join(rel);
            match std::fs::read(path.as_std_path()) {
                Ok(bytes) => {
                    if &hash_bytes(&bytes) != expected {
                        conflicts.push(rel.to_string());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Missing files are fine — still the result of OUR
                    // install (just deleted by user).
                }
                Err(e) => return Err((path, e)),
            }
        }
        // Any file present under the install root that isn't in last_known
        // is also a conflict — user added something we'd otherwise wipe.
        for rel in walk_files(dest, dest)? {
            if !last_known.contains_key(&rel) {
                conflicts.push(rel.to_string());
            }
        }
    }
    Ok(conflicts)
}

#[allow(clippy::too_many_arguments)]
fn install_one(
    install_paths: &InstallPaths,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    allowed_targets: &[Target],
    overlay: &crate::OverlayBytes,
    target: Target,
    version: &VersionLabel,
    force: bool,
    installed_at: &str,
) -> Result<(TargetOutcome, Option<InstallRecord>), InstallFailureKind> {
    let materialized =
        materialize(kind, name, allowed_targets, overlay, target).map_err(other_failure)?;
    let kt = KindTarget::new(kind, target).ok_or_else(|| {
        other_failure(Error::InstallNotSupported { kind, target })
    })?;
    let dest = kt.path_for(install_paths, name, materialized.layout);
    let single_file = matches!(materialized.layout, InstallLayout::SingleFile);

    // Pre-flight: never blindly clobber. File-vs-dir mismatch aborts with
    // OccupiedByUnexpectedKind so the UI can show "[Show in Finder] [Move
    // aside and retry] [Cancel]" without us touching disk.
    if let Some(meta) = stat_optional(&dest)? {
        let actual = if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        };
        let expected = if single_file { "file" } else { "directory" };
        if meta.is_dir() == single_file {
            return Err(InstallFailureKind::OccupiedByUnexpectedKind {
                path: dest.to_string(),
                expected: expected.into(),
                actual: actual.into(),
            });
        }
    }

    // Build the (relpath -> bytes) map keyed by what will land *inside* the
    // install destination. Single-file installs collapse to one synthetic
    // entry keyed by "" so the rest of the algorithm stays uniform.
    let want: BTreeMap<Utf8PathBuf, Vec<u8>> = if single_file {
        // The materializer guarantees exactly one entry when flattened; for
        // Command/CodexAgent there's also one canonical primary file.
        let bytes = sole_primary_bytes(kind, name, &materialized.files).map_err(other_failure)?;
        let mut map = BTreeMap::new();
        map.insert(Utf8PathBuf::new(), bytes);
        map
    } else {
        materialized
            .files
            .into_iter()
            .filter(|(path, _)| !is_ignored(path))
            .collect()
    };

    // Hash compare — `want_hashes` are what we *intend* to write; we
    // record them in `file_hashes`. After the rename we re-hash the live
    // disk to capture `last_known_install_hashes` (the TOCTOU mitigation
    // from the plan: drift self-corrects from post-write reality).
    let want_hashes: BTreeMap<Utf8PathBuf, String> = want
        .iter()
        .map(|(rel, bytes)| (rel.clone(), hash_bytes(bytes)))
        .collect();
    let conflict_paths =
        compute_conflicts(&dest, single_file, &want, &want_hashes).map_err(io_from_path)?;
    let conflicts: Vec<String> = conflict_paths.iter().map(|p| p.to_string()).collect();

    if conflict_paths.is_empty() {
        // Either dest doesn't exist yet, or the on-disk content matches.
        // In the matches case we still skip the write — atomic_write would
        // bump mtime even for identical bytes, breaking the "re-installing
        // identical content does not touch mtime" plan invariant.
        if dest.exists() {
            let mtimes = read_mtimes(&dest, single_file, &want).map_err(io_from_path)?;
            return Ok((
                TargetOutcome::NoOpIdentical {
                    version: version.clone(),
                },
                Some(InstallRecord {
                    kind,
                    name: name.clone(),
                    target,
                    installed_version: version.clone(),
                    file_hashes: want_hashes.clone(),
                    last_known_install_hashes: want_hashes,
                    mtimes,
                    installed_at: installed_at.into(),
                }),
            ));
        }
    } else if !force {
        return Ok((
            TargetOutcome::CollidingContent {
                version: version.clone(),
                conflicts,
            },
            None,
        ));
    }

    // Write. For single-file: stage as sibling, atomic rename. For
    // directory: stage as `<dest>.staging.<random>` sibling dir, populate,
    // then swap into place (rename existing aside, rename staging in,
    // remove old) — POSIX dir rename is atomic only into a non-existent or
    // empty target, so we accept a brief two-rename window.
    write_via_stage(&dest, single_file, &want).map_err(io_from_path)?;

    // Re-hash from disk post-rename. If a concurrent writer changed the
    // file between our rename and this read, we record reality, not intent.
    let post_hashes =
        rehash_from_disk(&dest, single_file, &want).map_err(io_from_path)?;
    let post_mtimes = read_mtimes(&dest, single_file, &want).map_err(io_from_path)?;

    Ok((
        TargetOutcome::Installed {
            version: version.clone(),
        },
        Some(InstallRecord {
            kind,
            name: name.clone(),
            target,
            installed_version: version.clone(),
            file_hashes: want_hashes,
            last_known_install_hashes: post_hashes,
            mtimes: post_mtimes,
            installed_at: installed_at.into(),
        }),
    ))
}

/// Pull the bytes for the single primary file out of the materialized map.
/// For `(Agent, Claude, flattened)` this is `agent.md`; for `Command` it's
/// `<name>.md`; for `CodexAgent` it's `<name>.toml`. If the materializer
/// returned something unexpected (zero or many entries), we surface as
/// `Other` rather than silently picking the wrong one.
fn sole_primary_bytes(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    files: &std::collections::HashMap<Utf8PathBuf, Vec<u8>>,
) -> Result<Vec<u8>, Error> {
    let primary = Utf8PathBuf::from(kind.primary_filename(name));
    match files.get(&primary) {
        Some(bytes) => Ok(bytes.clone()),
        None => Err(Error::MaterializeShape(format!(
            "expected single-file primitive `{primary}` in materialized output, got {} key(s)",
            files.len()
        ))),
    }
}

fn stat_optional(path: &Utf8Path) -> Result<Option<fs::Metadata>, InstallFailureKind> {
    match fs::metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(InstallFailureKind::Io {
            path: path.to_string(),
            message: e.to_string(),
        }),
    }
}

fn compute_conflicts(
    dest: &Utf8Path,
    single_file: bool,
    want: &BTreeMap<Utf8PathBuf, Vec<u8>>,
    want_hashes: &BTreeMap<Utf8PathBuf, String>,
) -> Result<Vec<Utf8PathBuf>, (Utf8PathBuf, std::io::Error)> {
    if !dest.exists() {
        return Ok(Vec::new());
    }
    let mut conflicts = Vec::new();
    if single_file {
        // dest IS the file — `want` has a single empty-key entry.
        let existing = read_file_or_io(dest)?;
        let existing_hash = hash_bytes(&existing);
        let expected_hash = want_hashes
            .get(Utf8Path::new(""))
            .expect("single-file want has empty key");
        if &existing_hash != expected_hash {
            conflicts.push(Utf8PathBuf::from(""));
        }
    } else {
        for rel in want.keys() {
            let path = dest.join(rel);
            match fs::read(path.as_std_path()) {
                Ok(existing) => {
                    let h = hash_bytes(&existing);
                    if &h != want_hashes.get(rel).expect("hash for relpath") {
                        conflicts.push(rel.clone());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    conflicts.push(rel.clone());
                }
                Err(e) => return Err((path, e)),
            }
        }
        // Files on disk that aren't in `want` are also conflicts under
        // force=true semantics (we'll wipe them on swap-in), but we surface
        // them here so the UI can warn.
        for entry in walk_files(dest, dest)? {
            if !want.contains_key(&entry) {
                conflicts.push(entry);
            }
        }
    }
    Ok(conflicts)
}

fn write_via_stage(
    dest: &Utf8Path,
    single_file: bool,
    want: &BTreeMap<Utf8PathBuf, Vec<u8>>,
) -> Result<(), (Utf8PathBuf, std::io::Error)> {
    let parent = dest.parent().unwrap_or(Utf8Path::new("."));
    fs::create_dir_all(parent.as_std_path()).map_err(|e| (parent.to_owned(), e))?;

    if single_file {
        // atomic_write already does temp+rename and is what other writers
        // in the crate use; reuse it for consistency.
        let bytes = want
            .get(Utf8Path::new(""))
            .expect("single-file want has empty key");
        atomic_write(dest, bytes).map_err(|e| match e {
            Error::Io { path, source } => (Utf8PathBuf::from(path), source),
            other => (dest.to_owned(), std::io::Error::other(other.to_string())),
        })?;
        return Ok(());
    }

    let staging = staging_sibling(dest);
    // Best-effort cleanup if a previous interrupted run left a staging dir.
    let _ = fs::remove_dir_all(staging.as_std_path());
    fs::create_dir_all(staging.as_std_path()).map_err(|e| (staging.clone(), e))?;
    for (rel, bytes) in want {
        let p = staging.join(rel);
        if let Some(par) = p.parent() {
            fs::create_dir_all(par.as_std_path()).map_err(|e| (par.to_owned(), e))?;
        }
        fs::write(p.as_std_path(), bytes).map_err(|e| (p.clone(), e))?;
    }

    if dest.exists() {
        let aside = aside_sibling(dest);
        fs::rename(dest.as_std_path(), aside.as_std_path())
            .map_err(|e| (dest.to_owned(), e))?;
        let swap_result = fs::rename(staging.as_std_path(), dest.as_std_path());
        match swap_result {
            Ok(()) => {
                // Best-effort delete; if it fails the user has stale dir
                // alongside but the install itself succeeded.
                let _ = fs::remove_dir_all(aside.as_std_path());
            }
            Err(e) => {
                // Roll back: put the original back and clean staging.
                let _ = fs::rename(aside.as_std_path(), dest.as_std_path());
                let _ = fs::remove_dir_all(staging.as_std_path());
                return Err((dest.to_owned(), e));
            }
        }
    } else {
        fs::rename(staging.as_std_path(), dest.as_std_path())
            .map_err(|e| (dest.to_owned(), e))?;
    }
    Ok(())
}

fn staging_sibling(dest: &Utf8Path) -> Utf8PathBuf {
    let parent = dest.parent().unwrap_or(Utf8Path::new("."));
    let leaf = dest.file_name().unwrap_or("dest");
    let token = unique_token();
    parent.join(format!(".{leaf}.staging.{token}"))
}

fn aside_sibling(dest: &Utf8Path) -> Utf8PathBuf {
    let parent = dest.parent().unwrap_or(Utf8Path::new("."));
    let leaf = dest.file_name().unwrap_or("dest");
    let token = unique_token();
    parent.join(format!(".{leaf}.old.{token}"))
}

fn unique_token() -> String {
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{pid}.{nanos}")
}

fn rehash_from_disk(
    dest: &Utf8Path,
    single_file: bool,
    want: &BTreeMap<Utf8PathBuf, Vec<u8>>,
) -> Result<BTreeMap<Utf8PathBuf, String>, (Utf8PathBuf, std::io::Error)> {
    let mut out = BTreeMap::new();
    if single_file {
        let bytes = read_file_or_io(dest)?;
        out.insert(Utf8PathBuf::from(""), hash_bytes(&bytes));
    } else {
        for rel in want.keys() {
            let path = dest.join(rel);
            let bytes = read_file_or_io(&path)?;
            out.insert(rel.clone(), hash_bytes(&bytes));
        }
    }
    Ok(out)
}

fn read_mtimes(
    dest: &Utf8Path,
    single_file: bool,
    want: &BTreeMap<Utf8PathBuf, Vec<u8>>,
) -> Result<BTreeMap<Utf8PathBuf, i64>, (Utf8PathBuf, std::io::Error)> {
    let mut out = BTreeMap::new();
    if single_file {
        out.insert(Utf8PathBuf::from(""), mtime_of(dest)?);
    } else {
        for rel in want.keys() {
            let p = dest.join(rel);
            out.insert(rel.clone(), mtime_of(&p)?);
        }
    }
    Ok(out)
}

fn mtime_of(path: &Utf8Path) -> Result<i64, (Utf8PathBuf, std::io::Error)> {
    let meta = fs::metadata(path.as_std_path()).map_err(|e| (path.to_owned(), e))?;
    let mtime = meta.modified().map_err(|e| (path.to_owned(), e))?;
    let secs = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(secs)
}

fn read_file_or_io(path: &Utf8Path) -> Result<Vec<u8>, (Utf8PathBuf, std::io::Error)> {
    fs::read(path.as_std_path()).map_err(|e| (path.to_owned(), e))
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
        let ft = entry
            .file_type()
            .map_err(|e| (path.clone(), e))?;
        if ft.is_dir() {
            out.extend(walk_files(root, &path)?);
        } else if ft.is_file() {
            out.push(rel);
        }
    }
    Ok(out)
}

fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn other_failure(e: Error) -> InstallFailureKind {
    InstallFailureKind::Other {
        message: e.to_string(),
    }
}

fn io_from_path((path, source): (Utf8PathBuf, std::io::Error)) -> InstallFailureKind {
    InstallFailureKind::Io {
        path: path.to_string(),
        message: source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold::scaffold_skill;
    use crate::version_store::{VersionMetadata, VersionStore};
    use crate::working_copy::WorkingCopy;
    use crate::{
        update_primitive_metadata, MetadataUpdate, PrimitiveKind, PrimitiveName, Target,
        VersionLabel,
    };
    use camino::Utf8PathBuf;
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

        fn layout(&self) -> LibraryLayout<'_> {
            LibraryLayout::new(&self.lib_root)
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

    /// Scaffold a Skill, write its primary file, set allowed_targets, snapshot
    /// as v1 (which sets current.txt). Returns the primitive name.
    fn published_skill(fx: &Fixture, allowed: Vec<Target>) -> PrimitiveName {
        let n = name("diagnose");
        scaffold_skill(fx.layout(), &n, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            camino::Utf8Path::new("SKILL.md"),
            b"---\n---\nbody-v1\n",
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Skill,
            &n,
            MetadataUpdate {
                allowed_targets: allowed,
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
        n
    }

    fn request<'a>(
        fx: &'a Fixture,
        kind: PrimitiveKind,
        n: &'a PrimitiveName,
        targets: &'a [Target],
        force: bool,
        installed_at: &'a str,
        install_paths: &'a InstallPaths,
    ) -> InstallRequest<'a> {
        InstallRequest {
            layout: fx.layout(),
            install_paths,
            installs_file_path: &fx.installs_path,
            kind,
            name: n,
            targets,
            force,
            installed_at,
        }
    }

    #[test]
    fn install_skill_to_claude_writes_files_and_records_state() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.failures.len(), 0);
        assert_eq!(summary.successes.len(), 1);
        assert!(matches!(
            summary.successes[0].outcome,
            TargetOutcome::Installed { .. }
        ));

        // Disk state: SKILL.md in <home>/.claude/skills/diagnose/
        let installed = fx
            .home
            .join(".claude/skills/diagnose/SKILL.md");
        assert!(installed.exists(), "expected installed file at {installed}");
        assert_eq!(
            std::fs::read(installed.as_std_path()).unwrap(),
            b"---\n---\nbody-v1\n",
        );

        // installs.json contains a record with matching hashes.
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert_eq!(installs.records.len(), 1);
        let r = &installs.records[0];
        assert_eq!(r.kind, PrimitiveKind::Skill);
        assert_eq!(r.target, Target::Claude);
        assert_eq!(r.installed_version, label("v1"));
        assert_eq!(r.file_hashes, r.last_known_install_hashes);
        let key = Utf8PathBuf::from("SKILL.md");
        assert!(r.file_hashes.contains_key(&key));
    }

    #[test]
    fn reinstalling_identical_content_is_noop_and_preserves_mtime() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        let mtime_before = std::fs::metadata(installed.as_std_path())
            .unwrap()
            .modified()
            .unwrap();

        // Sleep just enough to ensure any write would bump mtime past
        // resolution. macOS HFS+ uses 1s; APFS uses ns. 50ms is plenty for
        // both.
        std::thread::sleep(std::time::Duration::from_millis(50));

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:03Z",
            &ip,
        ))
        .unwrap();

        assert!(matches!(
            summary.successes[0].outcome,
            TargetOutcome::NoOpIdentical { .. }
        ));
        let mtime_after = std::fs::metadata(installed.as_std_path())
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(mtime_before, mtime_after, "mtime must not change for no-op");
    }

    #[test]
    fn content_collision_without_force_returns_collidingcontent() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        // Mutate the install file out-of-band.
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:04Z",
            &ip,
        ))
        .unwrap();

        match &summary.successes[0].outcome {
            TargetOutcome::CollidingContent { conflicts, .. } => {
                assert!(
                    conflicts.iter().any(|c| c == "SKILL.md"),
                    "expected SKILL.md in conflicts, got {conflicts:?}"
                );
            }
            other => panic!("expected CollidingContent, got {other:?}"),
        }

        // No write happened.
        assert_eq!(
            std::fs::read(installed.as_std_path()).unwrap(),
            b"---\n---\nuser-edit\n",
        );
    }

    #[test]
    fn collision_with_force_overwrites() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            true,
            "2026-05-04T00:00:05Z",
            &ip,
        ))
        .unwrap();

        assert!(matches!(
            summary.successes[0].outcome,
            TargetOutcome::Installed { .. }
        ));
        assert_eq!(
            std::fs::read(installed.as_std_path()).unwrap(),
            b"---\n---\nbody-v1\n",
        );
    }

    #[test]
    fn file_in_place_of_dir_returns_occupied_by_unexpected_kind() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();

        // Pre-create a regular file where the install dir should go.
        let dest = fx.home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(dest.parent().unwrap().as_std_path()).unwrap();
        std::fs::write(dest.as_std_path(), b"i am a file, not a dir").unwrap();

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:06Z",
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.successes.len(), 0);
        assert_eq!(summary.failures.len(), 1);
        match &summary.failures[0].reason {
            InstallFailureKind::OccupiedByUnexpectedKind {
                expected,
                actual,
                path,
            } => {
                assert_eq!(expected, "directory");
                assert_eq!(actual, "file");
                assert!(path.ends_with("diagnose"), "path: {path}");
            }
            other => panic!("expected OccupiedByUnexpectedKind, got {other:?}"),
        }
        // The pre-existing file must not be touched.
        assert_eq!(
            std::fs::read(dest.as_std_path()).unwrap(),
            b"i am a file, not a dir"
        );
    }

    #[test]
    fn dir_in_place_of_single_file_returns_occupied_by_unexpected_kind() {
        // CodexAgent installs as a single .toml file. Pre-create a dir at
        // that path and verify the pre-flight catches it.
        let fx = Fixture::new();
        let n = name("review");
        crate::scaffold::scaffold_primitive(
            fx.layout(),
            PrimitiveKind::CodexAgent,
            &n,
            "2026-05-04T00:00:00Z",
            None,
        )
        .unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::CodexAgent,
            &n,
            camino::Utf8Path::new("review.toml"),
            b"name = \"review\"\n",
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::CodexAgent,
            &n,
            MetadataUpdate {
                allowed_targets: vec![Target::Codex],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let store = VersionStore::new(fx.layout());
        store
            .snapshot(
                PrimitiveKind::CodexAgent,
                &n,
                &label("v1"),
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();

        let dest = fx.home.join(".codex/agents/review.toml");
        std::fs::create_dir_all(dest.as_std_path()).unwrap();

        let ip = fx.install_paths();
        let summary = install(request(
            &fx,
            PrimitiveKind::CodexAgent,
            &n,
            &[Target::Codex],
            false,
            "2026-05-04T00:00:07Z",
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.failures.len(), 1);
        assert!(matches!(
            summary.failures[0].reason,
            InstallFailureKind::OccupiedByUnexpectedKind { .. }
        ));
    }

    #[test]
    fn multi_target_partial_success_keeps_each_target_independent() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude, Target::Pi]);
        let ip = fx.install_paths();

        // Block the Pi install path with a regular file so its install
        // fails while Claude succeeds.
        let pi_dest = fx.home.join(".pi/agent/skills/diagnose");
        std::fs::create_dir_all(pi_dest.parent().unwrap().as_std_path()).unwrap();
        std::fs::write(pi_dest.as_std_path(), b"blocking").unwrap();

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude, Target::Pi],
            false,
            "2026-05-04T00:00:08Z",
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.successes.len(), 1);
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.successes[0].target, Target::Claude);
        assert_eq!(summary.failures[0].target, Target::Pi);
        // Claude got installed; pi was not touched.
        assert!(fx
            .home
            .join(".claude/skills/diagnose/SKILL.md")
            .exists());
        assert_eq!(std::fs::read(pi_dest.as_std_path()).unwrap(), b"blocking");

        // installs.json got the Claude record only — Pi's failure
        // shouldn't roll back Claude's success.
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert_eq!(installs.records.len(), 1);
        assert_eq!(installs.records[0].target, Target::Claude);
    }

    #[test]
    fn target_outside_allowed_targets_goes_to_failures() {
        let fx = Fixture::new();
        // Allow only Claude.
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();

        let summary = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Pi],
            false,
            "2026-05-04T00:00:09Z",
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.successes.len(), 0);
        assert_eq!(summary.failures.len(), 1);
        assert!(matches!(
            summary.failures[0].reason,
            InstallFailureKind::Other { .. }
        ));
    }

    #[test]
    fn install_fails_globally_when_no_current_version() {
        let fx = Fixture::new();
        let n = name("diagnose");
        scaffold_skill(fx.layout(), &n, "2026-05-04T00:00:00Z").unwrap();
        // No snapshot → no current.txt.
        let ip = fx.install_paths();
        let err = install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:10Z",
            &ip,
        ))
        .unwrap_err();
        assert!(matches!(err, Error::NoCurrentVersionForInstall));
        // installs.json was never written.
        assert!(!fx.installs_path.exists());
    }

    fn uninstall_request<'a>(
        fx: &'a Fixture,
        kind: PrimitiveKind,
        n: &'a PrimitiveName,
        targets: &'a [Target],
        force: bool,
        install_paths: &'a InstallPaths,
    ) -> UninstallRequest<'a> {
        UninstallRequest {
            install_paths,
            installs_file_path: &fx.installs_path,
            kind,
            name: n,
            targets,
            force,
        }
    }

    #[test]
    fn uninstall_clean_install_removes_files_and_drops_record() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        let summary = uninstall(uninstall_request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            &ip,
        ))
        .unwrap();

        assert_eq!(summary.failures.len(), 0);
        assert_eq!(summary.successes.len(), 1);
        assert!(matches!(summary.successes[0].outcome, UninstallOutcome::Removed));

        // Files gone, record gone.
        assert!(!fx.home.join(".claude/skills/diagnose").exists());
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert!(installs
            .get(PrimitiveKind::Skill, &n, Target::Claude)
            .is_none());
    }

    #[test]
    fn uninstall_without_record_is_notinstalled_and_idempotent() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();

        let summary = uninstall(uninstall_request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            &ip,
        ))
        .unwrap();
        assert!(matches!(
            summary.successes[0].outcome,
            UninstallOutcome::NotInstalled
        ));
    }

    #[test]
    fn uninstall_with_drift_returns_drifted_and_preserves_disk() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        // User edits the installed file out-of-band.
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let summary = uninstall(uninstall_request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            &ip,
        ))
        .unwrap();

        match &summary.successes[0].outcome {
            UninstallOutcome::Drifted { conflicts } => {
                assert!(
                    conflicts.iter().any(|c| c == "SKILL.md"),
                    "expected SKILL.md in conflicts, got {conflicts:?}"
                );
            }
            other => panic!("expected Drifted, got {other:?}"),
        }

        // File preserved, record preserved.
        assert_eq!(
            std::fs::read(installed.as_std_path()).unwrap(),
            b"---\n---\nuser-edit\n"
        );
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert!(installs
            .get(PrimitiveKind::Skill, &n, Target::Claude)
            .is_some());
    }

    #[test]
    fn uninstall_with_force_overrides_drift() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let summary = uninstall(uninstall_request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            true,
            &ip,
        ))
        .unwrap();
        assert!(matches!(summary.successes[0].outcome, UninstallOutcome::Removed));
        assert!(!fx.home.join(".claude/skills/diagnose").exists());
    }

    #[test]
    fn uninstall_when_disk_already_gone_drops_record_anyway() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:02Z",
            &ip,
        ))
        .unwrap();

        // User wiped the install dir externally.
        std::fs::remove_dir_all(
            fx.home.join(".claude/skills/diagnose").as_std_path(),
        )
        .unwrap();

        let summary = uninstall(uninstall_request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            &ip,
        ))
        .unwrap();
        assert!(matches!(summary.successes[0].outcome, UninstallOutcome::Removed));
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert!(installs
            .get(PrimitiveKind::Skill, &n, Target::Claude)
            .is_none());
    }

    #[test]
    fn installed_record_post_write_hashes_match_disk() {
        let fx = Fixture::new();
        let n = published_skill(&fx, vec![Target::Claude]);
        let ip = fx.install_paths();
        install(request(
            &fx,
            PrimitiveKind::Skill,
            &n,
            &[Target::Claude],
            false,
            "2026-05-04T00:00:11Z",
            &ip,
        ))
        .unwrap();

        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        let r = installs
            .get(PrimitiveKind::Skill, &n, Target::Claude)
            .unwrap();
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        let on_disk_hash = hash_bytes(&std::fs::read(installed.as_std_path()).unwrap());
        let key = Utf8PathBuf::from("SKILL.md");
        assert_eq!(r.last_known_install_hashes[&key], on_disk_hash);
    }
}

