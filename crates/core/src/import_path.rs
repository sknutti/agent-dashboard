//! Single-path import — the drag-drop fast path.
//!
//! Wraps [`crate::scanner::classify_path`] for one dropped file/dir. On a
//! clean classification we leverage [`crate::execute_creates`] to scaffold
//! the primitive at v1 in the library, mirroring what the bootstrap wizard
//! does for a single create. Mixed/unclassifiable drops should be sent
//! back through the wizard by the caller.

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::bootstrap::{execute_creates, CreateAction};
use crate::deduper::BaseAssignment;
use crate::layout::LibraryLayout;
use crate::scanner::{classify_path, ParseStatus, ScanResult};
use crate::{Error, PrimitiveKind, PrimitiveName};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportFromPathResult {
    /// Successfully scaffolded a new primitive in the library at v1.
    Imported {
        primitive_kind: PrimitiveKind,
        name: PrimitiveName,
    },
    /// Path is under a recognized install root but already exists in the
    /// library. The caller should surface a "already imported" message.
    AlreadyExists {
        primitive_kind: PrimitiveKind,
        name: PrimitiveName,
    },
    /// Path is not classifiable as a single primitive — a symlink, a stray
    /// file outside a known root, or a malformed entry. The caller should
    /// fall back to the bootstrap wizard.
    NotClassifiable { reason: String },
}

pub fn import_primitive_from_path(
    layout: LibraryLayout<'_>,
    home: &Utf8Path,
    installs_file_path: &Utf8Path,
    source_path: &Utf8Path,
    now_rfc3339: &str,
) -> Result<ImportFromPathResult, Error> {
    let Some(scan) = classify_path(home, source_path) else {
        return Ok(ImportFromPathResult::NotClassifiable {
            reason: "path is not under a recognized install root".to_string(),
        });
    };

    match scan {
        ScanResult::Symlinked { .. } => Ok(ImportFromPathResult::NotClassifiable {
            reason: "symlinks are not auto-imported".to_string(),
        }),
        ScanResult::Unclassified { reason, .. } => {
            Ok(ImportFromPathResult::NotClassifiable { reason })
        }
        ScanResult::Candidate {
            kind,
            name,
            parse,
            source_path,
            ..
        } => {
            if let ParseStatus::Unparseable { reason } = parse {
                return Ok(ImportFromPathResult::NotClassifiable {
                    reason: format!("primary file failed to parse: {reason}"),
                });
            }
            if layout.primitive_dir(kind, &name).exists() {
                return Ok(ImportFromPathResult::AlreadyExists {
                    primitive_kind: kind,
                    name,
                });
            }
            let action = CreateAction {
                kind,
                name: name.clone(),
                base: BaseAssignment {
                    target: scan_target(home, &source_path).expect("classify_path matched"),
                    source_path: source_path.clone(),
                    parse: ParseStatus::Parsed,
                },
                overlays: Vec::new(),
            };
            execute_creates(
                std::slice::from_ref(&action),
                layout,
                installs_file_path,
                now_rfc3339,
            )?;
            Ok(ImportFromPathResult::Imported {
                primitive_kind: kind,
                name,
            })
        }
    }
}

/// Re-derive the target slot from `source_path`'s position under `home`.
/// `classify_path` already matched this; we rerun the prefix check here
/// instead of plumbing the target out of `ScanResult` to keep the scanner
/// API unchanged.
fn scan_target(
    home: &Utf8Path,
    source_path: &Utf8Path,
) -> Option<crate::Target> {
    use crate::scanner::SCAN_MATRIX;
    for &(_, target, suffix) in SCAN_MATRIX {
        let root = home.join(suffix);
        if source_path.strip_prefix(&root).is_ok() {
            return Some(target);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_state::InstallsFile;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn paths(tmp: &TempDir) -> (Utf8PathBuf, Utf8PathBuf, Utf8PathBuf) {
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let library = root.join("library");
        let home = root.join("home");
        let installs = root.join("installs.json");
        std::fs::create_dir_all(library.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        InstallsFile::default().save(&installs).unwrap();
        (library, home, installs)
    }

    #[test]
    fn imports_a_skill_dir_dropped_under_claude_root() {
        let tmp = TempDir::new().unwrap();
        let (library, home, installs) = paths(&tmp);
        let layout = LibraryLayout::new(&library);

        // Build a Claude-side Skill source: ~/.claude/skills/diagnose/SKILL.md
        let skill_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(skill_dir.as_std_path()).unwrap();
        let skill_md = skill_dir.join("SKILL.md");
        std::fs::write(skill_md.as_std_path(), "---\nname: diagnose\n---\nbody\n")
            .unwrap();

        let result = import_primitive_from_path(
            layout,
            &home,
            &installs,
            &skill_dir,
            "2026-05-06T12:00:00Z",
        )
        .unwrap();

        match result {
            ImportFromPathResult::Imported {
                primitive_kind,
                name,
            } => {
                assert_eq!(primitive_kind, PrimitiveKind::Skill);
                assert_eq!(name.as_str(), "diagnose");
            }
            other => panic!("expected Imported, got {other:?}"),
        }

        // Library now has the primitive at v1.
        let dest = layout.primitive_dir(
            PrimitiveKind::Skill,
            &PrimitiveName::try_new("diagnose").unwrap(),
        );
        assert!(dest.exists());
        assert!(dest.join("metadata.yaml").exists());
        assert!(dest.join("working/base/SKILL.md").exists());

        // installs.json gained a Claude record.
        let after = InstallsFile::load(&installs).unwrap();
        assert_eq!(after.records.len(), 1);
        assert_eq!(after.records[0].kind, PrimitiveKind::Skill);
        assert_eq!(after.records[0].name.as_str(), "diagnose");
    }

    #[test]
    fn imports_a_command_md_dropped_under_claude_root() {
        let tmp = TempDir::new().unwrap();
        let (library, home, installs) = paths(&tmp);
        let layout = LibraryLayout::new(&library);

        let cmd_dir = home.join(".claude/commands");
        std::fs::create_dir_all(cmd_dir.as_std_path()).unwrap();
        let cmd_path = cmd_dir.join("review.md");
        std::fs::write(cmd_path.as_std_path(), "---\n---\nbody\n").unwrap();

        let result = import_primitive_from_path(
            layout,
            &home,
            &installs,
            &cmd_path,
            "2026-05-06T12:00:00Z",
        )
        .unwrap();

        assert!(matches!(
            result,
            ImportFromPathResult::Imported {
                primitive_kind: PrimitiveKind::Command,
                ..
            }
        ));
    }

    #[test]
    fn rejects_path_outside_any_install_root() {
        let tmp = TempDir::new().unwrap();
        let (library, home, installs) = paths(&tmp);
        let layout = LibraryLayout::new(&library);

        let stray = tmp.path().join("stray.md");
        std::fs::write(&stray, "---\n---\n").unwrap();
        let stray_utf8 = Utf8PathBuf::from_path_buf(stray).unwrap();

        let result = import_primitive_from_path(
            layout,
            &home,
            &installs,
            &stray_utf8,
            "2026-05-06T12:00:00Z",
        )
        .unwrap();

        assert!(matches!(result, ImportFromPathResult::NotClassifiable { .. }));
    }

    #[test]
    fn returns_already_exists_when_library_has_the_same_kind_name() {
        let tmp = TempDir::new().unwrap();
        let (library, home, installs) = paths(&tmp);
        let layout = LibraryLayout::new(&library);

        // Pre-populate the library with a Skill named "diagnose".
        crate::scaffold::scaffold_skill(
            layout,
            &PrimitiveName::try_new("diagnose").unwrap(),
            "2026-04-01T00:00:00Z",
        )
        .unwrap();

        // Source matching that (kind, name) under the Claude root.
        let skill_dir = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(skill_dir.as_std_path()).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md").as_std_path(),
            "---\n---\nbody\n",
        )
        .unwrap();

        let result = import_primitive_from_path(
            layout,
            &home,
            &installs,
            &skill_dir,
            "2026-05-06T12:00:00Z",
        )
        .unwrap();

        assert!(matches!(
            result,
            ImportFromPathResult::AlreadyExists {
                primitive_kind: PrimitiveKind::Skill,
                ..
            }
        ));
    }
}
