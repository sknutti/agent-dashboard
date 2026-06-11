//! Duplicate a primitive's library directory.
//!
//! Working-copy bytes are copied verbatim. `metadata.yaml` is recreated with
//! a fresh `created_at` but inherits the editable fields (`allowed_targets`,
//! `display_name`) so the duplicate shares its source's shape. Published
//! versions and `current.txt` are *not* carried over — the duplicate starts
//! at "no published version." Install records are not duplicated.

use std::fs;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::layout::LibraryLayout;
use crate::metadata::PrimitiveMetadata;
use crate::{Error, PrimitiveKind, PrimitiveName};

pub struct DuplicatePrimitiveRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub kind: PrimitiveKind,
    pub source_name: &'a PrimitiveName,
    pub new_name: &'a PrimitiveName,
    /// RFC3339 UTC timestamp written to the duplicate's `created_at`.
    pub now_rfc3339: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DuplicatePrimitiveSummary {
    pub new_name: PrimitiveName,
}

pub fn duplicate_primitive(
    req: DuplicatePrimitiveRequest<'_>,
) -> Result<DuplicatePrimitiveSummary, Error> {
    let source_dir = req.layout.primitive_dir(req.kind, req.source_name);
    let dest_dir = req.layout.primitive_dir(req.kind, req.new_name);

    if !source_dir.exists() {
        return Err(Error::PrimitiveNotFound {
            kind: req.kind,
            name: req.source_name.as_str().to_string(),
        });
    }
    if dest_dir.exists() {
        return Err(Error::PrimitiveAlreadyExists {
            kind: req.kind,
            name: req.new_name.as_str().to_string(),
        });
    }

    let source_metadata_path = req.layout.primitive_metadata(req.kind, req.source_name);
    let raw = fs::read_to_string(&source_metadata_path).map_err(|source| Error::Io {
        path: source_metadata_path.to_string(),
        source,
    })?;
    let mut metadata = PrimitiveMetadata::from_yaml(&raw)?;
    metadata.created_at = req.now_rfc3339.to_string();

    fs::create_dir_all(dest_dir.as_std_path()).map_err(|source| Error::Io {
        path: dest_dir.to_string(),
        source,
    })?;

    let dest_metadata_path = req.layout.primitive_metadata(req.kind, req.new_name);
    let yaml = metadata.to_yaml()?;
    fs::write(dest_metadata_path.as_std_path(), yaml.as_bytes()).map_err(|source| {
        Error::Io {
            path: dest_metadata_path.to_string(),
            source,
        }
    })?;

    let source_working = req.layout.working_dir(req.kind, req.source_name);
    let dest_working = req.layout.working_dir(req.kind, req.new_name);
    if source_working.exists() {
        copy_dir_all(source_working.as_std_path(), dest_working.as_std_path()).map_err(
            |source| Error::Io {
                path: dest_working.to_string(),
                source,
            },
        )?;
    }

    Ok(DuplicatePrimitiveSummary {
        new_name: req.new_name.clone(),
    })
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ft.is_file() {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold::scaffold_skill;
    use crate::Target;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    #[test]
    fn duplicate_copies_working_bytes_and_keeps_allowed_targets_with_fresh_created_at() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let source = name("original");
        scaffold_skill(layout, &source, "2026-04-01T00:00:00Z").unwrap();

        // Configure source allowed_targets and write a non-empty body so we
        // can verify both the metadata copy and the working-copy bytes.
        let source_meta_path = layout.primitive_metadata(PrimitiveKind::Skill, &source);
        let configured = PrimitiveMetadata {
            allowed_targets: vec![Target::Claude, Target::Pi],
            created_at: "2026-04-01T00:00:00Z".to_string(),
            display_name: Some("Diagnose Tool".to_string()),
            author: None,
            source_url: None,
        };
        std::fs::write(source_meta_path.as_std_path(), configured.to_yaml().unwrap())
            .unwrap();
        let source_skill_md = layout
            .working_base(PrimitiveKind::Skill, &source)
            .join("SKILL.md");
        std::fs::write(source_skill_md.as_std_path(), b"---\n---\nbody bytes\n").unwrap();

        let dest = name("original-copy");
        let summary = duplicate_primitive(DuplicatePrimitiveRequest {
            layout,
            kind: PrimitiveKind::Skill,
            source_name: &source,
            new_name: &dest,
            now_rfc3339: "2026-05-06T12:00:00Z",
        })
        .unwrap();
        assert_eq!(summary.new_name, dest);

        // Source untouched.
        assert!(layout
            .primitive_dir(PrimitiveKind::Skill, &source)
            .exists());

        // Dest exists with copied working bytes.
        let dest_skill_md = layout
            .working_base(PrimitiveKind::Skill, &dest)
            .join("SKILL.md");
        assert_eq!(
            std::fs::read(dest_skill_md.as_std_path()).unwrap(),
            b"---\n---\nbody bytes\n",
        );

        // Metadata: targets and display_name carried over, created_at fresh.
        let dest_meta_raw =
            std::fs::read_to_string(layout.primitive_metadata(PrimitiveKind::Skill, &dest).as_std_path())
                .unwrap();
        let dest_meta = PrimitiveMetadata::from_yaml(&dest_meta_raw).unwrap();
        assert_eq!(dest_meta.allowed_targets, vec![Target::Claude, Target::Pi]);
        assert_eq!(dest_meta.display_name, Some("Diagnose Tool".to_string()));
        assert_eq!(dest_meta.created_at, "2026-05-06T12:00:00Z");

        // No versions carried over.
        assert!(!layout
            .versions_dir(PrimitiveKind::Skill, &dest)
            .exists());
        assert!(!layout
            .current_marker(PrimitiveKind::Skill, &dest)
            .exists());
    }

    #[test]
    fn refuses_when_source_does_not_exist() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let err = duplicate_primitive(DuplicatePrimitiveRequest {
            layout,
            kind: PrimitiveKind::Skill,
            source_name: &name("ghost"),
            new_name: &name("ghost-copy"),
            now_rfc3339: "2026-05-06T12:00:00Z",
        })
        .unwrap_err();

        assert!(
            matches!(
                err,
                Error::PrimitiveNotFound { kind: PrimitiveKind::Skill, ref name }
                    if name == "ghost"
            ),
            "expected PrimitiveNotFound, got {err:?}"
        );
    }

    #[test]
    fn refuses_when_target_name_already_taken() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);

        let source = name("original");
        let dest = name("taken");
        scaffold_skill(layout, &source, "2026-04-01T00:00:00Z").unwrap();
        scaffold_skill(layout, &dest, "2026-04-01T00:00:00Z").unwrap();

        let err = duplicate_primitive(DuplicatePrimitiveRequest {
            layout,
            kind: PrimitiveKind::Skill,
            source_name: &source,
            new_name: &dest,
            now_rfc3339: "2026-05-06T12:00:00Z",
        })
        .unwrap_err();

        assert!(
            matches!(
                err,
                Error::PrimitiveAlreadyExists { kind: PrimitiveKind::Skill, ref name }
                    if name == "taken"
            ),
            "expected PrimitiveAlreadyExists, got {err:?}"
        );
    }
}
