use camino::Utf8Path;
use serde::{Deserialize, Serialize};

use crate::fs_helpers::atomic_write;
use crate::ignored::is_ignored;
use crate::{Error, LibraryLayout};

/// Format version embedded in `.prompt-library`. Bump only on breaking
/// on-disk layout changes.
pub const LIBRARY_FORMAT_VERSION: u32 = 1;

const GITIGNORE_TEMPLATE: &str = "# prompt-library\n*/working/\n.DS_Store\nbackups/\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LibraryMarker {
    format_version: u32,
    created_at: String,
}

/// Initialize a library at `root`.
///
/// - Missing dir → creates it, writes `.gitignore` + `.prompt-library`.
/// - Empty dir → writes `.gitignore` + `.prompt-library`.
/// - Already a library (marker exists) → no-op (idempotent).
/// - Non-empty, no marker → `Err(NotALibrary)`.
///
/// `now_rfc3339` is injected so callers (and tests) control the timestamp.
pub fn init_library(root: &Utf8Path, now_rfc3339: &str) -> Result<(), Error> {
    let layout = LibraryLayout::new(root);
    let marker_path = layout.library_marker();

    if marker_path.exists() {
        return Ok(());
    }

    if root.exists() && !dir_is_effectively_empty(root)? {
        return Err(Error::NotALibrary {
            path: root.to_string(),
        });
    }

    let marker = LibraryMarker {
        format_version: LIBRARY_FORMAT_VERSION,
        created_at: now_rfc3339.to_string(),
    };
    let body = serde_json::to_vec_pretty(&marker)
        .expect("LibraryMarker is plain Serialize; cannot fail");
    atomic_write(&marker_path, &body)?;
    atomic_write(&layout.gitignore(), GITIGNORE_TEMPLATE.as_bytes())?;
    Ok(())
}

/// Empty after filtering ignored noise (`.DS_Store`, etc.).
fn dir_is_effectively_empty(root: &Utf8Path) -> Result<bool, Error> {
    let read_dir = std::fs::read_dir(root).map_err(|source| Error::Io {
        path: root.to_string(),
        source,
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|source| Error::Io {
            path: root.to_string(),
            source,
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_ignored(Utf8Path::new(name.as_ref())) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
    }

    #[test]
    fn empty_dir_gets_marker_and_gitignore() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        init_library(&root, "2026-05-04T00:00:00Z").unwrap();
        assert!(root.join(".prompt-library").exists());
        assert!(root.join(".gitignore").exists());
    }

    #[test]
    fn non_empty_dir_without_marker_errors() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        std::fs::write(root.join("readme.txt"), b"i am not a library").unwrap();
        let err = init_library(&root, "2026-05-04T00:00:00Z").unwrap_err();
        assert!(
            matches!(err, Error::NotALibrary { ref path } if path == root.as_str()),
            "expected NotALibrary, got: {err:?}"
        );
        assert!(!root.join(".prompt-library").exists(), "must not write marker");
        assert!(!root.join(".gitignore").exists(), "must not write gitignore");
    }

    #[test]
    fn missing_dir_is_created_and_initialized() {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().join("new-library")).unwrap();
        assert!(!root.exists());
        init_library(&root, "2026-05-04T00:00:00Z").unwrap();
        assert!(root.join(".prompt-library").exists());
        assert!(root.join(".gitignore").exists());
    }

    #[test]
    fn gitignore_includes_backups_dir() {
        // P5.3 defensive: even though source-backup tarballs live outside
        // the library, ignoring `backups/` here protects against a
        // misconfigured backup_dir landing inside the library.
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        init_library(&root, "2026-05-05T00:00:00Z").unwrap();
        let raw = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(raw.lines().any(|l| l.trim() == "backups/"), "got: {raw}");
    }

    #[test]
    fn marker_contents_include_format_version_and_created_at() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        init_library(&root, "2026-05-04T12:34:56Z").unwrap();
        let raw = std::fs::read_to_string(root.join(".prompt-library")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["format_version"], 1);
        assert_eq!(v["created_at"], "2026-05-04T12:34:56Z");
    }

    #[test]
    fn re_init_is_idempotent_and_preserves_original_marker() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        init_library(&root, "2026-05-04T00:00:00Z").unwrap();
        let original = std::fs::read(root.join(".prompt-library")).unwrap();
        // Re-init with a different timestamp should not rewrite.
        init_library(&root, "2099-12-31T23:59:59Z").unwrap();
        let after = std::fs::read(root.join(".prompt-library")).unwrap();
        assert_eq!(original, after, "marker must be untouched on re-init");
    }
}
