use std::collections::HashMap;
use std::fs;
use std::io::Write;

use camino::{Utf8Path, Utf8PathBuf};

use crate::{is_ignored, Error};

/// Write `bytes` to `dest` via temp-file + rename. Creates parent dirs as
/// needed. Crash-safe: a partial write leaves the dotfile temp on disk but
/// never a torn `dest`.
pub(crate) fn atomic_write(dest: &Utf8Path, bytes: &[u8]) -> Result<(), Error> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| Error::Io {
            path: parent.as_str().into(),
            source: e,
        })?;
    }
    let tmp = tmp_sibling(dest);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| Error::Io {
            path: tmp.as_str().into(),
            source: e,
        })?;
        f.write_all(bytes).map_err(|e| Error::Io {
            path: tmp.as_str().into(),
            source: e,
        })?;
        f.sync_all().map_err(|e| Error::Io {
            path: tmp.as_str().into(),
            source: e,
        })?;
    }
    fs::rename(&tmp, dest).map_err(|e| Error::Io {
        path: dest.as_str().into(),
        source: e,
    })?;
    Ok(())
}

fn tmp_sibling(dest: &Utf8Path) -> Utf8PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let file_name = dest.file_name().unwrap_or("file");
    let parent = dest.parent().unwrap_or(Utf8Path::new("."));
    parent.join(format!(".{file_name}.tmp.{pid}.{nanos}"))
}

/// Recursively walk `cur` (must be under `root`), inserting every non-ignored
/// regular file into `out` keyed by its path relative to `root`.
pub(crate) fn walk_into(
    root: &Utf8Path,
    cur: &Utf8Path,
    out: &mut HashMap<Utf8PathBuf, Vec<u8>>,
) -> Result<(), Error> {
    let entries = fs::read_dir(cur).map_err(|e| Error::Io {
        path: cur.as_str().into(),
        source: e,
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| Error::Io {
            path: cur.as_str().into(),
            source: e,
        })?;
        let path = Utf8PathBuf::from_path_buf(entry.path()).map_err(|p| Error::Io {
            path: p.display().to_string(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF-8 path"),
        })?;
        let rel = path.strip_prefix(root).expect("walked under root");
        if is_ignored(rel) {
            continue;
        }
        let ft = entry.file_type().map_err(|e| Error::Io {
            path: path.as_str().into(),
            source: e,
        })?;
        if ft.is_dir() {
            walk_into(root, &path, out)?;
        } else if ft.is_file() {
            let bytes = fs::read(&path).map_err(|e| Error::Io {
                path: path.as_str().into(),
                source: e,
            })?;
            out.insert(rel.to_owned(), bytes);
        }
    }
    Ok(())
}
