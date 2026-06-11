//! P5.3: Source-dir tarball backup before bootstrap.
//!
//! Snapshots the user's `~/.claude/`, `~/.pi/`, `~/.codex/` trees into a
//! gzipped tarball outside the library, mode `0600`. Returns `None` if
//! none of those roots exist (silent skip — many users only have one
//! tool installed). Skips symlinks and hidden files (`.DS_Store` etc.)
//! the same way the scanner does.
//!
//! Pure FS — caller injects the timestamp string and resolves
//! `backup_dir` (typically `<app_data_dir>/backups/`).

use std::fs::File;
use std::io::Write;

use camino::{Utf8Path, Utf8PathBuf};
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::{is_ignored, Error};

/// Source roots scanned, in stable order.
const SOURCE_ROOTS: &[&str] = &[".claude", ".pi", ".codex"];

/// Snapshot the user's source dirs into `<backup_dir>/<timestamp>.tar.gz`.
///
/// Returns the absolute archive path on success, or `Ok(None)` if none of
/// `~/.claude/`, `~/.pi/`, `~/.codex/` exist (no archive written). The
/// caller chooses `timestamp` so tests stay deterministic; production code
/// passes a filesystem-safe RFC3339-ish string.
pub fn create_source_backup(
    home: &Utf8Path,
    backup_dir: &Utf8Path,
    timestamp: &str,
) -> Result<Option<Utf8PathBuf>, Error> {
    let present: Vec<Utf8PathBuf> = SOURCE_ROOTS
        .iter()
        .map(|leaf| home.join(leaf))
        .filter(|p| p.exists())
        .collect();
    if present.is_empty() {
        return Ok(None);
    }

    std::fs::create_dir_all(backup_dir.as_std_path()).map_err(|source| Error::Io {
        path: backup_dir.to_string(),
        source,
    })?;
    let archive_path = backup_dir.join(format!("{timestamp}.tar.gz"));

    let file = File::create(archive_path.as_std_path()).map_err(|source| Error::Io {
        path: archive_path.to_string(),
        source,
    })?;
    let gz = GzEncoder::new(file, Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(false);

    for root in &present {
        append_tree(&mut tar, home, root)?;
    }

    let gz = tar.into_inner().map_err(io_err(&archive_path))?;
    let mut file = gz.finish().map_err(io_err(&archive_path))?;
    file.flush().map_err(io_err(&archive_path))?;
    drop(file);

    set_owner_only(&archive_path)?;
    Ok(Some(archive_path))
}

/// Recursively walk `dir` and append every regular non-ignored file to the
/// tar builder using a `home`-relative path. Symlinks are skipped (lstat
/// detection) — they're surfaced separately by the scanner.
fn append_tree<W: Write>(
    tar: &mut tar::Builder<W>,
    home: &Utf8Path,
    dir: &Utf8Path,
) -> Result<(), Error> {
    for entry in std::fs::read_dir(dir.as_std_path()).map_err(io_err(dir))? {
        let entry = entry.map_err(io_err(dir))?;
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
        let lmeta = std::fs::symlink_metadata(abs.as_std_path()).map_err(io_err(&abs))?;
        if lmeta.file_type().is_symlink() {
            continue;
        }
        if lmeta.is_dir() {
            append_tree(tar, home, &abs)?;
        } else {
            let rel = abs.strip_prefix(home).unwrap_or(&abs);
            tar.append_path_with_name(abs.as_std_path(), rel.as_std_path())
                .map_err(io_err(&abs))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Utf8Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path.as_std_path(), perms).map_err(io_err(path))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Utf8Path) -> Result<(), Error> {
    Ok(())
}

fn io_err(path: &Utf8Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Utf8PathBuf, Utf8PathBuf) {
        let tmp = TempDir::new().unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        let backup = Utf8PathBuf::from_path_buf(tmp.path().join("backups")).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        (tmp, home, backup)
    }

    fn write_file(home: &Utf8Path, rel: &str, bytes: &[u8]) {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap().as_std_path()).unwrap();
        std::fs::write(p.as_std_path(), bytes).unwrap();
    }

    /// Read all (relpath, bytes) entries from a .tar.gz on disk.
    fn read_archive(path: &Utf8Path) -> Vec<(String, Vec<u8>)> {
        use std::io::Read;
        let f = File::open(path.as_std_path()).unwrap();
        let gz = flate2::read::GzDecoder::new(f);
        let mut tar = tar::Archive::new(gz);
        let mut out = Vec::new();
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            out.push((path, bytes));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn single_root_writes_archive_with_relative_paths() {
        let (_tmp, home, backup) = fixture();
        write_file(&home, ".claude/skills/diagnose/SKILL.md", b"---\n---\nbody\n");
        let path = create_source_backup(&home, &backup, "2026-05-05T12-00-00")
            .unwrap()
            .expect("archive path returned");
        assert_eq!(path, backup.join("2026-05-05T12-00-00.tar.gz"));
        assert!(path.exists());
        let entries = read_archive(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, ".claude/skills/diagnose/SKILL.md");
        assert_eq!(entries[0].1, b"---\n---\nbody\n");
    }

    #[test]
    fn all_three_roots_packed() {
        let (_tmp, home, backup) = fixture();
        write_file(&home, ".claude/skills/a/SKILL.md", b"a");
        write_file(&home, ".pi/agent/skills/b/SKILL.md", b"b");
        write_file(&home, ".codex/agents/c.toml", b"c");
        let path = create_source_backup(&home, &backup, "ts")
            .unwrap()
            .expect("archive returned");
        let entries = read_archive(&path);
        let names: Vec<&str> = entries.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(
            names,
            vec![
                ".claude/skills/a/SKILL.md",
                ".codex/agents/c.toml",
                ".pi/agent/skills/b/SKILL.md",
            ]
        );
    }

    #[test]
    fn hidden_files_filtered_via_is_ignored() {
        let (_tmp, home, backup) = fixture();
        write_file(&home, ".claude/skills/a/SKILL.md", b"keep");
        write_file(&home, ".claude/skills/a/.DS_Store", b"junk");
        write_file(&home, ".claude/skills/a/._sidecar", b"junk");
        let path = create_source_backup(&home, &backup, "ts")
            .unwrap()
            .unwrap();
        let names: Vec<String> = read_archive(&path).into_iter().map(|e| e.0).collect();
        assert_eq!(names, vec![".claude/skills/a/SKILL.md".to_string()]);
    }

    #[test]
    fn symlinks_are_skipped() {
        use std::os::unix::fs as unix_fs;
        let (_tmp, home, backup) = fixture();
        // Real file outside scan roots.
        write_file(&home, "elsewhere/real.md", b"target");
        // Symlink under .claude pointing at real.md.
        std::fs::create_dir_all(home.join(".claude/skills/a").as_std_path()).unwrap();
        let real = home.join("elsewhere/real.md");
        let link = home.join(".claude/skills/a/link.md");
        unix_fs::symlink(real.as_std_path(), link.as_std_path()).unwrap();
        // And a real sibling to confirm we still pack normal files.
        write_file(&home, ".claude/skills/a/SKILL.md", b"keep");
        let path = create_source_backup(&home, &backup, "ts")
            .unwrap()
            .unwrap();
        let names: Vec<String> = read_archive(&path).into_iter().map(|e| e.0).collect();
        assert_eq!(names, vec![".claude/skills/a/SKILL.md".to_string()]);
    }

    #[test]
    fn archive_is_owner_only_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, home, backup) = fixture();
        write_file(&home, ".claude/skills/a/SKILL.md", b"x");
        let path = create_source_backup(&home, &backup, "ts").unwrap().unwrap();
        let mode = std::fs::metadata(path.as_std_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "got: {mode:o}");
    }

    #[test]
    fn distinct_timestamps_yield_distinct_archives() {
        let (_tmp, home, backup) = fixture();
        write_file(&home, ".claude/skills/a/SKILL.md", b"x");
        let p1 = create_source_backup(&home, &backup, "ts-1").unwrap().unwrap();
        let p2 = create_source_backup(&home, &backup, "ts-2").unwrap().unwrap();
        assert_ne!(p1, p2);
        assert!(p1.exists());
        assert!(p2.exists());
    }

    #[test]
    fn empty_home_returns_none_and_writes_no_file() {
        let (_tmp, home, backup) = fixture();
        let out = create_source_backup(&home, &backup, "2026-05-05T12-00-00").unwrap();
        assert!(out.is_none());
        // backup_dir was not created either — pure no-op.
        assert!(!backup.exists(), "backup dir should not exist: {backup}");
    }
}
