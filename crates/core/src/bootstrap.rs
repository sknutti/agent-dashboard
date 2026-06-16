//! P5.4a: Bootstrap action — turn a [`CrossReferenced`] into a concrete plan
//! and execute the create-primitive happy path.
//!
//! `derive_plan` is pure: it drops `AlreadyImported` and `NeedsManualReview`
//! groups, maps `New` → [`CreateAction`], and `Drifted` → [`ReimportAction`].
//! `execute_creates` writes each create action to the library + records the
//! corresponding `installs.json` entries.
//!
//! Reimport execution lands in P5.4b; checkpoint + resume in P5.4c; backup
//! invocation + orchestrator in P5.4d.

use std::collections::BTreeMap;
use std::time::UNIX_EPOCH;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::fs_helpers::{atomic_write, walk_into};
use crate::install_reconcile::{apply_case_relinks, plan_case_relinks};
use crate::listing::list_primitives;
use crate::{
    create_source_backup, is_ignored, reimport_install_as_version, BaseAssignment,
    BootstrapSession, Classification, ClassifiedGroup, CrossReferenced, DedupeContent, Error,
    InstallPaths, InstallRecord, InstallsFile, LibraryLayout, OverlayCandidate, PrimitiveKind,
    PrimitiveMetadata, PrimitiveName, ReimportRequest, ReimportResult, Target, VersionLabel,
    VersionMetadata, VersionStore,
};

/// Concrete bootstrap actions derived from a [`CrossReferenced`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapPlan {
    /// New primitives to create at v1.
    pub creates: Vec<CreateAction>,
    /// Existing primitives whose source bundles have drifted; reimport as
    /// vN+1. Executed in P5.4b.
    pub reimports: Vec<ReimportAction>,
}

/// One primitive to create at v1 in the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CreateAction {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    /// Source bundle that becomes `working/base/`.
    pub base: BaseAssignment,
    /// Per-non-base-target source bundles that become
    /// `working/targets/<target>/` overlays. Empty for `Identical` groups.
    pub overlays: Vec<OverlayCandidate>,
}

/// One existing primitive to reimport as a new version (drifted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReimportAction {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub base: BaseAssignment,
}

/// Map a [`CrossReferenced`] into a [`BootstrapPlan`]. Pure logic.
pub fn derive_plan(cr: CrossReferenced) -> BootstrapPlan {
    let mut creates = Vec::new();
    let mut reimports = Vec::new();
    for g in cr.groups {
        let ClassifiedGroup {
            kind,
            name,
            classification,
        } = g;
        match classification {
            Classification::AlreadyImported => {}
            Classification::New { content } => {
                let (base, overlays) = base_and_overlays(content);
                creates.push(CreateAction {
                    kind,
                    name,
                    base,
                    overlays,
                });
            }
            Classification::Drifted { content } => {
                let (base, _) = base_and_overlays(content);
                reimports.push(ReimportAction { kind, name, base });
            }
        }
    }
    BootstrapPlan { creates, reimports }
}

fn base_and_overlays(content: DedupeContent) -> (BaseAssignment, Vec<OverlayCandidate>) {
    match content {
        DedupeContent::Identical { base } => (base, vec![]),
        DedupeContent::Differs { base, overlays } => (base, overlays),
    }
}

/// Inputs to [`bootstrap_execute`] — the orchestrator that runs a batch
/// transactionally with checkpointing + tarball backup.
pub struct BootstrapExecuteRequest<'a> {
    pub plan: &'a BootstrapPlan,
    pub layout: LibraryLayout<'a>,
    pub install_paths: &'a InstallPaths,
    pub installs_file: &'a Utf8Path,
    pub session_path: &'a Utf8Path,
    pub backup_dir: &'a Utf8Path,
    pub home: &'a Utf8Path,
    pub timestamp: &'a str,
    /// `None` for a fresh run; `Some(session)` to resume a previously-
    /// crashed/quit bootstrap. Resume skips the backup (already taken)
    /// and any items already marked done in the session.
    pub resume: Option<BootstrapSession>,
    /// Executable action ids the user intentionally excluded in the
    /// frontend review step. Stored in the session so a later resume can
    /// preserve those choices.
    pub excluded_ids: Vec<String>,
}

/// Result of [`bootstrap_execute`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapExecuteSummary {
    /// Path to the source-dir tarball, if one was written this run. `None`
    /// when resuming (backup taken on the original run) or when the user's
    /// home has no `.claude/`/`.pi/`/`.codex/` to back up.
    #[specta(type = Option<String>)]
    pub backup_path: Option<Utf8PathBuf>,
    pub created: u32,
    pub reimported: u32,
    pub skipped: u32,
    pub skipped_items: Vec<BootstrapSkippedItem>,
    /// Install records re-linked by case-only reconciliation this run (a
    /// manual disk rename like `Teach`→`teach` left the record at the old
    /// case). Reported for UI feedback; does NOT count toward the library
    /// commit gate — reconciliation touches only `installs.json`.
    pub reconciled: u32,
}

/// One executable bootstrap action that could not be completed and must be
/// surfaced back to the wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapSkippedItem {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub source_target: Target,
    pub reason: BootstrapSkipReason,
}

/// Why a bootstrap reimport could not be completed automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum BootstrapSkipReason {
    WorkingCopyDirty,
    InstallMissing,
}

/// Run a bootstrap plan to completion. Currently handles the create
/// path; reimports + resume land in subsequent tracer cycles.
pub fn bootstrap_execute(
    req: BootstrapExecuteRequest<'_>,
) -> Result<BootstrapExecuteSummary, Error> {
    let mut session = req
        .resume
        .unwrap_or_else(|| BootstrapSession::new(req.timestamp));
    session.set_excluded_ids(req.excluded_ids);

    let backup_path = if session.backup_taken {
        None
    } else {
        let path = create_source_backup(req.install_paths, req.backup_dir, req.timestamp)?;
        session.backup_taken = true;
        session.save(req.session_path)?;
        path
    };

    let remaining = session.filter_remaining(req.plan);

    let mut summary = BootstrapExecuteSummary {
        backup_path,
        created: 0,
        reimported: 0,
        skipped: 0,
        skipped_items: Vec::new(),
        reconciled: 0,
    };

    // Reconcile case-only orphaned install records BEFORE any create/reimport
    // reads `installs.json`. A manual disk rename that only changes case
    // (e.g. `Teach`→`teach` on a case-insensitive FS) leaves the record at the
    // old case; case-sensitive `(kind, name, target)` matching then orphans
    // it, silently breaking drift/reimport. This re-links such records to the
    // library's canonical case. Idempotent, install-side only — it must NOT
    // feed the commit gate (no library content changes), so `reconciled` is
    // deliberately excluded from the `created + reimported > 0` check below.
    {
        let mut installs = InstallsFile::load(req.installs_file)?;
        let library: Vec<(PrimitiveKind, PrimitiveName)> = list_primitives(req.layout)?
            .into_iter()
            .map(|s| (s.kind, s.name))
            .collect();
        let relinks = plan_case_relinks(&library, &installs);
        if !relinks.is_empty() {
            apply_case_relinks(&mut installs, &relinks);
            installs.save(req.installs_file)?;
            summary.reconciled = relinks.iter().map(|r| r.targets.len() as u32).sum();
        }
    }

    if !remaining.creates.is_empty() {
        let mut installs = InstallsFile::load(req.installs_file)?;
        for action in &remaining.creates {
            execute_one_create(action, req.layout, &mut installs, req.timestamp)?;
            installs.save(req.installs_file)?;
            session.record_create(action.kind, &action.name);
            session.save(req.session_path)?;
            summary.created += 1;
        }
    }

    for action in &remaining.reimports {
        match execute_one_reimport(
            action,
            req.layout,
            req.install_paths,
            req.installs_file,
            req.timestamp,
        )? {
            ReimportOutcome::Reimported => {
                session.record_reimport(action.kind, &action.name);
                session.save(req.session_path)?;
                summary.reimported += 1;
            }
            ReimportOutcome::Skipped(item) => {
                summary.skipped += 1;
                summary.skipped_items.push(item);
            }
        }
    }

    // Clear the session only when nothing was left unresolved. Skipped
    // reimports surface to the wizard as "N items need review"; keeping
    // the session file is the signal that bootstrap is incomplete.
    if summary.skipped == 0 {
        BootstrapSession::clear(req.session_path)?;
    } else {
        // Make sure the session is on disk so the wizard finds it on
        // relaunch even if no items completed (saving on every record_*
        // covers the completed-item case but a skip-only run never saved).
        session.save(req.session_path)?;
    }
    Ok(summary)
}

/// Result of executing a batch of [`CreateAction`]s.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapSummary {
    pub created: u32,
}

/// Result of executing a batch of [`ReimportAction`]s.
///
/// `reimported` counts successful version bumps. `skipped` counts actions
/// the wizard needs to surface (working-copy dirty, install path
/// disappeared between scan and execute). The orchestrator in P5.4d
/// expands this into per-primitive detail.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapReimportSummary {
    pub reimported: u32,
    pub skipped: u32,
}

/// Execute a batch of [`CreateAction`]s: write each primitive at v1 to the
/// library and record the corresponding [`InstallRecord`] entries in
/// `installs_file`. Returns a [`BootstrapSummary`] of what happened.
pub fn execute_creates(
    creates: &[CreateAction],
    layout: LibraryLayout<'_>,
    installs_file: &Utf8Path,
    timestamp: &str,
) -> Result<BootstrapSummary, Error> {
    if creates.is_empty() {
        return Ok(BootstrapSummary::default());
    }
    let mut installs = InstallsFile::load(installs_file)?;
    let mut created = 0;
    for action in creates {
        execute_one_create(action, layout, &mut installs, timestamp)?;
        created += 1;
    }
    installs.save(installs_file)?;
    Ok(BootstrapSummary { created })
}

/// Execute a batch of [`ReimportAction`]s — bump each existing primitive
/// to a new version vN+1 sourced from the user's source dir.
///
/// Each action is routed through [`reimport_install_as_version`]: we
/// synthesize an install record at the library's current version (so the
/// reimport machinery's drift-detection / single-vs-dir logic sees the
/// source path as "an install at v_current"), then call reimport with
/// `new_version = v(N+1)`. On success the record is overwritten with the
/// new version. On `WorkingCopyDirty` / `InstallMissing` we restore the
/// pre-bootstrap installs.json so we don't leave a synthesized record
/// behind.
pub fn execute_reimports(
    reimports: &[ReimportAction],
    layout: LibraryLayout<'_>,
    install_paths: &InstallPaths,
    installs_file: &Utf8Path,
    timestamp: &str,
) -> Result<BootstrapReimportSummary, Error> {
    let mut summary = BootstrapReimportSummary::default();
    for action in reimports {
        match execute_one_reimport(action, layout, install_paths, installs_file, timestamp)? {
            ReimportOutcome::Reimported => summary.reimported += 1,
            ReimportOutcome::Skipped(_) => summary.skipped += 1,
        }
    }
    Ok(summary)
}

enum ReimportOutcome {
    Reimported,
    Skipped(BootstrapSkippedItem),
}

fn execute_one_reimport(
    action: &ReimportAction,
    layout: LibraryLayout<'_>,
    install_paths: &InstallPaths,
    installs_file: &Utf8Path,
    timestamp: &str,
) -> Result<ReimportOutcome, Error> {
    // Compute next version from the library's current label.
    let store = VersionStore::new(layout);
    let current = store
        .read_current(action.kind, &action.name)?
        .ok_or(Error::NoCurrentVersionForInstall)?;
    let new_version = next_version(&current)?;

    // Snapshot installs.json so we can restore on non-Reimported failure.
    let installs_before = InstallsFile::load(installs_file)?;

    // Synthesize an install record at the current version so the reimport
    // function's `NotInstalled` short-circuit doesn't fire and so its
    // single-vs-dir dispatch sees the right shape.
    let mut installs = installs_before.clone();
    let (install_hashes, install_mtimes) = read_install_state(&action.base.source_path)?;
    installs.upsert(InstallRecord {
        kind: action.kind,
        name: action.name.clone(),
        target: action.base.target,
        installed_version: current.clone(),
        file_hashes: install_hashes.clone(),
        last_known_install_hashes: install_hashes,
        mtimes: install_mtimes,
        installed_at: timestamp.to_string(),
    });
    installs.save(installs_file)?;

    let req = ReimportRequest {
        layout,
        install_paths,
        installs_file_path: installs_file,
        kind: action.kind,
        name: &action.name,
        source_target: action.base.target,
        new_version: new_version.clone(),
        created_at: timestamp,
        notes: None,
        discard_working: false,
        fixed_primary_bytes: None,
    };
    let result = reimport_install_as_version(req)?;
    match result {
        ReimportResult::Reimported { .. } => Ok(ReimportOutcome::Reimported),
        ReimportResult::WorkingCopyDirty => {
            // Restore the pre-bootstrap installs.json so we don't leave a
            // synthesized record behind for an action that didn't land.
            installs_before.save(installs_file)?;
            Ok(ReimportOutcome::Skipped(BootstrapSkippedItem {
                kind: action.kind,
                name: action.name.clone(),
                source_target: action.base.target,
                reason: BootstrapSkipReason::WorkingCopyDirty,
            }))
        }
        ReimportResult::InstallMissing => {
            // Restore the pre-bootstrap installs.json so we don't leave a
            // synthesized record behind for an action that didn't land.
            installs_before.save(installs_file)?;
            Ok(ReimportOutcome::Skipped(BootstrapSkippedItem {
                kind: action.kind,
                name: action.name.clone(),
                source_target: action.base.target,
                reason: BootstrapSkipReason::InstallMissing,
            }))
        }
        ReimportResult::NotInstalled => unreachable!(
            "we just synthesized the install record — NotInstalled cannot fire"
        ),
        ReimportResult::BrokenSource { .. } => unreachable!(
            "deduper rejected unparseable bases via NeedsManualReview, so a \
             Drifted reimport always has a parseable primary"
        ),
    }
}

/// `v3` → `v4`. Errors if `current` has a `-suffix` (don't auto-bump
/// pre-release labels).
fn next_version(current: &VersionLabel) -> Result<VersionLabel, Error> {
    let raw = current.as_str();
    let digits = raw.strip_prefix('v').unwrap_or(raw);
    if digits.contains('-') {
        return Err(Error::InvalidVersionLabel {
            label: raw.to_string(),
            reason: "cannot auto-bump labels with `-suffix`",
        });
    }
    let n: u32 = digits.parse().map_err(|_| Error::InvalidVersionLabel {
        label: raw.to_string(),
        reason: "not a base version number",
    })?;
    VersionLabel::try_new(format!("v{}", n + 1))
}

fn execute_one_create(
    action: &CreateAction,
    layout: LibraryLayout<'_>,
    installs: &mut InstallsFile,
    timestamp: &str,
) -> Result<(), Error> {
    let CreateAction {
        kind,
        name,
        base,
        overlays,
    } = action;
    let kind = *kind;

    // Read every source bundle into canonical library-relpath form.
    let base_files = read_canonicalized_bundle(kind, name, &base.source_path)?;
    let mut overlay_files: Vec<(Target, Utf8PathBuf, BTreeMap<Utf8PathBuf, Vec<u8>>)> =
        Vec::with_capacity(overlays.len());
    for o in overlays {
        let files = read_canonicalized_bundle(kind, name, &o.source_path)?;
        overlay_files.push((o.target, o.source_path.clone(), files));
    }

    // metadata.yaml — allowed_targets in scan order: base first, then
    // overlays in their existing slice order (deduper preserves scan order).
    let mut allowed_targets = vec![base.target];
    for (t, _, _) in &overlay_files {
        if !allowed_targets.contains(t) {
            allowed_targets.push(*t);
        }
    }
    let metadata = PrimitiveMetadata {
        allowed_targets,
        created_at: timestamp.to_string(),
        display_name: None,
        author: None,
        source_url: None,
    };
    atomic_write(
        &layout.primitive_metadata(kind, name),
        metadata.to_yaml()?.as_bytes(),
    )?;

    // working/base/
    for (rel, bytes) in &base_files {
        atomic_write(&layout.working_base(kind, name).join(rel), bytes)?;
    }
    // working/targets/<target>/
    for (target, _, files) in &overlay_files {
        for (rel, bytes) in files {
            atomic_write(&layout.working_target(kind, name, *target).join(rel), bytes)?;
        }
    }

    // Snapshot v1 + set current.txt.
    let label = VersionLabel::try_new("v1").expect("v1 is a valid label");
    let store = VersionStore::new(layout);
    store.snapshot(
        kind,
        name,
        &label,
        &VersionMetadata {
            created_at: timestamp.to_string(),
            notes: None,
        },
    )?;

    // Install records: one per (kind, name, target). The source path IS
    // the install location for that target — record source mtimes/hashes
    // verbatim so future drift detection compares against reality.
    let base_record = build_install_record(
        kind,
        name,
        base.target,
        &base.source_path,
        &base_files,
        timestamp,
    )?;
    installs.upsert(base_record);
    for (target, source_path, files) in &overlay_files {
        let rec = build_install_record(kind, name, *target, source_path, files, timestamp)?;
        installs.upsert(rec);
    }

    Ok(())
}

/// Read the bundle at `source_path` (single-file or dir, determined by fs
/// metadata) and re-key its relpaths to the library's working/base/ layout.
fn read_canonicalized_bundle(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    source_path: &Utf8Path,
) -> Result<BTreeMap<Utf8PathBuf, Vec<u8>>, Error> {
    let meta = std::fs::metadata(source_path.as_std_path()).map_err(|source| Error::Io {
        path: source_path.to_string(),
        source,
    })?;
    let mut out = BTreeMap::new();
    if meta.is_file() {
        let bytes = std::fs::read(source_path.as_std_path()).map_err(|source| Error::Io {
            path: source_path.to_string(),
            source,
        })?;
        out.insert(Utf8PathBuf::from(kind.primary_filename(name)), bytes);
    } else {
        let mut hashmap: std::collections::HashMap<Utf8PathBuf, Vec<u8>> =
            std::collections::HashMap::new();
        walk_into(source_path, source_path, &mut hashmap)?;
        for (k, v) in hashmap {
            out.insert(k, v);
        }
    }
    Ok(out)
}

fn build_install_record(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    target: Target,
    source_path: &Utf8Path,
    library_bundle: &BTreeMap<Utf8PathBuf, Vec<u8>>,
    timestamp: &str,
) -> Result<InstallRecord, Error> {
    // file_hashes (library side): hashes of the bytes we just wrote into
    // the library — keyed by library-canonical relpath.
    let mut file_hashes: BTreeMap<Utf8PathBuf, String> = BTreeMap::new();
    for (rel, bytes) in library_bundle {
        file_hashes.insert(rel.clone(), blake3::hash(bytes).to_hex().to_string());
    }

    // last_known_install_hashes + mtimes (install side): the source dir is
    // the install location for this target, so walk it again with its
    // native relpath layout.
    let (install_hashes, mtimes) = read_install_state(source_path)?;

    Ok(InstallRecord {
        kind,
        name: name.clone(),
        target,
        installed_version: VersionLabel::try_new("v1").expect("v1 valid"),
        file_hashes,
        last_known_install_hashes: install_hashes,
        mtimes,
        installed_at: timestamp.to_string(),
    })
}

type DiskState = (BTreeMap<Utf8PathBuf, String>, BTreeMap<Utf8PathBuf, i64>);

fn read_install_state(source_path: &Utf8Path) -> Result<DiskState, Error> {
    let meta = std::fs::metadata(source_path.as_std_path()).map_err(|source| Error::Io {
        path: source_path.to_string(),
        source,
    })?;
    let mut hashes = BTreeMap::new();
    let mut mtimes = BTreeMap::new();
    if meta.is_file() {
        let bytes = std::fs::read(source_path.as_std_path()).map_err(|source| Error::Io {
            path: source_path.to_string(),
            source,
        })?;
        hashes.insert(
            Utf8PathBuf::new(),
            blake3::hash(&bytes).to_hex().to_string(),
        );
        mtimes.insert(Utf8PathBuf::new(), mtime_unix(source_path)?);
    } else {
        walk_install_dir(source_path, source_path, &mut hashes, &mut mtimes)?;
    }
    Ok((hashes, mtimes))
}

fn walk_install_dir(
    root: &Utf8Path,
    cur: &Utf8Path,
    hashes: &mut BTreeMap<Utf8PathBuf, String>,
    mtimes: &mut BTreeMap<Utf8PathBuf, i64>,
) -> Result<(), Error> {
    let entries = std::fs::read_dir(cur.as_std_path()).map_err(|source| Error::Io {
        path: cur.to_string(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| Error::Io {
            path: cur.to_string(),
            source,
        })?;
        let abs = match Utf8PathBuf::from_path_buf(entry.path()) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let leaf = match abs.file_name() {
            Some(n) => n,
            None => continue,
        };
        if is_ignored(Utf8Path::new(leaf)) {
            continue;
        }
        let lmeta = std::fs::symlink_metadata(abs.as_std_path()).map_err(|source| Error::Io {
            path: abs.to_string(),
            source,
        })?;
        if lmeta.file_type().is_symlink() {
            continue;
        }
        if lmeta.is_dir() {
            walk_install_dir(root, &abs, hashes, mtimes)?;
        } else {
            let bytes = std::fs::read(abs.as_std_path()).map_err(|source| Error::Io {
                path: abs.to_string(),
                source,
            })?;
            let rel = abs.strip_prefix(root).unwrap_or(&abs).to_owned();
            hashes.insert(rel.clone(), blake3::hash(&bytes).to_hex().to_string());
            mtimes.insert(rel, mtime_unix(&abs)?);
        }
    }
    Ok(())
}

fn mtime_unix(p: &Utf8Path) -> Result<i64, Error> {
    let meta = std::fs::metadata(p.as_std_path()).map_err(|source| Error::Io {
        path: p.to_string(),
        source,
    })?;
    let modified = meta.modified().map_err(|source| Error::Io {
        path: p.to_string(),
        source,
    })?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ParseStatus, SymlinkedItem, UnclassifiedItem};
    use tempfile::TempDir;

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    #[test]
    fn execute_reimports_empty_input_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let installs = lib.join("installs.json");
        let layout = LibraryLayout::new(&lib);
        let paths = InstallPaths::new(tmp.path().join("home").to_string_lossy().into_owned());
        let s = execute_reimports(&[], layout, &paths, &installs, "ts").unwrap();
        assert_eq!(s.reimported, 0);
        assert_eq!(s.skipped, 0);
        assert!(!installs.exists());
    }

    #[test]
    fn drifted_skill_reimport_bumps_library_to_v2() {
        // Library has Skill `diagnose` at v1 (bytes A); user's source dir
        // has bytes B. After execute_reimports: library at v2 with bytes
        // B, current.txt = v2, install record updated to v2 with hashes
        // matching B.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("diagnose");

        // Bootstrap an initial Create for Skill claude diagnose at v1=A,
        // installs.json gets a v1 record. Use existing P5.4a path.
        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        let bytes_a = b"---\n---\nA\n";
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), bytes_a).unwrap();
        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Now overwrite the source bytes to simulate user-edited drift.
        let bytes_b = b"---\n---\nB-edited\n";
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), bytes_b).unwrap();

        // Reimport.
        let paths = InstallPaths::new(home.as_str());
        let s = execute_reimports(
            &[ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
            }],
            layout,
            &paths,
            &installs,
            "ts2",
        )
        .unwrap();
        assert_eq!(s.reimported, 1);
        assert_eq!(s.skipped, 0);

        // current.txt = v2; v2/base/SKILL.md = bytes_b.
        let cur = std::fs::read_to_string(lib.join("skills/diagnose/current.txt")).unwrap();
        assert_eq!(cur.trim(), "v2");
        assert_eq!(
            std::fs::read(lib.join("skills/diagnose/versions/v2/base/SKILL.md")).unwrap(),
            bytes_b
        );

        // Install record now points at v2.
        let f = InstallsFile::load(&installs).unwrap();
        let r = f
            .records
            .iter()
            .find(|r| r.name == nm && r.target == Target::Claude)
            .unwrap();
        assert_eq!(r.installed_version.as_str(), "v2");
        // Hashes of source = hashes of bytes_b.
        assert_eq!(
            r.last_known_install_hashes[&Utf8PathBuf::from("SKILL.md")],
            blake3::hash(bytes_b).to_hex().to_string()
        );
    }

    #[test]
    fn working_copy_dirty_skips_reimport_and_restores_installs_json() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("diagnose");

        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        let bytes_a = b"---\n---\nA\n";
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), bytes_a).unwrap();
        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();
        let installs_after_create = std::fs::read(&installs).unwrap();

        // Dirty the working copy with unpublished edits.
        std::fs::write(
            lib.join("skills/diagnose/working/base/SKILL.md").as_std_path(),
            b"---\n---\nlocal-edit\n",
        )
        .unwrap();

        // Source drifts too.
        std::fs::write(
            claude_dir.join("SKILL.md").as_std_path(),
            b"---\n---\nB\n",
        )
        .unwrap();

        let paths = InstallPaths::new(home.as_str());
        let s = execute_reimports(
            &[ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
            }],
            layout,
            &paths,
            &installs,
            "ts2",
        )
        .unwrap();
        assert_eq!(s.reimported, 0);
        assert_eq!(s.skipped, 1);

        // Library still at v1.
        let cur = std::fs::read_to_string(lib.join("skills/diagnose/current.txt")).unwrap();
        assert_eq!(cur.trim(), "v1");
        assert!(!lib.join("skills/diagnose/versions/v2").exists());

        // installs.json restored — no synthesized record left behind.
        let installs_now = std::fs::read(&installs).unwrap();
        assert_eq!(installs_now, installs_after_create);
    }

    #[test]
    fn agent_claude_flat_drift_round_trips_through_canonical_layout() {
        // Library Agent `foo` v1 base/agent.md = A. Source ~/.claude/agents/foo.md
        // (flat) = B. After reimport: library v2 base/agent.md = B. Install
        // record's last_known_install_hashes uses single empty key
        // (single-file install side); file_hashes uses `agent.md`.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("foo");
        let src = home.join(".claude/agents/foo.md");
        std::fs::create_dir_all(src.parent().unwrap().as_std_path()).unwrap();
        let bytes_a = b"---\n---\nA-flat\n";
        std::fs::write(src.as_std_path(), bytes_a).unwrap();

        // Initial create at v1.
        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Agent,
                name: nm.clone(),
                base: parsed_base(Target::Claude, src.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Drift: rewrite the source file.
        let bytes_b = b"---\n---\nB-flat\n";
        std::fs::write(src.as_std_path(), bytes_b).unwrap();

        let paths = InstallPaths::new(home.as_str());
        let s = execute_reimports(
            &[ReimportAction {
                kind: PrimitiveKind::Agent,
                name: nm.clone(),
                base: parsed_base(Target::Claude, src.as_str()),
            }],
            layout,
            &paths,
            &installs,
            "ts2",
        )
        .unwrap();
        assert_eq!(s.reimported, 1);

        // v2 base/agent.md = B (canonicalized name).
        assert_eq!(
            std::fs::read(lib.join("agents/foo/versions/v2/base/agent.md")).unwrap(),
            bytes_b
        );

        let f = InstallsFile::load(&installs).unwrap();
        let r = f.records.iter().find(|r| r.name == nm).unwrap();
        assert_eq!(r.installed_version.as_str(), "v2");
        // last_known_install_hashes is single-file (empty key).
        assert_eq!(
            r.last_known_install_hashes.keys().collect::<Vec<_>>(),
            vec![&Utf8PathBuf::new()]
        );
    }

    #[test]
    fn execute_creates_empty_input_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        let installs = lib_root.join("installs.json");
        let layout = LibraryLayout::new(&lib_root);

        let summary = execute_creates(&[], layout, &installs, "2026-05-05T00:00:00Z").unwrap();
        assert_eq!(summary.created, 0);
        assert!(!installs.exists(), "no installs.json should be written");
    }

    /// Build a temp library + temp home, write `bytes` at the given source
    /// relpath under home, return (layout-ready lib_root, source path).
    fn fixture_with_skill_source(rel: &str, bytes: &[u8]) -> (TempDir, Utf8PathBuf, Utf8PathBuf) {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let abs = home.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap().as_std_path()).unwrap();
        std::fs::write(abs.as_std_path(), bytes).unwrap();
        let source_dir = abs.parent().unwrap().to_owned();
        (tmp, lib, source_dir)
    }

    #[test]
    fn skill_identical_single_target_writes_library_state_and_install_record() {
        let body = b"---\ndescription: shared\n---\nbody\n";
        let (_tmp, lib, source) =
            fixture_with_skill_source(".claude/skills/diagnose/SKILL.md", body);
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("diagnose");

        let action = CreateAction {
            kind: PrimitiveKind::Skill,
            name: nm.clone(),
            base: parsed_base(Target::Claude, source.as_str()),
            overlays: vec![],
        };
        let summary =
            execute_creates(&[action], layout, &installs, "2026-05-05T00:00:00Z").unwrap();
        assert_eq!(summary.created, 1);

        // metadata.yaml
        let meta_path = lib.join("skills/diagnose/metadata.yaml");
        let meta_yaml = std::fs::read_to_string(&meta_path).unwrap();
        let meta = PrimitiveMetadata::from_yaml(&meta_yaml).unwrap();
        assert_eq!(meta.allowed_targets, vec![Target::Claude]);
        assert_eq!(meta.created_at, "2026-05-05T00:00:00Z");

        // working/base/SKILL.md
        let base_md = lib.join("skills/diagnose/working/base/SKILL.md");
        assert_eq!(std::fs::read(&base_md).unwrap(), body);

        // versions/v1/base/SKILL.md (snapshot)
        let v1_md = lib.join("skills/diagnose/versions/v1/base/SKILL.md");
        assert!(v1_md.exists());

        // current.txt = v1
        let current = std::fs::read_to_string(lib.join("skills/diagnose/current.txt")).unwrap();
        assert_eq!(current.trim(), "v1");

        // installs.json contains one record for Skill+claude+diagnose at v1
        let f = InstallsFile::load(&installs).unwrap();
        assert_eq!(f.records.len(), 1);
        let r = &f.records[0];
        assert_eq!(r.kind, PrimitiveKind::Skill);
        assert_eq!(r.name, nm);
        assert_eq!(r.target, Target::Claude);
        assert_eq!(r.installed_version.as_str(), "v1");
        assert_eq!(r.installed_at, "2026-05-05T00:00:00Z");
        // file_hashes (library side) keyed by "SKILL.md"
        assert!(r.file_hashes.contains_key(&Utf8PathBuf::from("SKILL.md")));
        // last_known_install_hashes (source side) also keyed by "SKILL.md"
        // since the source dir layout matches.
        assert!(r
            .last_known_install_hashes
            .contains_key(&Utf8PathBuf::from("SKILL.md")));
        assert_eq!(
            r.file_hashes[&Utf8PathBuf::from("SKILL.md")],
            r.last_known_install_hashes[&Utf8PathBuf::from("SKILL.md")]
        );
    }

    #[test]
    fn skill_differs_writes_overlay_target_and_two_install_records() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude = home.join(".claude/skills/diagnose");
        let pi = home.join(".pi/agent/skills/diagnose");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::create_dir_all(pi.as_std_path()).unwrap();
        std::fs::write(claude.join("SKILL.md").as_std_path(), b"---\n---\nclaude\n").unwrap();
        std::fs::write(pi.join("SKILL.md").as_std_path(), b"---\n---\npi-tweaked\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("diagnose");

        let action = CreateAction {
            kind: PrimitiveKind::Skill,
            name: nm.clone(),
            base: parsed_base(Target::Claude, claude.as_str()),
            overlays: vec![parsed_overlay(Target::Pi, pi.as_str())],
        };
        execute_creates(&[action], layout, &installs, "2026-05-05T00:00:00Z").unwrap();

        // working/base from claude.
        assert_eq!(
            std::fs::read(lib.join("skills/diagnose/working/base/SKILL.md")).unwrap(),
            b"---\n---\nclaude\n"
        );
        // working/targets/pi from pi.
        assert_eq!(
            std::fs::read(lib.join("skills/diagnose/working/targets/pi/SKILL.md")).unwrap(),
            b"---\n---\npi-tweaked\n"
        );

        // metadata.allowed_targets in order: claude (base), pi (overlay).
        let meta_yaml = std::fs::read_to_string(lib.join("skills/diagnose/metadata.yaml")).unwrap();
        let meta = PrimitiveMetadata::from_yaml(&meta_yaml).unwrap();
        assert_eq!(meta.allowed_targets, vec![Target::Claude, Target::Pi]);

        // Two install records.
        let f = InstallsFile::load(&installs).unwrap();
        assert_eq!(f.records.len(), 2);
        let mut targets: Vec<Target> = f.records.iter().map(|r| r.target).collect();
        targets.sort_by_key(|t| format!("{t:?}"));
        assert_eq!(targets, vec![Target::Claude, Target::Pi]);
    }

    #[test]
    fn agent_claude_flat_source_canonicalizes_to_library_agent_md() {
        // Source ~/.claude/agents/foo.md (flat) should land at library
        // agents/foo/working/base/agent.md and InstallRecord uses single
        // empty-key entry on the install side.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let src = home.join(".claude/agents/foo.md");
        std::fs::create_dir_all(src.parent().unwrap().as_std_path()).unwrap();
        let bytes = b"---\n---\nflat agent\n";
        std::fs::write(src.as_std_path(), bytes).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("foo");

        let action = CreateAction {
            kind: PrimitiveKind::Agent,
            name: nm.clone(),
            base: parsed_base(Target::Claude, src.as_str()),
            overlays: vec![],
        };
        execute_creates(&[action], layout, &installs, "ts").unwrap();

        // Library has agent.md (canonicalized name).
        let lib_agent = lib.join("agents/foo/working/base/agent.md");
        assert_eq!(std::fs::read(&lib_agent).unwrap(), bytes);
        // No `foo.md` leaked through.
        assert!(!lib.join("agents/foo/working/base/foo.md").exists());

        // InstallRecord: file_hashes keyed by "agent.md" (library side).
        // last_known_install_hashes keyed by "" (single-file install side).
        let f = InstallsFile::load(&installs).unwrap();
        assert_eq!(f.records.len(), 1);
        let r = &f.records[0];
        assert_eq!(
            r.file_hashes.keys().collect::<Vec<_>>(),
            vec![&Utf8PathBuf::from("agent.md")]
        );
        assert_eq!(
            r.last_known_install_hashes.keys().collect::<Vec<_>>(),
            vec![&Utf8PathBuf::new()]
        );
        // Both hashes are over the same bytes, so they match.
        assert_eq!(
            r.file_hashes[&Utf8PathBuf::from("agent.md")],
            r.last_known_install_hashes[&Utf8PathBuf::new()]
        );
    }

    #[test]
    fn batch_of_two_writes_both_primitives_and_records() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");

        let a = home.join(".claude/skills/aaa");
        let b = home.join(".claude/skills/bbb");
        std::fs::create_dir_all(a.as_std_path()).unwrap();
        std::fs::create_dir_all(b.as_std_path()).unwrap();
        std::fs::write(a.join("SKILL.md").as_std_path(), b"---\n---\naaa\n").unwrap();
        std::fs::write(b.join("SKILL.md").as_std_path(), b"---\n---\nbbb\n").unwrap();

        let actions = vec![
            CreateAction {
                kind: PrimitiveKind::Skill,
                name: name("aaa"),
                base: parsed_base(Target::Claude, a.as_str()),
                overlays: vec![],
            },
            CreateAction {
                kind: PrimitiveKind::Skill,
                name: name("bbb"),
                base: parsed_base(Target::Claude, b.as_str()),
                overlays: vec![],
            },
        ];
        let summary = execute_creates(&actions, layout, &installs, "ts").unwrap();
        assert_eq!(summary.created, 2);

        assert!(lib.join("skills/aaa/working/base/SKILL.md").exists());
        assert!(lib.join("skills/bbb/working/base/SKILL.md").exists());
        let f = InstallsFile::load(&installs).unwrap();
        assert_eq!(f.records.len(), 2);
        let names: Vec<&str> = f.records.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"aaa"));
        assert!(names.contains(&"bbb"));
    }

    fn empty_cr() -> CrossReferenced {
        CrossReferenced {
            groups: vec![],
            needs_manual_review: vec![],
            symlinked: vec![],
            unclassified: vec![],
        }
    }

    #[test]
    fn empty_cross_referenced_yields_empty_plan() {
        let plan = derive_plan(empty_cr());
        assert!(plan.creates.is_empty());
        assert!(plan.reimports.is_empty());
    }

    #[test]
    fn already_imported_groups_drop_out_of_plan() {
        let plan = derive_plan(CrossReferenced {
            groups: vec![ClassifiedGroup {
                kind: PrimitiveKind::Skill,
                name: name("kept"),
                classification: Classification::AlreadyImported,
            }],
            ..empty_cr()
        });
        assert!(plan.creates.is_empty());
        assert!(plan.reimports.is_empty());
    }

    #[test]
    fn needs_manual_review_drops_out_of_plan() {
        let plan = derive_plan(CrossReferenced {
            needs_manual_review: vec![crate::ManualReviewGroup {
                kind: PrimitiveKind::Skill,
                name: name("broken"),
                members: vec![],
            }],
            ..empty_cr()
        });
        assert!(plan.creates.is_empty());
        assert!(plan.reimports.is_empty());
    }

    fn parsed_base(target: Target, path: &str) -> BaseAssignment {
        BaseAssignment {
            target,
            source_path: Utf8PathBuf::from(path),
            parse: ParseStatus::Parsed,
        }
    }

    fn parsed_overlay(target: Target, path: &str) -> OverlayCandidate {
        OverlayCandidate {
            target,
            source_path: Utf8PathBuf::from(path),
            parse: ParseStatus::Parsed,
        }
    }

    #[test]
    fn resume_after_fixing_skipped_reimport_completes_and_clears_session() {
        // Run 1: skip (working copy dirty). Run 2: discard working changes,
        // resume → reimport succeeds, session cleared.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nA\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let nm = name("diagnose");

        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Dirty working copy + drift source.
        let working_md = lib.join("skills/diagnose/working/base/SKILL.md");
        std::fs::write(working_md.as_std_path(), b"---\n---\nlocal-edit\n").unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nB\n").unwrap();

        let paths = InstallPaths::new(home.as_str());
        let plan = BootstrapPlan {
            creates: vec![],
            reimports: vec![ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
            }],
        };

        let s1 = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "ts2",
            resume: None,
            excluded_ids: vec![],
        })
        .unwrap();
        assert_eq!(s1.skipped, 1);
        assert!(session.exists(), "session preserved after skip");

        // User "fixes" the dirty working copy by reverting to the v1 bytes.
        std::fs::write(working_md.as_std_path(), b"---\n---\nA\n").unwrap();

        // Resume.
        let saved = BootstrapSession::load(&session).unwrap().unwrap();
        let s2 = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "ts3",
            resume: Some(saved),
            excluded_ids: vec![],
        })
        .unwrap();
        assert_eq!(s2.reimported, 1);
        assert_eq!(s2.skipped, 0);
        assert!(s2.backup_path.is_none(), "no fresh backup on resume");
        assert!(!session.exists(), "session cleared after successful retry");

        // Library now at v2.
        assert_eq!(
            std::fs::read_to_string(lib.join("skills/diagnose/current.txt"))
                .unwrap()
                .trim(),
            "v2"
        );
    }

    #[test]
    fn bootstrap_reconciles_case_only_orphan_and_reports_count() {
        // Reproduces the live bug: a case-only manual disk rename
        // (`Teach`→`teach`) left the install record at the old case while the
        // library dir is lowercase. bootstrap_execute must re-link the record
        // (no create/reimport) and report the count — and be idempotent.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude_dir = home.join(".claude/skills/teach");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nA\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");

        // v1 `teach` in the library + an install record named `teach`.
        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: name("teach"),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Simulate the case-only rename: record stuck at uppercase `Teach`
        // while the library dir stays `teach`.
        let mut f = InstallsFile::load(&installs).unwrap();
        f.records[0].name = name("Teach");
        f.save(&installs).unwrap();

        let paths = InstallPaths::new(home.as_str());
        let plan = BootstrapPlan {
            creates: vec![],
            reimports: vec![],
        };
        let exec = |ts: &str| {
            bootstrap_execute(BootstrapExecuteRequest {
                plan: &plan,
                layout,
                install_paths: &paths,
                installs_file: &installs,
                session_path: &session,
                backup_dir: &backup_dir,
                home: &home,
                timestamp: ts,
                resume: None,
                excluded_ids: vec![],
            })
            .unwrap()
        };

        let s1 = exec("ts2");
        assert_eq!(s1.reconciled, 1, "one record re-linked");
        assert_eq!(s1.created, 0);
        assert_eq!(s1.reimported, 0);

        let after = InstallsFile::load(&installs).unwrap();
        assert_eq!(after.records.len(), 1);
        assert_eq!(
            after.records[0].name.as_str(),
            "teach",
            "record re-linked to the library's canonical case"
        );

        // Idempotent: a second bootstrap reconciles nothing (AC8).
        let s2 = exec("ts3");
        assert_eq!(s2.reconciled, 0, "already canonical; nothing to reconcile");
    }

    #[test]
    fn skipped_reimport_leaves_session_in_place_for_user_review() {
        // Working-copy is dirty → reimport returns Skipped. Session file
        // must remain (so the wizard surfaces "N unresolved skips" on
        // relaunch) and the skipped item must NOT be marked done.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nA\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let nm = name("diagnose");

        // v1 already in library.
        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Dirty the working copy and drift the source.
        std::fs::write(
            lib.join("skills/diagnose/working/base/SKILL.md").as_std_path(),
            b"---\n---\nlocal-edit\n",
        )
        .unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nB\n").unwrap();

        let paths = InstallPaths::new(home.as_str());
        let plan = BootstrapPlan {
            creates: vec![],
            reimports: vec![ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
            }],
        };

        let summary = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "ts2",
            resume: None,
            excluded_ids: vec![],
        })
        .unwrap();

        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.reimported, 0);
        assert_eq!(summary.skipped_items.len(), 1);
        assert_eq!(summary.skipped_items[0].kind, PrimitiveKind::Skill);
        assert_eq!(summary.skipped_items[0].name, nm);
        assert_eq!(summary.skipped_items[0].source_target, Target::Claude);
        assert_eq!(
            summary.skipped_items[0].reason,
            BootstrapSkipReason::WorkingCopyDirty
        );

        // Session left in place for the wizard's "unresolved skips" pane.
        assert!(session.exists(), "session must persist when skips remain");
        let saved = BootstrapSession::load(&session).unwrap().unwrap();
        // Skipped item NOT marked done — resume will retry it.
        assert!(!saved.is_reimport_done(PrimitiveKind::Skill, &nm));
        assert!(saved.backup_taken, "backup state must survive skip-only runs");
        assert!(saved.completed.is_empty(), "no item completed");
    }

    #[test]
    fn resume_skips_completed_creates_and_does_not_rewrite_backup() {
        // Two creates planned, but the resume session marks "alpha" done.
        // bootstrap_execute should: skip alpha (don't re-create), process
        // beta, NOT write a new backup tarball.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let alpha_dir = home.join(".claude/skills/alpha");
        let beta_dir = home.join(".claude/skills/beta");
        std::fs::create_dir_all(alpha_dir.as_std_path()).unwrap();
        std::fs::create_dir_all(beta_dir.as_std_path()).unwrap();
        std::fs::write(alpha_dir.join("SKILL.md").as_std_path(), b"---\n---\nA\n").unwrap();
        std::fs::write(beta_dir.join("SKILL.md").as_std_path(), b"---\n---\nB\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let paths = InstallPaths::new(home.as_str());

        // Pretend a prior partial run already created alpha.
        let mut prior = BootstrapSession::new("orig-ts");
        prior.record_create(PrimitiveKind::Skill, &name("alpha"));
        prior.backup_taken = true;

        let plan = BootstrapPlan {
            creates: vec![
                CreateAction {
                    kind: PrimitiveKind::Skill,
                    name: name("alpha"),
                    base: parsed_base(Target::Claude, alpha_dir.as_str()),
                    overlays: vec![],
                },
                CreateAction {
                    kind: PrimitiveKind::Skill,
                    name: name("beta"),
                    base: parsed_base(Target::Claude, beta_dir.as_str()),
                    overlays: vec![],
                },
            ],
            reimports: vec![],
        };

        let summary = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "resume-ts",
            resume: Some(prior),
            excluded_ids: vec![],
        })
        .unwrap();

        // Only beta processed.
        assert_eq!(summary.created, 1);
        assert!(summary.backup_path.is_none(), "no fresh backup on resume");
        // Backup dir empty (nothing to back up since we resumed).
        assert!(
            !backup_dir.join("resume-ts.tar.gz").exists(),
            "no resume-ts tarball written"
        );

        // Beta exists in library.
        assert!(lib.join("skills/beta/working/base/SKILL.md").exists());
        // Alpha NOT created — resume skipped it (verifies session filter).
        assert!(!lib.join("skills/alpha").exists());

        // Session cleared on success.
        assert!(!session.exists());
    }

    #[test]
    fn bootstrap_execute_runs_drifted_reimport_to_v2() {
        // Set up: v1 already in library (created via execute_creates), then
        // mutate the source bytes so a Drifted reimport is needed. Run
        // bootstrap_execute with a reimport-only plan and verify v2.
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nA\n").unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let nm = name("diagnose");

        execute_creates(
            &[CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            layout,
            &installs,
            "ts1",
        )
        .unwrap();

        // Drift the source.
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), b"---\n---\nB\n").unwrap();

        let paths = InstallPaths::new(home.as_str());
        let plan = BootstrapPlan {
            creates: vec![],
            reimports: vec![ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
            }],
        };

        let summary = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "20260505T120100Z",
            resume: None,
            excluded_ids: vec![],
        })
        .unwrap();

        assert_eq!(summary.reimported, 1);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.created, 0);
        assert!(summary.skipped_items.is_empty());

        // Library at v2.
        assert_eq!(
            std::fs::read_to_string(lib.join("skills/diagnose/current.txt"))
                .unwrap()
                .trim(),
            "v2"
        );
        assert_eq!(
            std::fs::read(lib.join("skills/diagnose/versions/v2/base/SKILL.md")).unwrap(),
            b"---\n---\nB\n"
        );

        // Session cleared.
        assert!(!session.exists());
    }

    #[test]
    fn bootstrap_execute_single_create_writes_backup_primitive_and_install_record() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let claude_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude_dir.as_std_path()).unwrap();
        let body = b"---\n---\nbody\n";
        std::fs::write(claude_dir.join("SKILL.md").as_std_path(), body).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let paths = InstallPaths::new(home.as_str());
        let nm = name("diagnose");
        let plan = BootstrapPlan {
            creates: vec![CreateAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude_dir.as_str()),
                overlays: vec![],
            }],
            reimports: vec![],
        };

        let summary = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "20260505T120000Z",
            resume: None,
            excluded_ids: vec![],
        })
        .unwrap();

        assert_eq!(summary.created, 1);
        assert_eq!(summary.reimported, 0);
        assert_eq!(summary.skipped, 0);
        assert!(summary.skipped_items.is_empty());
        let bp = summary.backup_path.expect("backup written");
        assert_eq!(
            bp,
            backup_dir.join("20260505T120000Z.tar.gz"),
            "backup at predictable path"
        );
        assert!(bp.exists());

        // Library state: v1 base with body.
        assert_eq!(
            std::fs::read(lib.join("skills/diagnose/working/base/SKILL.md")).unwrap(),
            body
        );
        assert!(lib.join("skills/diagnose/versions/v1/base/SKILL.md").exists());

        // Install record written.
        let f = InstallsFile::load(&installs).unwrap();
        assert_eq!(f.records.len(), 1);
        assert_eq!(f.records[0].name, nm);

        // Session cleared after full success.
        assert!(!session.exists(), "session file removed on full completion");
    }

    #[test]
    fn bootstrap_plan_round_trips_through_serde_json() {
        // The plan ships across the IPC boundary in P5.5b/c, so it must
        // serialize and deserialize losslessly.
        let plan = BootstrapPlan {
            creates: vec![CreateAction {
                kind: PrimitiveKind::Skill,
                name: name("alpha"),
                base: parsed_base(Target::Claude, "/x/.claude/skills/alpha"),
                overlays: vec![parsed_overlay(Target::Pi, "/x/.pi/agent/skills/alpha")],
            }],
            reimports: vec![ReimportAction {
                kind: PrimitiveKind::Skill,
                name: name("beta"),
                base: parsed_base(Target::Claude, "/x/.claude/skills/beta"),
            }],
        };
        let json = serde_json::to_string(&plan).expect("serialize");
        let back: BootstrapPlan = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(plan, back);
    }

    #[test]
    fn bootstrap_execute_empty_plan_empty_home_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup_dir = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let session = lib.join("bootstrap-session.json");
        let paths = InstallPaths::new(home.as_str());
        let plan = BootstrapPlan {
            creates: vec![],
            reimports: vec![],
        };

        let summary = bootstrap_execute(BootstrapExecuteRequest {
            plan: &plan,
            layout,
            install_paths: &paths,
            installs_file: &installs,
            session_path: &session,
            backup_dir: &backup_dir,
            home: &home,
            timestamp: "ts",
            resume: None,
            excluded_ids: vec![],
        })
        .unwrap();

        assert_eq!(summary.created, 0);
        assert_eq!(summary.reimported, 0);
        assert_eq!(summary.skipped, 0);
        assert!(summary.skipped_items.is_empty());
        assert!(summary.backup_path.is_none(), "no source dirs → no backup");
        assert!(!session.exists(), "no work happened → no session left behind");
        assert!(!installs.exists(), "no installs touched");
    }

    #[test]
    fn new_identical_group_becomes_create_with_no_overlays() {
        let nm = name("diagnose");
        let plan = derive_plan(CrossReferenced {
            groups: vec![ClassifiedGroup {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                classification: Classification::New {
                    content: DedupeContent::Identical {
                        base: parsed_base(Target::Claude, "/x/.claude/skills/diagnose"),
                    },
                },
            }],
            ..empty_cr()
        });
        assert_eq!(plan.creates.len(), 1);
        let c = &plan.creates[0];
        assert_eq!(c.kind, PrimitiveKind::Skill);
        assert_eq!(c.name, nm);
        assert_eq!(c.base.target, Target::Claude);
        assert!(c.overlays.is_empty());
        assert!(plan.reimports.is_empty());
    }

    #[test]
    fn new_differs_group_becomes_create_with_overlays() {
        let nm = name("diagnose");
        let plan = derive_plan(CrossReferenced {
            groups: vec![ClassifiedGroup {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                classification: Classification::New {
                    content: DedupeContent::Differs {
                        base: parsed_base(Target::Claude, "/x/.claude/skills/diagnose"),
                        overlays: vec![parsed_overlay(
                            Target::Pi,
                            "/x/.pi/agent/skills/diagnose",
                        )],
                    },
                },
            }],
            ..empty_cr()
        });
        let c = &plan.creates[0];
        assert_eq!(c.overlays.len(), 1);
        assert_eq!(c.overlays[0].target, Target::Pi);
    }

    #[test]
    fn drifted_group_becomes_reimport() {
        let nm = name("diagnose");
        let plan = derive_plan(CrossReferenced {
            groups: vec![ClassifiedGroup {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                classification: Classification::Drifted {
                    content: DedupeContent::Identical {
                        base: parsed_base(Target::Claude, "/x/.claude/skills/diagnose"),
                    },
                },
            }],
            ..empty_cr()
        });
        assert!(plan.creates.is_empty());
        assert_eq!(plan.reimports.len(), 1);
        let r = &plan.reimports[0];
        assert_eq!(r.kind, PrimitiveKind::Skill);
        assert_eq!(r.name, nm);
        assert_eq!(r.base.target, Target::Claude);
    }

    /// Symlinked/Unclassified pass through CrossReferenced but don't
    /// influence the plan — they're surfaced in dedicated wizard panes,
    /// not auto-imported.
    #[test]
    fn symlinked_and_unclassified_do_not_leak_into_plan() {
        let plan = derive_plan(CrossReferenced {
            groups: vec![],
            needs_manual_review: vec![],
            symlinked: vec![SymlinkedItem {
                source_path: Utf8PathBuf::from("/x/.claude/skills/linked"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                link_target: None,
            }],
            unclassified: vec![UnclassifiedItem {
                source_path: Utf8PathBuf::from("/x/.claude/skills/no-primary"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                reason: "missing SKILL.md".into(),
            }],
        });
        assert!(plan.creates.is_empty());
        assert!(plan.reimports.is_empty());
        let _ = ParseStatus::Parsed; // keep import live for later slices
    }

    // ----------------------------------------------------------------------
    // Regression: stale-plan / scan-time-snapshot bug (the bootstrap overlay
    // bug). A BootstrapPlan is derived from one filesystem state (scan time)
    // and EXECUTED against a later, mutated state (after the user syncs). The
    // plan carries scan-time `source_path`s and target assignments; execution
    // re-reads those paths verbatim, so deleted/changed copies on disk produce
    // the wrong base/overlay split. See docs/notes/2026-06-16-bootstrap-overlay-bug.md.
    //
    // These tests FAIL today: they assert the CORRECT (post-sync) outcome, and
    // the stale-plan execution produces the buggy outcome instead.
    // ----------------------------------------------------------------------

    use crate::{bootstrap_scan, WorkingCopy};

    /// Re-scan + re-derive the plan against the CURRENT filesystem. This is
    /// what a correct flow must do before executing. The bug is that the UI
    /// (and `execute_creates` callers) hold the stale plan instead.
    fn scan_and_plan(home: &Utf8Path, layout: LibraryLayout<'_>) -> BootstrapPlan {
        let cr = bootstrap_scan(home, layout, |_| {}).unwrap();
        derive_plan(cr)
    }

    /// Symptom 3 — the SMOKING GUN. A two-target group (claude NEW + pi OLD)
    /// is scanned, yielding a Differs plan with base=claude, overlay=pi(OLD).
    /// The user then SYNCS: pi is updated to match claude (both NEW). A fresh
    /// scan now yields a single Identical group, base=NEW, NO overlay. But if
    /// the STALE plan is executed, it re-reads the pi path as an overlay,
    /// conjuring a phantom pi overlay. At execute time the ONLY correct outcome
    /// is base=NEW with zero overlays.
    ///
    /// We assert the CORRECT outcome → currently FAILS.
    #[test]
    fn stale_plan_conjures_phantom_overlay_from_synced_source_bug() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("grill-with-docs");

        let claude = home.join(".claude/skills/grill-with-docs");
        let pi = home.join(".pi/agent/skills/grill-with-docs");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::create_dir_all(pi.as_std_path()).unwrap();
        let old = b"---\ndescription: g\n---\nOLD body\n";
        let new = b"---\ndescription: g\n---\nNEW body\n";
        // Scan-time state: claude=NEW, pi=OLD → Differs (base=claude, overlay=pi OLD).
        std::fs::write(claude.join("SKILL.md").as_std_path(), new).unwrap();
        std::fs::write(pi.join("SKILL.md").as_std_path(), old).unwrap();

        // 1. Derive the plan at scan time (this is the plan the UI caches).
        let stale_plan = scan_and_plan(&home, layout);
        // Sanity: scan-time plan IS a Differs-derived create with a pi overlay.
        assert_eq!(stale_plan.creates.len(), 1);
        assert_eq!(
            stale_plan.creates[0].overlays.len(),
            1,
            "scan-time plan has the pi overlay (expected — this is the cached plan)"
        );

        // 2. USER SYNCS: pi is brought into line with claude (now both NEW).
        //    A fresh scan here would collapse to one Identical group, no overlay.
        std::fs::write(pi.join("SKILL.md").as_std_path(), new).unwrap();

        // Confirm a FRESH plan would be correct: base=NEW, zero overlays.
        let fresh_plan = scan_and_plan(&home, layout);
        assert_eq!(fresh_plan.creates.len(), 1);
        assert!(
            fresh_plan.creates[0].overlays.is_empty(),
            "a re-scan after sync correctly yields NO overlay"
        );

        // 3. But the buggy flow executes the STALE plan instead of re-scanning.
        execute_creates(&stale_plan.creates, layout, &installs, "ts").unwrap();

        // ASSERT THE CORRECT OUTCOME (currently fails): base=NEW, no pi overlay.
        let base_md = lib.join("skills/grill-with-docs/working/base/SKILL.md");
        assert_eq!(
            std::fs::read(&base_md).unwrap(),
            new,
            "library base must be the NEW synced content"
        );
        let pi_overlay = lib.join("skills/grill-with-docs/working/targets/pi/SKILL.md");
        assert!(
            !pi_overlay.exists(),
            "BUG: stale plan wrote a phantom pi overlay though both copies are now identical"
        );
        let meta_yaml =
            std::fs::read_to_string(lib.join("skills/grill-with-docs/metadata.yaml")).unwrap();
        let meta = PrimitiveMetadata::from_yaml(&meta_yaml).unwrap();
        assert_eq!(
            meta.allowed_targets,
            vec![Target::Claude],
            "BUG: phantom pi leaked into allowed_targets"
        );
        let _ = &nm;
    }

    /// Symptom 1 — `teach`. Scan-time: claude=NEW, codex=OLD → Differs.
    /// Post-sync both are NEW. Correct outcome: base=NEW, NO overlays. Stale
    /// plan keeps a redundant overlay.
    #[test]
    fn stale_plan_leaves_redundant_overlay_teach_bug() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");

        let claude = home.join(".claude/skills/teach");
        let codex = home.join(".codex/skills/teach");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::create_dir_all(codex.as_std_path()).unwrap();
        let old = b"---\ndescription: t\n---\nOLD\n";
        let new = b"---\ndescription: t\n---\nNEW\n";
        std::fs::write(claude.join("SKILL.md").as_std_path(), new).unwrap();
        std::fs::write(codex.join("SKILL.md").as_std_path(), old).unwrap();

        let stale_plan = scan_and_plan(&home, layout);
        assert_eq!(stale_plan.creates.len(), 1);

        // SYNC: codex brought up to NEW. Both identical now.
        std::fs::write(codex.join("SKILL.md").as_std_path(), new).unwrap();

        execute_creates(&stale_plan.creates, layout, &installs, "ts").unwrap();

        // Correct: base=NEW, no overlays (both copies identical post-sync).
        assert_eq!(
            std::fs::read(lib.join("skills/teach/working/base/SKILL.md")).unwrap(),
            new,
            "base must be NEW content"
        );
        assert!(
            !lib.join("skills/teach/working/targets/codex/SKILL.md").exists()
                && !lib.join("skills/teach/working/targets/claude/SKILL.md").exists(),
            "BUG: redundant overlay survived though both copies are identical"
        );
    }

    /// Symptom 2 — `grill-with-docs` reimport. A primitive imported earlier
    /// with phantom multi-target metadata (from a stale create) is later
    /// reimported. Because reimport routes base-vs-overlay off
    /// `metadata.allowed_targets`, multi-target metadata makes the NEW bytes
    /// land in a `targets/claude` overlay, leaving `base` OLD. Correct outcome
    /// for a single-real-source primitive: base=NEW.
    #[test]
    fn reimport_with_phantom_multitarget_metadata_keeps_base_stale_bug() {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        let layout = LibraryLayout::new(&lib);
        let installs = lib.join("installs.json");
        let nm = name("grill-with-docs");

        let claude = home.join(".claude/skills/grill-with-docs");
        let pi = home.join(".pi/agent/skills/grill-with-docs");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::create_dir_all(pi.as_std_path()).unwrap();
        let new = b"---\ndescription: g\n---\nNEW\n";
        // Differs requires distinct content; pi is a byte off so create yields
        // base=claude(OLD) + overlay=pi → metadata gets BOTH targets.
        std::fs::write(claude.join("SKILL.md").as_std_path(), b"---\ndescription: g\n---\nOLD\n")
            .unwrap();
        std::fs::write(pi.join("SKILL.md").as_std_path(), b"---\ndescription: g\n---\nOLD-pi\n")
            .unwrap();
        let plan0 = scan_and_plan(&home, layout);
        execute_creates(&plan0.creates, layout, &installs, "ts0").unwrap();
        let meta0 = PrimitiveMetadata::from_yaml(
            &std::fs::read_to_string(lib.join("skills/grill-with-docs/metadata.yaml")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta0.allowed_targets.len(), 2, "setup: multi-target metadata");

        // User deletes the pi copy and edits claude → NEW. Only claude remains.
        std::fs::remove_dir_all(pi.as_std_path()).unwrap();
        std::fs::write(claude.join("SKILL.md").as_std_path(), new).unwrap();

        // Reimport the claude drift.
        let paths = InstallPaths::new(home.as_str());
        let s = execute_reimports(
            &[ReimportAction {
                kind: PrimitiveKind::Skill,
                name: nm.clone(),
                base: parsed_base(Target::Claude, claude.as_str()),
            }],
            layout,
            &paths,
            &installs,
            "ts1",
        )
        .unwrap();
        assert_eq!(s.reimported, 1);

        // Correct: the NEW bytes should land at base. Because metadata still
        // lists pi, reimport treats claude as an OVERLAY → base stays OLD.
        let cur = std::fs::read_to_string(lib.join("skills/grill-with-docs/current.txt"))
            .unwrap()
            .trim()
            .trim_start_matches('v')
            .to_string();
        let wc = WorkingCopy::new(layout)
            .load(PrimitiveKind::Skill, &nm)
            .unwrap();
        let base_bytes = wc.base.get(Utf8Path::new("SKILL.md")).cloned();
        assert_eq!(
            base_bytes.as_deref(),
            Some(new.as_slice()),
            "BUG (v{cur}): reimport wrote NEW to a claude overlay; base left stale OLD"
        );
    }
}
