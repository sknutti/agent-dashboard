//! P4.3 b.2: re-import installed bytes back into the library as a new
//! published version.
//!
//! When a user has edited a primitive's installed copy out-of-band (drift),
//! they can choose to capture those edits as the next library version. The
//! flow is:
//!
//! 1. Read the install location's bytes.
//! 2. Validate the primary file's frontmatter (or TOML for CodexAgent) parses;
//!    surface `BrokenSource` if not, so the UI can offer a manual-fix sheet.
//! 3. Hard-block (`WorkingCopyDirty`) if `working/` has unpublished edits;
//!    the UI offers `[Discard & re-import]` which retries with
//!    `discard_working = true`.
//! 4. With a clean working copy (or after discard-revert to current), apply
//!    the install bytes to either `working/base/` (single-allowed-target
//!    primitive) or `working/targets/<source_target>/` (multi-target —
//!    preserves base + other-target overlays).
//! 5. Snapshot as `new_version`, bump `current.txt`.
//! 6. Re-baseline `installs.json` for `source_target` so drift clears.

use std::collections::BTreeMap;
use std::fs;
use std::time::UNIX_EPOCH;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::detail::revert_primitive_to_version;
use crate::fs_helpers::walk_into;
use crate::install_paths::InstallPaths;
use crate::install_state::{InstallRecord, InstallsFile};
use crate::kind_target::InstallLayout;
use crate::version_store::{VersionMetadata, VersionStore};
use crate::working_copy::WorkingCopy;
use crate::{
    is_ignored, CodexAgentFile, Error, LibraryLayout, MdPrimitive, PrimitiveKind, PrimitiveMetadata,
    PrimitiveName, Target, VersionLabel,
};

/// Inputs to [`reimport_install_as_version`].
pub struct ReimportRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub install_paths: &'a InstallPaths,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub name: &'a PrimitiveName,
    pub source_target: Target,
    pub new_version: VersionLabel,
    pub created_at: &'a str,
    pub notes: Option<String>,
    /// On `false`, returns [`ReimportResult::WorkingCopyDirty`] if `working/`
    /// diverges from the current pinned version. On `true`, working/ is
    /// reverted to the current version first, then imported bytes are
    /// layered on — preserving published overlays for other targets while
    /// discarding only unpublished edits.
    pub discard_working: bool,
    /// Broken-source retry path: bytes the user manually fixed in the UI's
    /// temp buffer. When `Some`, replaces the primary file's install-side
    /// bytes and skips parse validation (caller has done it).
    pub fixed_primary_bytes: Option<Vec<u8>>,
}

/// Outcome of a reimport call. Each non-`Reimported` variant is an
/// actionable state for the UI to route on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReimportResult {
    /// Snapshot wrote successfully; `current.txt` and `installs.json` are
    /// updated.
    Reimported { new_version: VersionLabel },
    /// `working/` diverges from the current pinned version. UI shows the
    /// hard-block modal; user picks discard → retry with
    /// `discard_working = true`.
    WorkingCopyDirty,
    /// Primary file's frontmatter/TOML didn't parse. UI shows broken-source
    /// sheet; user fixes; retry with `fixed_primary_bytes`.
    BrokenSource {
        primary_path: String,
        raw_bytes: Vec<u8>,
        parse_error: String,
    },
    /// No record exists for `(kind, name, source_target)`.
    NotInstalled,
    /// Recorded install path is gone from disk; nothing to import.
    InstallMissing,
}

pub fn reimport_install_as_version(
    req: ReimportRequest<'_>,
) -> Result<ReimportResult, Error> {
    // 1. Look up the install record.
    let installs = InstallsFile::load(req.installs_file_path)?;
    let record = match installs.get(req.kind, req.name, req.source_target) {
        Some(r) => r.clone(),
        None => return Ok(ReimportResult::NotInstalled),
    };

    let layout = record.layout();
    let single_file = matches!(layout, InstallLayout::SingleFile);
    let install_dest = record
        .kind_target()
        .path_for(req.install_paths, req.name, layout);
    if !install_dest.exists() {
        return Ok(ReimportResult::InstallMissing);
    }

    // 2. Working-copy dirty check.
    if !req.discard_working
        && working_diverges_from_current(req.layout, req.kind, req.name)?
    {
        return Ok(ReimportResult::WorkingCopyDirty);
    }

    // 3. Read install bytes (and apply user-fixed primary on retry).
    let mut install_bytes = read_install_tree(&install_dest, single_file)?;
    let primary_install_key: Utf8PathBuf = if single_file {
        Utf8PathBuf::new()
    } else {
        Utf8PathBuf::from(req.kind.primary_filename(req.name))
    };

    if let Some(fixed) = req.fixed_primary_bytes {
        install_bytes.insert(primary_install_key.clone(), fixed);
    }
    let primary_bytes = install_bytes.get(&primary_install_key).ok_or_else(|| {
        Error::MaterializeShape(format!(
            "primary file `{primary_install_key}` not found at install dest {install_dest}"
        ))
    })?;
    if let Err(parse_err) = validate_primary_parse(req.kind, primary_bytes) {
        return Ok(ReimportResult::BrokenSource {
            primary_path: primary_install_key.to_string(),
            raw_bytes: primary_bytes.clone(),
            parse_error: parse_err.to_string(),
        });
    }

    // 4. Map install relpaths → library relpaths. The (Agent, Claude)
    //    flatten rule reverses here: the single-file install at `<name>.md`
    //    lands in the library as `agent.md`. Multi-file installs are
    //    identity-mapped.
    let library_bytes = map_install_to_library(req.kind, req.name, single_file, install_bytes);

    // 5. Read metadata to decide base-vs-overlay write target.
    let metadata_path = req.layout.primitive_metadata(req.kind, req.name);
    let metadata_raw = fs::read_to_string(&metadata_path).map_err(|source| Error::Io {
        path: metadata_path.to_string(),
        source,
    })?;
    let metadata = PrimitiveMetadata::from_yaml(&metadata_raw)?;
    let single_target_primitive = metadata.allowed_targets.len() == 1
        && metadata.allowed_targets[0] == req.source_target;

    // 6. If discarding, reset working/ to current version first. This keeps
    //    other-target overlays (which are part of the published version)
    //    intact and only blows away genuinely-unpublished edits.
    if req.discard_working {
        let store = VersionStore::new(req.layout);
        if let Some(current_label) = store.read_current(req.kind, req.name)? {
            revert_primitive_to_version(req.layout, req.kind, req.name, &current_label)?;
        }
    }

    // 7. Apply imported bytes. Pre-wipe stale files in the destination
    //    bucket so removed files don't ride along into the snapshot.
    let wc = WorkingCopy::new(req.layout);
    let existing = wc.load(req.kind, req.name)?;
    if single_target_primitive {
        for rel in existing.base.keys() {
            if !library_bytes.contains_key(rel) {
                wc.remove_base_file(req.kind, req.name, rel)?;
            }
        }
        for (rel, bytes) in &library_bytes {
            wc.save_base_file(req.kind, req.name, rel, bytes)?;
        }
    } else {
        if let Some(target_files) = existing.targets.get(&req.source_target) {
            for rel in target_files.keys() {
                if !library_bytes.contains_key(rel) {
                    wc.remove_target_file(req.kind, req.name, req.source_target, rel)?;
                }
            }
        }
        for (rel, bytes) in &library_bytes {
            wc.save_target_file(req.kind, req.name, req.source_target, rel, bytes)?;
        }
    }

    // 8. Snapshot the new version (also bumps current.txt).
    let store = VersionStore::new(req.layout);
    store.snapshot(
        req.kind,
        req.name,
        &req.new_version,
        &VersionMetadata {
            created_at: req.created_at.into(),
            notes: req.notes,
        },
    )?;

    // 9. Re-baseline installs.json: bump installed_version, capture current
    //    on-disk hashes/mtimes so the next drift scan reads Clean.
    let mut installs = InstallsFile::load(req.installs_file_path)?;
    let (post_hashes, post_mtimes) = collect_disk_state(&install_dest, single_file)
        .map_err(|(path, source)| Error::Io {
            path: path.to_string(),
            source,
        })?;
    installs.upsert(InstallRecord {
        kind: req.kind,
        name: req.name.clone(),
        target: req.source_target,
        installed_version: req.new_version.clone(),
        file_hashes: post_hashes.clone(),
        last_known_install_hashes: post_hashes,
        mtimes: post_mtimes,
        installed_at: record.installed_at,
    });
    installs.save(req.installs_file_path)?;

    Ok(ReimportResult::Reimported {
        new_version: req.new_version,
    })
}

/// Read every file under the install destination, keyed by install-relative
/// path. Single-file installs return one entry under the empty key; directory
/// installs return one entry per file (filtering ignored files).
fn read_install_tree(
    dest: &Utf8Path,
    single_file: bool,
) -> Result<std::collections::HashMap<Utf8PathBuf, Vec<u8>>, Error> {
    let mut out = std::collections::HashMap::new();
    if single_file {
        let bytes = fs::read(dest.as_std_path()).map_err(|source| Error::Io {
            path: dest.to_string(),
            source,
        })?;
        out.insert(Utf8PathBuf::new(), bytes);
    } else {
        walk_into(dest, dest, &mut out)?;
    }
    Ok(out)
}

fn map_install_to_library(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    single_file: bool,
    install_bytes: std::collections::HashMap<Utf8PathBuf, Vec<u8>>,
) -> std::collections::HashMap<Utf8PathBuf, Vec<u8>> {
    if single_file {
        // Inverse of materializer flatten: the single install file lives at
        // the library's primary_filename for this kind. For (Agent, Claude)
        // flat that's `agent.md` (vs install side's `<name>.md`); for
        // Command/CodexAgent the names already match.
        let library_primary = Utf8PathBuf::from(kind.primary_filename(name));
        let bytes = install_bytes
            .into_iter()
            .next()
            .map(|(_, v)| v)
            .unwrap_or_default();
        let mut out = std::collections::HashMap::new();
        out.insert(library_primary, bytes);
        out
    } else {
        // Multi-file installs map identity: the install layout matches the
        // library's working tree.
        install_bytes
    }
}

fn validate_primary_parse(kind: PrimitiveKind, bytes: &[u8]) -> Result<(), Error> {
    if kind.is_md_kind() {
        MdPrimitive::parse(bytes).map(|_| ())
    } else {
        CodexAgentFile::parse(bytes).map(|_| ())
    }
}

/// True if `working/` ≠ the bytes of the current pinned version. With no
/// current version pinned, an empty working/ counts as clean and anything
/// else as dirty.
fn working_diverges_from_current(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<bool, Error> {
    let working = WorkingCopy::new(layout).load(kind, name)?;
    let store = VersionStore::new(layout);
    match store.read_current(kind, name)? {
        Some(label) => {
            let current = store.read_version(kind, name, &label)?;
            Ok(working != current)
        }
        None => Ok(!working.base.is_empty() || !working.targets.is_empty()),
    }
}

type DiskState = (BTreeMap<Utf8PathBuf, String>, BTreeMap<Utf8PathBuf, i64>);
type DiskStateError = (Utf8PathBuf, std::io::Error);

fn collect_disk_state(
    dest: &Utf8Path,
    single_file: bool,
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
        let files = walk_files(dest, dest)?;
        for rel in files {
            let path = dest.join(&rel);
            let bytes = fs::read(path.as_std_path()).map_err(|e| (path.clone(), e))?;
            hashes.insert(rel.clone(), blake3::hash(&bytes).to_hex().to_string());
            mtimes.insert(rel, mtime_of(&path)?);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drift::{scan_drift_for_primitive, DriftStatus};
    use crate::installer::{install, InstallRequest};
    use crate::scaffold::{scaffold_primitive, scaffold_skill};
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

        fn layout(&self) -> LibraryLayout<'_> {
            LibraryLayout::new(&self.lib_root)
        }

        fn install_paths(&self) -> InstallPaths {
            InstallPaths::new(&self.home)
        }
    }

    fn n(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn label(s: &str) -> VersionLabel {
        VersionLabel::try_new(s).unwrap()
    }

    /// Scaffold + publish v1 + install for a Skill with the given allowed
    /// targets. Returns the primitive name. The skill's working copy is
    /// clean and matches v1.
    fn published_and_installed_skill(
        fx: &Fixture,
        allowed: Vec<Target>,
        body: &[u8],
    ) -> PrimitiveName {
        let name = n("diagnose");
        scaffold_skill(fx.layout(), &name, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            body,
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Skill,
            &name,
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
                &name,
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
            name: &name,
            targets: &allowed,
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();
        name
    }

    fn req<'a>(
        fx: &'a Fixture,
        ip: &'a InstallPaths,
        kind: PrimitiveKind,
        name: &'a PrimitiveName,
        source: Target,
        new_v: &str,
    ) -> ReimportRequest<'a> {
        ReimportRequest {
            layout: fx.layout(),
            install_paths: ip,
            installs_file_path: &fx.installs_path,
            kind,
            name,
            source_target: source,
            new_version: label(new_v),
            created_at: "2026-05-04T01:00:00Z",
            notes: Some("captured manual edit".into()),
            discard_working: false,
            fixed_primary_bytes: None,
        }
    }

    #[test]
    fn reimport_with_no_record_returns_not_installed() {
        let fx = Fixture::new();
        let name = n("never-installed");
        scaffold_skill(fx.layout(), &name, "2026-05-04T00:00:00Z").unwrap();
        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v1",
        ))
        .unwrap();
        assert_eq!(result, ReimportResult::NotInstalled);
    }

    #[test]
    fn reimport_clean_skill_publishes_new_version_and_clears_drift() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        let installed = fx.home.join(".claude/skills/diagnose/SKILL.md");
        // Drift the install out-of-band.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(installed.as_std_path(), b"---\n---\nuser-edit\n").unwrap();

        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        match result {
            ReimportResult::Reimported { new_version } => {
                assert_eq!(new_version.as_str(), "v2");
            }
            other => panic!("expected Reimported, got {other:?}"),
        }

        // current.txt → v2
        let store = VersionStore::new(fx.layout());
        let current = store.read_current(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(current.unwrap().as_str(), "v2");

        // v2 captured the user's edit at base (single-target → base).
        let v2 = store
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        assert_eq!(
            v2.base[Utf8Path::new("SKILL.md")],
            b"---\n---\nuser-edit\n",
        );
        // No overlay was created (single-allowed-target → write to base).
        assert!(v2.targets.is_empty());

        // Drift returns Clean.
        let reports = scan_drift_for_primitive(
            &ip,
            &fx.installs_path,
            PrimitiveKind::Skill,
            &name,
        )
        .unwrap();
        assert_eq!(reports[0].status, DriftStatus::Clean);

        // installs.json record now points to v2.
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        let r = installs
            .get(PrimitiveKind::Skill, &name, Target::Claude)
            .unwrap();
        assert_eq!(r.installed_version.as_str(), "v2");
    }

    #[test]
    fn reimport_returns_dirty_when_working_diverges_from_current() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");

        // User edits working/ AND the install.
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nunpublished-edit\n",
        )
        .unwrap();
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"---\n---\ninstall-edit\n",
        )
        .unwrap();

        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        assert_eq!(result, ReimportResult::WorkingCopyDirty);

        // No new version was published; current.txt still v1.
        let store = VersionStore::new(fx.layout());
        let current = store.read_current(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(current.unwrap().as_str(), "v1");
        // Working copy edits remain (we didn't touch them).
        let working = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(
            working.base[Utf8Path::new("SKILL.md")],
            b"---\n---\nunpublished-edit\n",
        );
    }

    #[test]
    fn reimport_with_discard_replays_install_over_reverted_working() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nunpublished-edit\n",
        )
        .unwrap();
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"---\n---\ninstall-edit\n",
        )
        .unwrap();

        let ip = fx.install_paths();
        let mut request = req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        );
        request.discard_working = true;
        let result = reimport_install_as_version(request).unwrap();
        assert!(matches!(result, ReimportResult::Reimported { .. }));

        // v2 captured the install bytes, NOT the unpublished working edit.
        let store = VersionStore::new(fx.layout());
        let v2 = store
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        assert_eq!(
            v2.base[Utf8Path::new("SKILL.md")],
            b"---\n---\ninstall-edit\n",
        );
    }

    #[test]
    fn reimport_with_broken_frontmatter_returns_broken_source() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"no frontmatter at all here just text",
        )
        .unwrap();

        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        match result {
            ReimportResult::BrokenSource {
                primary_path,
                raw_bytes,
                parse_error,
            } => {
                // For multi-file Skill installs, primary_path is "SKILL.md".
                assert_eq!(primary_path, "SKILL.md");
                assert_eq!(raw_bytes, b"no frontmatter at all here just text");
                assert!(!parse_error.is_empty());
            }
            other => panic!("expected BrokenSource, got {other:?}"),
        }

        // No new version was published.
        let store = VersionStore::new(fx.layout());
        let versions = store
            .list_versions(PrimitiveKind::Skill, &name)
            .unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].as_str(), "v1");
    }

    #[test]
    fn reimport_with_fixed_primary_bytes_publishes_those_bytes() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        // Install contents are broken on disk:
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"broken bytes",
        )
        .unwrap();

        let ip = fx.install_paths();
        let mut request = req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        );
        // User fixed the bytes in the UI temp buffer.
        request.fixed_primary_bytes = Some(b"---\n---\nfixed body\n".to_vec());
        let result = reimport_install_as_version(request).unwrap();
        assert!(matches!(result, ReimportResult::Reimported { .. }));

        let store = VersionStore::new(fx.layout());
        let v2 = store
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        assert_eq!(
            v2.base[Utf8Path::new("SKILL.md")],
            b"---\n---\nfixed body\n",
        );
    }

    #[test]
    fn reimport_with_invalid_fixed_primary_bytes_stays_in_broken_source() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"broken bytes",
        )
        .unwrap();

        let ip = fx.install_paths();
        let mut request = req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        );
        request.fixed_primary_bytes = Some(b"still broken".to_vec());
        let result = reimport_install_as_version(request).unwrap();

        match result {
            ReimportResult::BrokenSource {
                raw_bytes,
                parse_error,
                ..
            } => {
                assert_eq!(raw_bytes, b"still broken");
                assert!(!parse_error.is_empty());
            }
            other => panic!("expected BrokenSource, got {other:?}"),
        }
    }

    #[test]
    fn reimport_for_multi_target_writes_to_overlay_not_base() {
        let fx = Fixture::new();
        let name = published_and_installed_skill(
            &fx,
            vec![Target::Claude, Target::Pi],
            b"---\n---\nshared body\n",
        );
        // Edit only the Claude install.
        std::fs::write(
            fx.home
                .join(".claude/skills/diagnose/SKILL.md")
                .as_std_path(),
            b"---\n---\nclaude-specific\n",
        )
        .unwrap();

        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        assert!(matches!(result, ReimportResult::Reimported { .. }));

        let store = VersionStore::new(fx.layout());
        let v2 = store
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        // Base preserved; Claude overlay has the imported bytes.
        assert_eq!(
            v2.base[Utf8Path::new("SKILL.md")],
            b"---\n---\nshared body\n",
        );
        assert_eq!(
            v2.targets[&Target::Claude][Utf8Path::new("SKILL.md")],
            b"---\n---\nclaude-specific\n",
        );
        // Pi has no overlay; falls back to base.
        assert!(!v2.targets.contains_key(&Target::Pi));
    }

    #[test]
    fn reimport_for_agent_claude_flat_inverts_filename() {
        let fx = Fixture::new();
        let name = n("helper");
        scaffold_primitive(
            fx.layout(),
            PrimitiveKind::Agent,
            &name,
            "2026-05-04T00:00:00Z",
            None,
        )
        .unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Agent,
            &name,
            Utf8Path::new("agent.md"),
            b"---\n---\nv1 body\n",
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Agent,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let store = VersionStore::new(fx.layout());
        store
            .snapshot(
                PrimitiveKind::Agent,
                &name,
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
            kind: PrimitiveKind::Agent,
            name: &name,
            targets: &[Target::Claude],
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();
        // Single-file flat install at ~/.claude/agents/helper.md
        let installed = fx.home.join(".claude/agents/helper.md");
        assert!(installed.exists());
        std::fs::write(installed.as_std_path(), b"---\n---\nclaude flatten edit\n").unwrap();

        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Agent,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        assert!(matches!(result, ReimportResult::Reimported { .. }));

        // v2 stores under `agent.md` even though install side was `helper.md`.
        let v2 = store
            .read_version(PrimitiveKind::Agent, &name, &label("v2"))
            .unwrap();
        assert_eq!(
            v2.base[Utf8Path::new("agent.md")],
            b"---\n---\nclaude flatten edit\n",
        );
    }

    #[test]
    fn reimport_returns_install_missing_when_path_gone() {
        let fx = Fixture::new();
        let name =
            published_and_installed_skill(&fx, vec![Target::Claude], b"---\n---\nbody-v1\n");
        std::fs::remove_dir_all(
            fx.home.join(".claude/skills/diagnose").as_std_path(),
        )
        .unwrap();
        let ip = fx.install_paths();
        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        assert_eq!(result, ReimportResult::InstallMissing);
    }

    #[test]
    fn reimport_pre_wipes_base_files_no_longer_present_on_disk() {
        // Skill with notes.md alongside SKILL.md. User deletes notes.md from
        // the install. Reimport must drop notes.md from base too.
        let fx = Fixture::new();
        let name = n("diagnose");
        scaffold_skill(fx.layout(), &name, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody-v1\n",
        )
        .unwrap();
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("notes.md"),
            b"side notes\n",
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
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
                &name,
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
            name: &name,
            targets: &[Target::Claude],
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();

        // User deletes notes.md from the install dir.
        std::fs::remove_file(
            fx.home
                .join(".claude/skills/diagnose/notes.md")
                .as_std_path(),
        )
        .unwrap();

        let result = reimport_install_as_version(req(
            &fx,
            &ip,
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            "v2",
        ))
        .unwrap();
        assert!(matches!(result, ReimportResult::Reimported { .. }));

        let v2 = store
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        assert!(v2.base.contains_key(Utf8Path::new("SKILL.md")));
        assert!(
            !v2.base.contains_key(Utf8Path::new("notes.md")),
            "notes.md must be dropped from base when the install no longer has it"
        );
    }
}
