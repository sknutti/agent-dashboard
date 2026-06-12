//! Reference-file helpers for `working/base/`.
//!
//! Ref files are arbitrary additional files a primitive's bundle ships
//! alongside its primary file (`SKILL.md`, `agent.md`, etc.). The
//! materializer and installer already pass them through; this module is the
//! single source of truth for the *path validation rules* and *bundle listing*
//! that the editor UI needs.

use std::fs;
use std::io::Read;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveName};

/// One entry in a primitive's working-bundle file list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorkingFileEntry {
    /// Path relative to `working/base/`.
    pub path: String,
    pub role: WorkingFileRole,
    /// True if the file's first 8 KiB contains no NUL bytes (the same
    /// heuristic git uses for "is this text").
    pub is_text: bool,
    /// File size in bytes, saturating at `u32::MAX` for files ≥ 4 GiB
    /// (specta forbids `u64` over the IPC boundary, and a 4 GiB ref file
    /// in a primitive bundle is well outside the editor's design envelope).
    pub size_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkingFileRole {
    Primary,
    Ref,
}

/// Bytes returned by [`read_working_file`]. Binary files surface their size
/// only — the caller should route to a non-editor placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkingFileBytes {
    Text {
        text: String,
        /// Lowercased file extension without the dot (e.g. `"md"`); `None` if
        /// the path has no extension.
        ext: Option<String>,
    },
    Binary {
        /// Size in bytes, saturating at `u32::MAX`.
        size: u32,
    },
}

/// Read a single working-bundle file. Validates the relpath via
/// [`validate_path_shape`] (the primary file is a legal read target).
/// Returns [`WorkingFileBytes::Binary`] with size for non-text files so
/// callers can render a placeholder without spending memory on potentially
/// large blobs.
pub fn read_working_file(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    rel: &Utf8Path,
) -> Result<WorkingFileBytes, Error> {
    validate_path_shape(rel)?;
    let abs = layout.working_base(kind, name).join(rel);
    let meta = fs::symlink_metadata(abs.as_std_path()).map_err(|source| Error::Io {
        path: abs.to_string(),
        source,
    })?;
    if !sniff_is_text(&abs)? {
        return Ok(WorkingFileBytes::Binary {
            size: meta.len().min(u32::MAX as u64) as u32,
        });
    }
    let bytes = fs::read(abs.as_std_path()).map_err(|source| Error::Io {
        path: abs.to_string(),
        source,
    })?;
    let text = String::from_utf8(bytes).map_err(|e| Error::NotUtf8(e.utf8_error()))?;
    let ext = rel.extension().map(|s| s.to_ascii_lowercase());
    Ok(WorkingFileBytes::Text { text, ext })
}

/// Create a new ref file at `rel` under `working/base/`. Validates via
/// [`validate_ref_path`] and refuses to clobber an existing file.
pub fn create_working_file(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    rel: &Utf8Path,
    content: &str,
) -> Result<(), Error> {
    validate_ref_path(rel, kind, name)?;
    let dest = layout.working_base(kind, name).join(rel);
    if dest.exists() {
        return Err(Error::WorkingFileAlreadyExists {
            path: rel.as_str().into(),
        });
    }
    crate::WorkingCopy::new(layout).save_base_file(kind, name, rel, content.as_bytes())
}

/// Update the contents of an existing ref file at `rel`. Errors if the file
/// doesn't exist (callers must use [`create_working_file`] for that).
pub fn save_working_file(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    rel: &Utf8Path,
    content: &str,
) -> Result<(), Error> {
    validate_ref_path(rel, kind, name)?;
    let dest = layout.working_base(kind, name).join(rel);
    if !dest.exists() {
        return Err(Error::WorkingFileNotFound {
            path: rel.as_str().into(),
        });
    }
    crate::WorkingCopy::new(layout).save_base_file(kind, name, rel, content.as_bytes())
}

/// Rename or move an existing ref file from `old_rel` to `new_rel` inside
/// `working/base/`. Refuses to rename the primary file (route through the
/// existing rename-primitive flow instead). Errors if the source is missing
/// or the destination already exists.
pub fn rename_working_file(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    old_rel: &Utf8Path,
    new_rel: &Utf8Path,
) -> Result<(), Error> {
    validate_path_shape(old_rel)?;
    if is_primary_filename(old_rel, kind, name) {
        return Err(Error::RefuseRenamePrimary {
            path: old_rel.as_str().into(),
        });
    }
    validate_ref_path(new_rel, kind, name)?;
    let base = layout.working_base(kind, name);
    let from = base.join(old_rel);
    let to = base.join(new_rel);
    if !from.exists() {
        return Err(Error::WorkingFileNotFound {
            path: old_rel.as_str().into(),
        });
    }
    if to.exists() {
        return Err(Error::WorkingFileAlreadyExists {
            path: new_rel.as_str().into(),
        });
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent.as_std_path()).map_err(|source| Error::Io {
            path: parent.to_string(),
            source,
        })?;
    }
    fs::rename(from.as_std_path(), to.as_std_path()).map_err(|source| Error::Io {
        path: from.to_string(),
        source,
    })?;
    Ok(())
}

/// Delete a ref file under `working/base/`. Idempotent on missing files.
/// Refuses to delete the primary file (route through the existing
/// delete-primitive flow instead).
pub fn delete_working_file(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    rel: &Utf8Path,
) -> Result<(), Error> {
    validate_path_shape(rel)?;
    if is_primary_filename(rel, kind, name) {
        return Err(Error::RefuseDeletePrimary {
            path: rel.as_str().into(),
        });
    }
    crate::WorkingCopy::new(layout).remove_base_file(kind, name, rel)
}

/// List every file under a primitive's `working/base/`.
///
/// The primary file appears first; other entries follow in alphabetical path
/// order. `working/targets/<target>/` is **not** enumerated — primary-file
/// overlays remain on the existing `read_target` / `WorkingCopy` flow.
pub fn list_working_files(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<Vec<WorkingFileEntry>, Error> {
    let base_dir = layout.working_base(kind, name);
    if !base_dir.exists() {
        return Ok(Vec::new());
    }
    let primary = kind.primary_filename(name);
    let mut entries: Vec<WorkingFileEntry> = Vec::new();
    walk_collect(&base_dir, &base_dir, &primary, &mut entries)?;
    if entries.len() > MAX_WORKING_FILES {
        return Err(Error::TooManyWorkingFiles {
            count: entries.len() as u32,
            limit: MAX_WORKING_FILES as u32,
        });
    }
    entries.sort_by(|a, b| match (a.role, b.role) {
        (WorkingFileRole::Primary, WorkingFileRole::Primary) => a.path.cmp(&b.path),
        (WorkingFileRole::Primary, _) => std::cmp::Ordering::Less,
        (_, WorkingFileRole::Primary) => std::cmp::Ordering::Greater,
        _ => a.path.cmp(&b.path),
    });
    Ok(entries)
}

fn walk_collect(
    root: &Utf8Path,
    cur: &Utf8Path,
    primary: &str,
    out: &mut Vec<WorkingFileEntry>,
) -> Result<(), Error> {
    let read = fs::read_dir(cur.as_std_path()).map_err(|source| Error::Io {
        path: cur.to_string(),
        source,
    })?;
    for entry in read {
        let entry = entry.map_err(|source| Error::Io {
            path: cur.to_string(),
            source,
        })?;
        let abs = match Utf8PathBuf::from_path_buf(entry.path()) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let rel = abs.strip_prefix(root).expect("walked under root").to_owned();
        if crate::is_ignored(&rel) {
            continue;
        }
        let lmeta = fs::symlink_metadata(abs.as_std_path()).map_err(|source| Error::Io {
            path: abs.to_string(),
            source,
        })?;
        if lmeta.file_type().is_symlink() {
            continue;
        }
        if lmeta.is_dir() {
            walk_collect(root, &abs, primary, out)?;
            continue;
        }
        if !lmeta.is_file() {
            continue;
        }
        let path_str = rel.as_str().to_owned();
        let role = if path_str == primary {
            WorkingFileRole::Primary
        } else {
            WorkingFileRole::Ref
        };
        let size_bytes = lmeta.len().min(u32::MAX as u64) as u32;
        let is_text = sniff_is_text(&abs)?;
        out.push(WorkingFileEntry {
            path: path_str,
            role,
            is_text,
            size_bytes,
        });
    }
    Ok(())
}

/// Read up to the first 8 KiB and return true if no NUL byte appears — git's
/// "is this text" heuristic.
fn sniff_is_text(abs: &Utf8Path) -> Result<bool, Error> {
    let mut f = fs::File::open(abs.as_std_path()).map_err(|source| Error::Io {
        path: abs.to_string(),
        source,
    })?;
    let mut buf = [0u8; 8 * 1024];
    let n = f.read(&mut buf).map_err(|source| Error::Io {
        path: abs.to_string(),
        source,
    })?;
    Ok(!buf[..n].contains(&0u8))
}

/// Validate the *shape* of a relative path used anywhere under `working/`.
/// Used by `WorkingCopy::save_base_file`/`save_target_file` (which must accept
/// the primary filename) and by [`validate_ref_path`] (which builds on top).
pub fn validate_path_shape(rel: &Utf8Path) -> Result<(), Error> {
    let raw = rel.as_str();
    if raw.is_empty() {
        return Err(Error::InvalidWorkingPath(raw.into()));
    }
    if raw.contains('\0') {
        return Err(Error::InvalidWorkingPath(raw.into()));
    }
    if rel.is_absolute() {
        return Err(Error::InvalidWorkingPath(raw.into()));
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(Error::InvalidWorkingPath(raw.into()));
    }
    let mut count: usize = 0;
    for component in rel.components() {
        let segment = component.as_str();
        match segment {
            "." | ".." => return Err(Error::InvalidWorkingPath(raw.into())),
            _ => {}
        }
        if crate::is_ignored(Utf8Path::new(segment)) {
            return Err(Error::InvalidWorkingPath(raw.into()));
        }
        count += 1;
    }
    if count > MAX_COMPONENTS {
        return Err(Error::InvalidWorkingPath(raw.into()));
    }
    Ok(())
}

/// Validate a relative path before it's used as a *reference-file* location
/// under `working/base/`. Stricter than [`validate_path_shape`]: also rejects
/// the kind's primary filename, since primary edits must route through
/// `save_primary_base`.
pub fn validate_ref_path(
    rel: &Utf8Path,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<(), Error> {
    validate_path_shape(rel)?;
    if is_primary_filename(rel, kind, name) {
        return Err(Error::InvalidWorkingPath(rel.as_str().into()));
    }
    Ok(())
}

/// True if `rel` names the kind's primary file. Compared case-INSENSITIVELY: on
/// a case-insensitive filesystem (macOS APFS default, Windows) `skill.md` and
/// `SKILL.md` resolve to the same inode, so an exact-case guard would let a
/// ref-file command (`create`/`save`/`rename`/`delete`) clobber the primary —
/// bypassing the parse-validation `save_primary_base` enforces, landing
/// unparseable bytes on `SKILL.md`. Primary filenames are ASCII (`SKILL.md`,
/// `agent.md`, `<name>.md`/`.toml`, and `PrimitiveName` is `[A-Za-z0-9._-]`), so
/// ASCII case-folding fully covers them.
fn is_primary_filename(rel: &Utf8Path, kind: PrimitiveKind, name: &PrimitiveName) -> bool {
    rel.as_str()
        .eq_ignore_ascii_case(&kind.primary_filename(name))
}

const MAX_COMPONENTS: usize = 8;
const MAX_PATH_BYTES: usize = 200;
const MAX_WORKING_FILES: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkingCopy;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn setup() -> (TempDir, Utf8PathBuf, PrimitiveName) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        (tmp, root, name("diagnose"))
    }

    #[test]
    fn accepts_simple_ref_filename() {
        let n = name("diagnose");
        validate_ref_path(Utf8Path::new("notes.md"), PrimitiveKind::Skill, &n).unwrap();
    }

    #[test]
    fn rejects_empty_path() {
        let n = name("diagnose");
        let err = validate_ref_path(Utf8Path::new(""), PrimitiveKind::Skill, &n).unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_parent_traversal_anywhere_in_path() {
        let n = name("diagnose");
        for raw in ["..", "../escape.md", "notes/../escape.md"] {
            let err = validate_ref_path(Utf8Path::new(raw), PrimitiveKind::Skill, &n)
                .unwrap_err();
            assert!(
                matches!(err, Error::InvalidWorkingPath(_)),
                "expected reject for `{raw}`",
            );
        }
    }

    #[test]
    fn rejects_absolute_path() {
        let n = name("diagnose");
        let err = validate_ref_path(Utf8Path::new("/etc/passwd"), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_dot_prefix() {
        let n = name("diagnose");
        let err = validate_ref_path(Utf8Path::new("./notes.md"), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_path_with_nul_byte() {
        let n = name("diagnose");
        let err = validate_ref_path(Utf8Path::new("notes\0.md"), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_ignored_segment() {
        // `is_ignored` matches `.DS_Store`, `._foo`, `*~`, `*.swp`, `.git`.
        let n = name("diagnose");
        for raw in [
            ".DS_Store",
            "subdir/.DS_Store",
            "._hidden",
            "notes.md~",
            ".git/config",
        ] {
            let err = validate_ref_path(Utf8Path::new(raw), PrimitiveKind::Skill, &n)
                .unwrap_err();
            assert!(
                matches!(err, Error::InvalidWorkingPath(_)),
                "expected reject for `{raw}`",
            );
        }
    }

    #[test]
    fn rejects_too_many_components() {
        // 9 components exceeds the cap of 8.
        let n = name("diagnose");
        let raw = "a/b/c/d/e/f/g/h/i.md";
        let err = validate_ref_path(Utf8Path::new(raw), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_path_longer_than_200_bytes() {
        let n = name("diagnose");
        let long = format!("{}.md", "a".repeat(250));
        let err = validate_ref_path(Utf8Path::new(&long), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_kind_primary_filename() {
        // Skill's primary file is SKILL.md; that path must route through
        // `save_primary_base`, not the ref-file API.
        let n = name("diagnose");
        let err = validate_ref_path(Utf8Path::new("SKILL.md"), PrimitiveKind::Skill, &n)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));

        // Same rule across kinds — Command's primary filename is templated
        // from the primitive's name.
        let cmd_name = name("install");
        let err = validate_ref_path(
            Utf8Path::new("install.md"),
            PrimitiveKind::Command,
            &cmd_name,
        )
        .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rejects_case_variant_of_primary_filename() {
        // On a case-insensitive filesystem `skill.md` and `SKILL.md` are the same
        // file — the primary guard must reject the case variant too, or a ref
        // command could clobber the primary (bypassing parse validation).
        let n = name("diagnose");
        for raw in ["skill.md", "Skill.md", "SKILL.MD"] {
            let err = validate_ref_path(Utf8Path::new(raw), PrimitiveKind::Skill, &n)
                .unwrap_err();
            assert!(
                matches!(err, Error::InvalidWorkingPath(_)),
                "expected reject for case variant `{raw}`",
            );
        }
        // Command's primary is templated from the name (`install.md` here); a
        // case variant of THAT must also be refused.
        let cmd = name("install");
        let err = validate_ref_path(Utf8Path::new("INSTALL.md"), PrimitiveKind::Command, &cmd)
            .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn rename_and_delete_refuse_case_variant_of_primary() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        WorkingCopy::new(layout)
            .save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new("SKILL.md"), b"---\n---\nb\n")
            .unwrap();
        // rename with a case variant as the source → still refuses the primary.
        let err = rename_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("skill.md"),
            Utf8Path::new("renamed.md"),
        )
        .unwrap_err();
        assert!(matches!(err, Error::RefuseRenamePrimary { .. }));
        // delete with a case variant → refuses, and the real primary survives.
        let err = delete_working_file(layout, PrimitiveKind::Skill, &n, Utf8Path::new("skill.md"))
            .unwrap_err();
        assert!(matches!(err, Error::RefuseDeletePrimary { .. }));
        assert!(layout
            .working_base(PrimitiveKind::Skill, &n)
            .join("SKILL.md")
            .exists());
    }

    #[test]
    fn accepts_nested_ref_path() {
        let n = name("diagnose");
        validate_ref_path(
            Utf8Path::new("notes/intro.md"),
            PrimitiveKind::Skill,
            &n,
        )
        .unwrap();
    }

    #[test]
    fn list_returns_empty_when_working_dir_missing() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let files = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn list_errors_when_bundle_exceeds_file_cap() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        // 1 primary + 200 ref files = 201, just over the cap of 200.
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nx\n",
        )
        .unwrap();
        for i in 0..200 {
            let path = format!("ref-{i:03}.md");
            wc.save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new(&path), b"x")
                .unwrap();
        }
        let err = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap_err();
        match err {
            Error::TooManyWorkingFiles { count, limit } => {
                assert_eq!(count, 201);
                assert_eq!(limit, 200);
            }
            other => panic!("expected TooManyWorkingFiles, got {other:?}"),
        }
    }

    #[test]
    fn read_returns_text_with_extension() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes/intro.md"),
            b"hello\n",
        )
        .unwrap();
        let bytes = read_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes/intro.md"),
        )
        .unwrap();
        match bytes {
            WorkingFileBytes::Text { text, ext } => {
                assert_eq!(text, "hello\n");
                assert_eq!(ext.as_deref(), Some("md"));
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn create_writes_a_new_ref_file_to_working_base() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes/intro.md"),
            "hello\n",
        )
        .unwrap();
        let bytes = read_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes/intro.md"),
        )
        .unwrap();
        match bytes {
            WorkingFileBytes::Text { text, .. } => assert_eq!(text, "hello\n"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn create_errors_when_file_already_exists() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "first",
        )
        .unwrap();
        let err = create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "second",
        )
        .unwrap_err();
        match err {
            Error::WorkingFileAlreadyExists { path } => assert_eq!(path, "notes.md"),
            other => panic!("expected WorkingFileAlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn save_updates_existing_file_contents() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "v1",
        )
        .unwrap();
        save_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "v2",
        )
        .unwrap();
        let bytes = read_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
        )
        .unwrap();
        match bytes {
            WorkingFileBytes::Text { text, .. } => assert_eq!(text, "v2"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn rename_moves_file_and_creates_intermediate_dirs() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "hello",
        )
        .unwrap();
        rename_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            Utf8Path::new("docs/notes.md"),
        )
        .unwrap();
        let listed = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        let paths: Vec<_> = listed.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"docs/notes.md"), "got {paths:?}");
        assert!(!paths.contains(&"notes.md"));
    }

    #[test]
    fn rename_refuses_primary_as_source() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody\n",
        )
        .unwrap();
        let err = rename_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            Utf8Path::new("renamed.md"),
        )
        .unwrap_err();
        match err {
            Error::RefuseRenamePrimary { path } => assert_eq!(path, "SKILL.md"),
            other => panic!("expected RefuseRenamePrimary, got {other:?}"),
        }
    }

    #[test]
    fn rename_errors_when_source_missing() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let err = rename_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("missing.md"),
            Utf8Path::new("new.md"),
        )
        .unwrap_err();
        match err {
            Error::WorkingFileNotFound { path } => assert_eq!(path, "missing.md"),
            other => panic!("expected WorkingFileNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_errors_when_destination_exists() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("a.md"),
            "a",
        )
        .unwrap();
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("b.md"),
            "b",
        )
        .unwrap();
        let err = rename_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("a.md"),
            Utf8Path::new("b.md"),
        )
        .unwrap_err();
        match err {
            Error::WorkingFileAlreadyExists { path } => assert_eq!(path, "b.md"),
            other => panic!("expected WorkingFileAlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn delete_removes_a_ref_file_idempotently() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
            "x",
        )
        .unwrap();
        delete_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
        )
        .unwrap();
        // Idempotent — second delete is fine.
        delete_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("notes.md"),
        )
        .unwrap();
    }

    #[test]
    fn delete_refuses_primary() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody\n",
        )
        .unwrap();
        let err = delete_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
        )
        .unwrap_err();
        match err {
            Error::RefuseDeletePrimary { path } => assert_eq!(path, "SKILL.md"),
            other => panic!("expected RefuseDeletePrimary, got {other:?}"),
        }
        // Primary file still on disk.
        assert!(layout
            .working_base(PrimitiveKind::Skill, &n)
            .join("SKILL.md")
            .exists());
    }

    #[test]
    fn save_errors_when_file_does_not_exist() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let err = save_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("missing.md"),
            "x",
        )
        .unwrap_err();
        match err {
            Error::WorkingFileNotFound { path } => assert_eq!(path, "missing.md"),
            other => panic!("expected WorkingFileNotFound, got {other:?}"),
        }
    }

    #[test]
    fn create_rejects_primary_filename() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let err = create_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            "x",
        )
        .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn read_returns_binary_for_files_with_nul_bytes() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("logo.png"),
            &[0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02, 0x03],
        )
        .unwrap();
        let bytes = read_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("logo.png"),
        )
        .unwrap();
        match bytes {
            WorkingFileBytes::Binary { size } => assert_eq!(size, 8),
            other => panic!("expected binary, got {other:?}"),
        }
    }

    #[test]
    fn read_rejects_invalid_path() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let err = read_working_file(
            layout,
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("../escape.md"),
        )
        .unwrap_err();
        assert!(matches!(err, Error::InvalidWorkingPath(_)));
    }

    #[test]
    fn list_skips_symlinks_inside_working_base() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody\n",
        )
        .unwrap();
        // Plant a symlink directly on disk pointing somewhere outside the bundle.
        let outside = _tmp.path().join("outside.md");
        std::fs::write(&outside, b"naughty").unwrap();
        let link = layout
            .working_base(PrimitiveKind::Skill, &n)
            .join("via-link.md");
        std::os::unix::fs::symlink(&outside, link.as_std_path()).unwrap();

        let files = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["SKILL.md"], "symlink must not appear in list");
    }

    #[test]
    fn list_marks_files_with_nul_bytes_as_non_text() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody\n",
        )
        .unwrap();
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("logo.bin"),
            &[0xFFu8, 0x00, 0x01, 0x02],
        )
        .unwrap();
        let files = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        let bin = files.iter().find(|f| f.path == "logo.bin").unwrap();
        assert!(!bin.is_text);
        let prim = files.iter().find(|f| f.path == "SKILL.md").unwrap();
        assert!(prim.is_text);
    }

    #[test]
    fn list_pins_primary_first_then_alphabetic_refs() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        for (path, body) in [
            ("zebra.md", b"z" as &[u8]),
            ("SKILL.md", b"---\n---\nb\n"),
            ("apple.md", b"a"),
            ("notes/intro.md", b"n"),
        ] {
            wc.save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new(path), body)
                .unwrap();
        }
        let files = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["SKILL.md", "apple.md", "notes/intro.md", "zebra.md"]);
        assert_eq!(files[0].role, WorkingFileRole::Primary);
        for f in &files[1..] {
            assert_eq!(f.role, WorkingFileRole::Ref);
        }
    }

    #[test]
    fn list_returns_primary_when_only_primary_exists() {
        let (_tmp, root, n) = setup();
        let layout = LibraryLayout::new(&root);
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &n,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbody\n",
        )
        .unwrap();
        let files = list_working_files(layout, PrimitiveKind::Skill, &n).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "SKILL.md");
        assert_eq!(files[0].role, WorkingFileRole::Primary);
        assert!(files[0].is_text);
        assert_eq!(files[0].size_bytes, b"---\n---\nbody\n".len() as u32);
    }
}
