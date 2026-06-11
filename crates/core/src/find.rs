//! Library-wide working-copy text search.
//!
//! Walks every primitive directory under the library, reads the working
//! primary file's bytes, and returns one [`FindHit`] per matching line.
//! Pure filesystem read — no FS watching, no caching across calls.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ignored::is_ignored;
use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveName};

/// One match in one primitive's working-copy primary file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FindHit {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub line_number: u32,
    pub line_text: String,
}

/// Search options. `case_sensitive: false` is the typical interactive default.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
pub struct FindOptions {
    pub case_sensitive: bool,
}

const MAX_LINE_LEN: usize = 500;
const MAX_HITS: usize = 500;

/// Scan every primitive's working-copy primary file for lines matching
/// `query`. Empty queries return `Ok(vec![])` rather than every line.
///
/// Bytes that fail UTF-8 decoding are skipped (the line is treated as a
/// non-match). Files that are missing entirely are skipped silently.
/// Returns up to [`MAX_HITS`] hits in (kind, name, line_number) order.
pub fn find_in_library(
    layout: LibraryLayout<'_>,
    query: &str,
    opts: FindOptions,
) -> Result<Vec<FindHit>, Error> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let needle = if opts.case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    let mut hits: Vec<FindHit> = Vec::new();

    for &kind in PrimitiveKind::ALL {
        let kind_dir = layout.kind_dir(kind);
        let read_dir = match std::fs::read_dir(&kind_dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(Error::Io {
                    path: kind_dir.to_string(),
                    source,
                })
            }
        };

        let mut entries: Vec<PrimitiveName> = Vec::new();
        for entry in read_dir {
            let entry = entry.map_err(|source| Error::Io {
                path: kind_dir.to_string(),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| Error::Io {
                path: kind_dir.to_string(),
                source,
            })?;
            if !file_type.is_dir() {
                continue;
            }
            let name_os = entry.file_name();
            let name_str = name_os.to_string_lossy();
            if is_ignored(camino::Utf8Path::new(name_str.as_ref())) {
                continue;
            }
            let Ok(name) = PrimitiveName::try_new(name_str.as_ref()) else {
                continue;
            };
            entries.push(name);
        }
        entries.sort_by(|a, b| a.as_str().cmp(b.as_str()));

        for name in entries {
            let primary = kind.primary_filename(&name);
            let path = layout.working_base(kind, &name).join(&primary);
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(source) => {
                    return Err(Error::Io {
                        path: path.to_string(),
                        source,
                    });
                }
            };
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };

            for (i, line) in text.lines().enumerate() {
                let haystack_owned;
                let haystack = if opts.case_sensitive {
                    line
                } else {
                    haystack_owned = line.to_lowercase();
                    haystack_owned.as_str()
                };
                if haystack.contains(&needle) {
                    let trimmed = if line.len() > MAX_LINE_LEN {
                        let mut end = MAX_LINE_LEN;
                        while !line.is_char_boundary(end) {
                            end -= 1;
                        }
                        format!("{}…", &line[..end])
                    } else {
                        line.to_string()
                    };
                    hits.push(FindHit {
                        kind,
                        name: name.clone(),
                        line_number: (i + 1) as u32,
                        line_text: trimmed,
                    });
                    if hits.len() >= MAX_HITS {
                        return Ok(hits);
                    }
                }
            }
        }
    }

    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold::scaffold_skill;
    use crate::WorkingCopy;
    use camino::{Utf8Path, Utf8PathBuf};
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
    }

    fn write_skill(layout: LibraryLayout<'_>, name: &str, body: &[u8]) -> PrimitiveName {
        let pname = PrimitiveName::try_new(name).unwrap();
        scaffold_skill(layout, &pname, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &pname,
            Utf8Path::new("SKILL.md"),
            body,
        )
        .unwrap();
        pname
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        write_skill(layout, "diagnose", b"---\n---\nhello world\n");
        let hits = find_in_library(layout, "", FindOptions::default()).unwrap();
        assert_eq!(hits, vec![]);
    }

    #[test]
    fn finds_match_with_line_number() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = write_skill(
            layout,
            "diagnose",
            b"---\nname: x\n---\nfirst\nneedle here\nlast\n",
        );
        let hits = find_in_library(layout, "needle", FindOptions::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, PrimitiveKind::Skill);
        assert_eq!(hits[0].name, name);
        assert_eq!(hits[0].line_number, 5);
        assert_eq!(hits[0].line_text, "needle here");
    }

    #[test]
    fn case_insensitive_by_default() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        write_skill(layout, "diagnose", b"---\n---\nNEEDLE\n");
        let hits = find_in_library(layout, "needle", FindOptions::default()).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn case_sensitive_when_requested() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        write_skill(layout, "diagnose", b"---\n---\nNEEDLE\nneedle\n");
        let hits = find_in_library(
            layout,
            "needle",
            FindOptions {
                case_sensitive: true,
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 4);
    }

    #[test]
    fn no_matches_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        write_skill(layout, "diagnose", b"---\n---\nhello\n");
        let hits = find_in_library(layout, "missing", FindOptions::default()).unwrap();
        assert_eq!(hits, vec![]);
    }

    #[test]
    fn results_sorted_by_kind_then_name_then_line() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        write_skill(layout, "zeta", b"---\n---\nfoo\nfoo bar\n");
        write_skill(layout, "alpha", b"---\n---\nfoo\n");
        let hits = find_in_library(layout, "foo", FindOptions::default()).unwrap();
        let summary: Vec<_> = hits
            .iter()
            .map(|h| (h.name.as_str(), h.line_number))
            .collect();
        assert_eq!(
            summary,
            vec![("alpha", 3), ("zeta", 3), ("zeta", 4)]
        );
    }

    #[test]
    fn ignores_non_utf8_files() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        // Scaffold writes valid UTF-8; overwrite primary with invalid bytes.
        let pname = PrimitiveName::try_new("garbage").unwrap();
        scaffold_skill(layout, &pname, "2026-05-04T00:00:00Z").unwrap();
        let path = layout.working_base(PrimitiveKind::Skill, &pname).join("SKILL.md");
        std::fs::write(path, [0xff, 0xfe, 0xfd]).unwrap();
        // A second, valid skill so we know the walker continues past the bad one.
        write_skill(layout, "valid", b"---\n---\nfindme\n");

        let hits = find_in_library(layout, "findme", FindOptions::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name.as_str(), "valid");
    }

    #[test]
    fn skips_ref_file_content_under_working_base() {
        // P11 decision #9 — library-wide find reads the primary file only.
        // A ref file containing the needle must NOT appear in results.
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        // Primary contains nothing matching; ref file alone holds the needle.
        let name = write_skill(layout, "diagnose", b"---\n---\nplain primary\n");
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("notes/intro.md"),
            b"# notes\nneedle here\n",
        )
        .unwrap();

        let hits = find_in_library(layout, "needle", FindOptions::default()).unwrap();
        assert!(
            hits.is_empty(),
            "ref-file content must not appear in library-wide find results: {hits:?}",
        );
    }

    #[test]
    fn truncates_very_long_lines() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let mut body = b"---\n---\n".to_vec();
        body.extend(std::iter::repeat(b'x').take(MAX_LINE_LEN + 50));
        body.extend(b"needle\n");
        write_skill(layout, "long", &body);

        let hits = find_in_library(layout, "x", FindOptions::default()).unwrap();
        assert!(hits.iter().any(|h| h.line_text.ends_with('…')));
        assert!(hits
            .iter()
            .all(|h| h.line_text.chars().count() <= MAX_LINE_LEN + 1));
    }
}
