use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ignored::is_ignored;
use crate::metadata::PrimitiveMetadata;
use crate::version_store::VersionStore;
use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveName};

/// Sidebar entry for one primitive directory.
///
/// `dirty` is true iff the working primary file's bytes differ from the
/// frozen primary file in the current pinned version. A primitive without
/// a `current.txt` is `dirty: false` — there's nothing to compare against.
///
/// `author` is read from `metadata.yaml` so the sidebar search can match
/// it without a per-primitive detail fetch. Read failures (missing file,
/// malformed YAML) leave it `None` rather than poisoning the listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PrimitiveSummary {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub dirty: bool,
    pub author: Option<String>,
}

/// Walk every kind directory under `layout.root()` and return one summary
/// per primitive directory found.
///
/// - Missing kind dirs are silently skipped.
/// - `.DS_Store` and friends (per `is_ignored`) are dropped.
/// - Entries whose name fails `PrimitiveName::try_new` are dropped (so a
///   user-dropped `My Skill/` doesn't poison the whole list).
/// - Output is sorted by `(kind, name)` for stable UI rendering.
pub fn list_primitives(layout: LibraryLayout<'_>) -> Result<Vec<PrimitiveSummary>, Error> {
    let mut summaries = Vec::new();
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
            let dirty = is_primitive_dirty(layout, kind, &name)?;
            let author = read_author(layout, kind, &name);
            summaries.push(PrimitiveSummary {
                kind,
                name,
                dirty,
                author,
            });
        }
    }
    summaries.sort_by(|a, b| {
        (a.kind as u8, a.name.as_str()).cmp(&(b.kind as u8, b.name.as_str()))
    });
    Ok(summaries)
}

/// Compare the working primary file to the current version's frozen primary
/// file. Cheap: at most two small reads, no full tree walk.
///
/// - No `current.txt` → `false` (nothing to diff against; UX shows clean).
/// - Either side missing where the other is present → `true`.
/// - Bytes equal → `false`. Bytes differ → `true`.
pub fn is_primitive_dirty(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<bool, Error> {
    let store = VersionStore::new(layout);
    let Some(label) = store.read_current(kind, name)? else {
        return Ok(false);
    };

    let primary = kind.primary_filename(name);
    let working_path = layout.working_base(kind, name).join(&primary);
    let version_path = layout.version_base(kind, name, &label).join(&primary);

    let working_bytes = read_optional(&working_path)?;
    let version_bytes = read_optional(&version_path)?;
    Ok(working_bytes != version_bytes)
}

/// Read just the `author` field from a primitive's metadata.yaml. A
/// missing or malformed file returns `None` — listing must not fail on
/// per-primitive metadata problems.
fn read_author(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Option<String> {
    let path = layout.primitive_metadata(kind, name);
    let raw = std::fs::read_to_string(&path).ok()?;
    PrimitiveMetadata::from_yaml(&raw).ok()?.author
}

fn read_optional(path: &camino::Utf8Path) -> Result<Option<Vec<u8>>, Error> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(Error::Io {
            path: path.to_string(),
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold::scaffold_skill;
    use crate::version_store::VersionMetadata;
    use crate::{VersionLabel, WorkingCopy};
    use camino::{Utf8Path, Utf8PathBuf};
    use tempfile::TempDir;

    fn root(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap()
    }

    #[test]
    fn empty_library_returns_empty_vec() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        assert_eq!(list_primitives(layout).unwrap(), vec![]);
    }

    #[test]
    fn lists_scaffolded_skill() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let listed = list_primitives(layout).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, PrimitiveKind::Skill);
        assert_eq!(listed[0].name.as_str(), "diagnose");
    }

    #[test]
    fn results_sorted_by_kind_then_name() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        for n in ["zeta", "alpha", "mu"] {
            let name = PrimitiveName::try_new(n).unwrap();
            scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        }
        let listed = list_primitives(layout).unwrap();
        let names: Vec<_> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "mu", "zeta"]);
    }

    #[test]
    fn ignores_ds_store_and_invalid_names_in_kind_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("real").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let skills_dir = root.join("skills");
        std::fs::write(skills_dir.join(".DS_Store"), b"junk").unwrap();
        std::fs::create_dir_all(skills_dir.join("Has Space")).unwrap();
        std::fs::create_dir_all(skills_dir.join("..hidden")).unwrap();

        let listed = list_primitives(layout).unwrap();
        let names: Vec<_> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn missing_kind_dirs_are_silently_skipped() {
        // Only skills dir exists; agents/commands/codex_agents do not.
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("only-skill").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        // Should not error even though three kind dirs are missing.
        let listed = list_primitives(layout).unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn unpublished_primitive_is_not_dirty() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let listed = list_primitives(layout).unwrap();
        assert!(!listed[0].dirty);
    }

    fn publish_v1(layout: LibraryLayout<'_>, name: &PrimitiveName, body: &[u8]) {
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("SKILL.md"), body)
            .unwrap();
        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        let meta = VersionMetadata {
            created_at: "2026-05-04T00:00:00Z".into(),
            notes: None,
        };
        store.snapshot(PrimitiveKind::Skill, name, &v1, &meta).unwrap();
    }

    #[test]
    fn published_with_no_edits_is_not_dirty() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        publish_v1(layout, &name, b"---\n---\nbody\n");
        let listed = list_primitives(layout).unwrap();
        assert!(!listed[0].dirty);
    }

    #[test]
    fn edited_working_after_publish_is_dirty() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        publish_v1(layout, &name, b"---\n---\noriginal\n");

        // Mutate working past v1.
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nedited\n",
        )
        .unwrap();

        let listed = list_primitives(layout).unwrap();
        assert!(listed[0].dirty);
    }

    #[test]
    fn author_populated_from_metadata_yaml() {
        use crate::metadata::{update_primitive_metadata, MetadataUpdate};
        use crate::Target;
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: Some("Alice".into()),
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let listed = list_primitives(layout).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].author.as_deref(), Some("Alice"));
    }

    #[test]
    fn missing_author_field_lists_as_none() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let listed = list_primitives(layout).unwrap();
        assert_eq!(listed[0].author, None);
    }

    #[test]
    fn malformed_metadata_does_not_poison_listing() {
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("broken").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        // Corrupt the metadata so YAML parse fails.
        std::fs::write(
            layout.primitive_metadata(PrimitiveKind::Skill, &name),
            b"!! not yaml !!",
        )
        .unwrap();
        let listed = list_primitives(layout).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].author, None);
    }

    #[test]
    fn dirty_ignores_overlay_changes() {
        // Per the spec, the dirty flag is a primary-file-only check on base —
        // target overlay edits should not move the badge.
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        publish_v1(layout, &name, b"---\n---\nbody\n");

        // Add a working overlay — base primary is untouched.
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            crate::Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nclaude override\n",
        )
        .unwrap();

        assert!(!is_primitive_dirty(layout, PrimitiveKind::Skill, &name).unwrap());
    }

    #[test]
    fn editing_ref_file_does_not_mark_dirty() {
        // P11 decision #8 — adding, editing, or deleting a ref file under
        // working/base/ does NOT flip the sidebar dirty dot. Only the
        // primary file's bytes are compared against the published version.
        let tmp = TempDir::new().unwrap();
        let root = root(&tmp);
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        publish_v1(layout, &name, b"---\n---\nbody\n");

        // Mutate ref files in every direction the editor surfaces:
        // create, edit, then delete. None of these should affect dirty.
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("notes/intro.md"),
            b"# Intro\n",
        )
        .unwrap();
        assert!(
            !is_primitive_dirty(layout, PrimitiveKind::Skill, &name).unwrap(),
            "creating a ref file must not mark dirty",
        );

        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("notes/intro.md"),
            b"# Intro v2\n",
        )
        .unwrap();
        assert!(
            !is_primitive_dirty(layout, PrimitiveKind::Skill, &name).unwrap(),
            "editing a ref file must not mark dirty",
        );

        wc.remove_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("notes/intro.md"),
        )
        .unwrap();
        assert!(
            !is_primitive_dirty(layout, PrimitiveKind::Skill, &name).unwrap(),
            "deleting a ref file must not mark dirty",
        );
    }
}
