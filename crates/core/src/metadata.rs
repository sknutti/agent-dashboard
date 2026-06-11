use serde::{Deserialize, Serialize};
use specta::Type;

use crate::detail::list_overlays;
use crate::fs_helpers::atomic_write;
use crate::working_copy::WorkingCopy;
use crate::yaml_splice::{self, SpliceError};
use camino::Utf8Path;

use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveName, Target};

/// `metadata.yaml` for a single primitive directory.
///
/// `created_at` is an RFC3339 timestamp stored as a string — the core crate
/// doesn't need timezone math, so no chrono dep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PrimitiveMetadata {
    pub allowed_targets: Vec<Target>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Free-text attribution: who this Primitive came from. Self-attribute by
    /// typing your own name. Sidebar search matches this in addition to name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// URL the primitive was imported from (set once at create time when the
    /// user pulls a primitive in by URL — never edited via the inspector).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

impl PrimitiveMetadata {
    pub fn from_yaml(s: &str) -> Result<Self, Error> {
        Ok(serde_yaml_ng::from_str(s)?)
    }

    pub fn to_yaml(&self) -> Result<String, Error> {
        serde_yaml_ng::to_string(self).map_err(|e| Error::MetadataSerialize(e.to_string()))
    }
}

/// Editable subset of `PrimitiveMetadata`. `created_at` is preserved verbatim
/// from the existing file, so the UI cannot accidentally mutate it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MetadataUpdate {
    pub allowed_targets: Vec<Target>,
    pub display_name: Option<String>,
    pub author: Option<String>,
    /// If true, dropping a target with extant overlay files deletes those
    /// files. If false (default), the update errors with
    /// `TargetRemovedWithOverlays` so the UI can confirm with the user.
    #[serde(default)]
    pub discard_orphan_overlays: bool,
}

/// Read `metadata.yaml`, replace the editable fields, atomic-write back.
/// Errors if the metadata file is missing or unparseable.
pub fn update_primitive_metadata(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    update: MetadataUpdate,
) -> Result<PrimitiveMetadata, Error> {
    for &target in &update.allowed_targets {
        if !kind.allows_target(target) {
            return Err(Error::TargetNotAllowedForKind { kind, target });
        }
    }
    let path = layout.primitive_metadata(kind, name);
    let raw = std::fs::read_to_string(&path).map_err(|source| Error::Io {
        path: path.to_string(),
        source,
    })?;
    let mut metadata = PrimitiveMetadata::from_yaml(&raw)?;
    let prev_targets = metadata.allowed_targets.clone();
    let prev_display = metadata.display_name.clone();
    let prev_author = metadata.author.clone();

    let dropped: Vec<Target> = prev_targets
        .iter()
        .copied()
        .filter(|t| !update.allowed_targets.contains(t))
        .collect();
    if !dropped.is_empty() {
        let overlays = list_overlays(layout, kind, name)?;
        let dropped_with_overlays: Vec<_> = overlays
            .into_iter()
            .filter(|o| dropped.contains(&o.target))
            .collect();
        if !dropped_with_overlays.is_empty() {
            if !update.discard_orphan_overlays {
                return Err(Error::TargetRemovedWithOverlays {
                    dropped: dropped_with_overlays,
                });
            }
            let wc = WorkingCopy::new(layout);
            for overlay in &dropped_with_overlays {
                for rel in &overlay.paths {
                    wc.remove_target_file(kind, name, overlay.target, Utf8Path::new(rel))?;
                }
            }
        }
    }

    metadata.allowed_targets = update.allowed_targets;
    metadata.display_name = update.display_name;
    metadata.author = update.author;

    let next = match try_splice_metadata(
        &raw,
        &prev_targets,
        &metadata.allowed_targets,
        prev_display.as_deref(),
        metadata.display_name.as_deref(),
        prev_author.as_deref(),
        metadata.author.as_deref(),
    ) {
        Ok(s) => s,
        Err(_) => metadata.to_yaml()?,
    };
    atomic_write(&path, next.as_bytes())?;
    Ok(metadata)
}

/// Try to splice the metadata changes into `raw` byte-by-byte so comments,
/// blank lines, and quoting style survive. Bails (any `SpliceError`) when the
/// edit can't be expressed as a single value swap or sequence add/remove —
/// the caller falls back to a full serde re-emit.
fn try_splice_metadata(
    raw: &str,
    prev_targets: &[Target],
    new_targets: &[Target],
    prev_display: Option<&str>,
    new_display: Option<&str>,
    prev_author: Option<&str>,
    new_author: Option<&str>,
) -> Result<String, SpliceError> {
    let mut out = raw.to_string();

    match (prev_display, new_display) {
        (None, None) => {}
        (Some(a), Some(b)) if a == b => {}
        (Some(_), Some(b)) => {
            out = yaml_splice::set_scalar(&out, "display_name", b)?;
        }
        // Splice can't add or remove top-level keys.
        _ => return Err(SpliceError::Unsupported("display_name add/remove")),
    }

    match (prev_author, new_author) {
        (None, None) => {}
        (Some(a), Some(b)) if a == b => {}
        (Some(_), Some(b)) => {
            out = yaml_splice::set_scalar(&out, "author", b)?;
        }
        _ => return Err(SpliceError::Unsupported("author add/remove")),
    }

    let removed: Vec<Target> = prev_targets
        .iter()
        .copied()
        .filter(|t| !new_targets.contains(t))
        .collect();
    let added: Vec<Target> = new_targets
        .iter()
        .copied()
        .filter(|t| !prev_targets.contains(t))
        .collect();

    // Sets equal but order differs — splice keeps the on-disk order and
    // returned metadata wouldn't match. Fall back to a full re-emit.
    if removed.is_empty() && added.is_empty() && prev_targets != new_targets {
        return Err(SpliceError::Unsupported("allowed_targets reordered"));
    }

    for t in &removed {
        out = yaml_splice::seq_remove_string(&out, "allowed_targets", t.dir_name())?;
    }
    for t in &added {
        out = yaml_splice::seq_add_string(&out, "allowed_targets", t.dir_name())?;
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_metadata() {
        let yaml = "allowed_targets: [claude]\ncreated_at: '2026-04-30T12:00:00Z'\n";
        let meta = PrimitiveMetadata::from_yaml(yaml).expect("parse ok");
        assert_eq!(meta.allowed_targets, vec![Target::Claude]);
        assert_eq!(meta.created_at, "2026-04-30T12:00:00Z");
        assert_eq!(meta.display_name, None);
    }

    #[test]
    fn parses_all_targets() {
        let yaml = r#"
allowed_targets:
  - claude
  - pi
  - codex
created_at: '2026-04-30T12:00:00Z'
display_name: Diagnose
"#;
        let meta = PrimitiveMetadata::from_yaml(yaml).expect("parse ok");
        assert_eq!(
            meta.allowed_targets,
            vec![Target::Claude, Target::Pi, Target::Codex]
        );
        assert_eq!(meta.display_name.as_deref(), Some("Diagnose"));
    }

    #[test]
    fn missing_required_field_errors() {
        let yaml = "allowed_targets: [claude]\n"; // no created_at
        PrimitiveMetadata::from_yaml(yaml).expect_err("missing created_at should fail");
    }

    #[test]
    fn unknown_target_errors() {
        let yaml = "allowed_targets: [bogus]\ncreated_at: '2026-04-30T12:00:00Z'\n";
        PrimitiveMetadata::from_yaml(yaml).expect_err("unknown target should fail");
    }

    #[test]
    fn round_trip_to_yaml_and_back() {
        let original = PrimitiveMetadata {
            allowed_targets: vec![Target::Claude, Target::Codex],
            created_at: "2026-04-30T12:00:00Z".into(),
            display_name: Some("Hello".into()),
            author: None,
            source_url: None,
        };
        let yaml = original.to_yaml().expect("serialize ok");
        let parsed = PrimitiveMetadata::from_yaml(&yaml).expect("re-parse ok");
        assert_eq!(parsed, original);
    }

    #[test]
    fn update_replaces_allowed_targets_and_preserves_created_at() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let updated = update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi],
                display_name: Some("Diagnose".into()),
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        assert_eq!(updated.allowed_targets, vec![Target::Claude, Target::Pi]);
        assert_eq!(updated.display_name.as_deref(), Some("Diagnose"));
        assert_eq!(updated.created_at, "2026-05-04T00:00:00Z");

        let on_disk = PrimitiveMetadata::from_yaml(
            &std::fs::read_to_string(layout.primitive_metadata(PrimitiveKind::Skill, &name))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk, updated);
    }

    #[test]
    fn update_clears_display_name_when_none() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        // First set a display_name
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: Some("Diagnose".into()),
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        // Then clear it
        let cleared = update_primitive_metadata(
            layout,
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
        assert_eq!(cleared.display_name, None);

        let raw = std::fs::read_to_string(
            layout.primitive_metadata(PrimitiveKind::Skill, &name),
        )
        .unwrap();
        assert!(
            !raw.contains("display_name"),
            "cleared display_name must be omitted, got:\n{raw}"
        );
    }

    #[test]
    fn update_rejects_target_not_in_kind_matrix() {
        use crate::scaffold::scaffold_primitive;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("review").unwrap();
        scaffold_primitive(
            layout,
            PrimitiveKind::CodexAgent,
            &name,
            "2026-05-04T00:00:00Z",
            None,
        )
        .unwrap();

        let err = update_primitive_metadata(
            layout,
            PrimitiveKind::CodexAgent,
            &name,
            MetadataUpdate {
                // CodexAgent only ships to codex; claude is not allowed.
                allowed_targets: vec![Target::Codex, Target::Claude],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap_err();

        assert!(
            matches!(
                err,
                Error::TargetNotAllowedForKind {
                    kind: PrimitiveKind::CodexAgent,
                    target: Target::Claude,
                }
            ),
            "expected TargetNotAllowedForKind, got {err:?}",
        );

        // File on disk is unchanged — validation runs before any write.
        // (Scaffold leaves allowed_targets empty by default.)
        let on_disk = PrimitiveMetadata::from_yaml(
            &std::fs::read_to_string(layout.primitive_metadata(PrimitiveKind::CodexAgent, &name))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk.allowed_targets, Vec::<Target>::new());
    }

    #[test]
    fn dropping_target_with_overlay_errors_without_force() {
        use crate::scaffold::scaffold_skill;
        use camino::{Utf8Path, Utf8PathBuf};
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        // Allow Claude + Pi; create an overlay file under Claude.
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nclaude override\n",
        )
        .unwrap();

        // Try to drop Claude — should error out.
        let err = update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap_err();
        match err {
            Error::TargetRemovedWithOverlays { dropped } => {
                assert_eq!(dropped.len(), 1);
                assert_eq!(dropped[0].target, Target::Claude);
                assert_eq!(dropped[0].paths, vec!["SKILL.md".to_string()]);
            }
            other => panic!("expected TargetRemovedWithOverlays, got {other:?}"),
        }

        // Overlay file still exists; metadata still has Claude.
        let overlay_path = layout
            .working_target(PrimitiveKind::Skill, &name, Target::Claude)
            .join("SKILL.md");
        assert!(overlay_path.exists());
        let on_disk = PrimitiveMetadata::from_yaml(
            &std::fs::read_to_string(layout.primitive_metadata(PrimitiveKind::Skill, &name))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk.allowed_targets, vec![Target::Claude, Target::Pi]);
    }

    #[test]
    fn dropping_target_with_overlay_succeeds_with_discard_flag() {
        use crate::scaffold::scaffold_skill;
        use camino::{Utf8Path, Utf8PathBuf};
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nclaude override\n",
        )
        .unwrap();

        let updated = update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: true,
            },
        )
        .unwrap();
        assert_eq!(updated.allowed_targets, vec![Target::Pi]);

        let overlay_path = layout
            .working_target(PrimitiveKind::Skill, &name, Target::Claude)
            .join("SKILL.md");
        assert!(
            !overlay_path.exists(),
            "discard_orphan_overlays=true must delete the overlay file",
        );
    }

    #[test]
    fn dropping_target_without_overlay_files_is_allowed() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        // Drop Pi with no overlay files — should succeed without force.
        let updated = update_primitive_metadata(
            layout,
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
        assert_eq!(updated.allowed_targets, vec![Target::Claude]);
    }

    #[test]
    fn update_preserves_comments_when_only_targets_change() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        // Hand-edit the file to introduce comments + a populated allowed_targets.
        let path = layout.primitive_metadata(PrimitiveKind::Skill, &name);
        let hand_edited = "\
# Top-of-file comment
allowed_targets:
  - claude  # default target
  - pi
created_at: '2026-05-04T00:00:00Z'
# trailing comment
";
        std::fs::write(&path, hand_edited).unwrap();

        // Add `codex` — splice path should preserve every comment verbatim.
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi, Target::Codex],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("# Top-of-file comment"),
            "top comment lost:\n{after}"
        );
        assert!(
            after.contains("# default target"),
            "inline comment lost:\n{after}"
        );
        assert!(
            after.contains("# trailing comment"),
            "trailing comment lost:\n{after}"
        );
        assert!(
            after.contains("codex"),
            "added target missing:\n{after}"
        );
    }

    #[test]
    fn update_preserves_comments_when_removing_target() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let path = layout.primitive_metadata(PrimitiveKind::Skill, &name);
        let hand_edited = "\
# keep me
allowed_targets:
  - claude
  - pi
  - codex
created_at: '2026-05-04T00:00:00Z'
";
        std::fs::write(&path, hand_edited).unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Codex],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("# keep me"), "comment lost:\n{after}");
        assert!(after.contains("claude"), "claude missing:\n{after}");
        assert!(after.contains("codex"), "codex missing:\n{after}");
        assert!(
            !after.contains("- pi"),
            "pi should have been removed:\n{after}"
        );
    }

    #[test]
    fn update_preserves_comments_when_setting_display_name() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let path = layout.primitive_metadata(PrimitiveKind::Skill, &name);
        let hand_edited = "\
allowed_targets:
  - claude
created_at: '2026-05-04T00:00:00Z'
display_name: Old  # human-friendly
";
        std::fs::write(&path, hand_edited).unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: Some("New".into()),
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("# human-friendly"),
            "inline comment lost:\n{after}"
        );
        assert!(after.contains("New"), "new display_name missing:\n{after}");
        assert!(
            !after.contains("Old"),
            "old display_name should be gone:\n{after}"
        );
    }

    #[test]
    fn update_falls_back_when_adding_display_name_key() {
        // None → Some(_) requires inserting a new key — splice can't do that,
        // so we exercise the serde re-emit fallback. The file is rewritten
        // and the comment is lost; we only assert correctness, not preservation.
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: Some("Hello".into()),
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let raw = std::fs::read_to_string(
            layout.primitive_metadata(PrimitiveKind::Skill, &name),
        )
        .unwrap();
        assert!(raw.contains("display_name"), "display_name missing:\n{raw}");
        assert!(raw.contains("Hello"), "value missing:\n{raw}");
    }

    #[test]
    fn round_trip_drops_none_display_name() {
        let original = PrimitiveMetadata {
            allowed_targets: vec![Target::Pi],
            created_at: "2026-04-30T12:00:00Z".into(),
            display_name: None,
            author: None,
            source_url: None,
        };
        let yaml = original.to_yaml().expect("serialize ok");
        assert!(
            !yaml.contains("display_name"),
            "None display_name should be omitted, got:\n{yaml}"
        );
    }

    #[test]
    fn round_trip_drops_none_author() {
        let original = PrimitiveMetadata {
            allowed_targets: vec![Target::Pi],
            created_at: "2026-04-30T12:00:00Z".into(),
            display_name: None,
            author: None,
            source_url: None,
        };
        let yaml = original.to_yaml().expect("serialize ok");
        assert!(
            !yaml.contains("author"),
            "None author should be omitted, got:\n{yaml}"
        );
    }

    #[test]
    fn parses_author_field() {
        let yaml = "\
allowed_targets: [claude]
created_at: '2026-04-30T12:00:00Z'
author: Alice
";
        let meta = PrimitiveMetadata::from_yaml(yaml).expect("parse ok");
        assert_eq!(meta.author.as_deref(), Some("Alice"));
    }

    #[test]
    fn update_sets_and_clears_author() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let with_author = update_primitive_metadata(
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
        assert_eq!(with_author.author.as_deref(), Some("Alice"));

        let cleared = update_primitive_metadata(
            layout,
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
        assert_eq!(cleared.author, None);

        let raw = std::fs::read_to_string(
            layout.primitive_metadata(PrimitiveKind::Skill, &name),
        )
        .unwrap();
        assert!(
            !raw.contains("author"),
            "cleared author must be omitted, got:\n{raw}"
        );
    }

    #[test]
    fn update_preserves_comments_when_changing_author() {
        use crate::scaffold::scaffold_skill;
        use camino::Utf8PathBuf;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = LibraryLayout::new(&root);
        let name = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let path = layout.primitive_metadata(PrimitiveKind::Skill, &name);
        let hand_edited = "\
allowed_targets:
  - claude
created_at: '2026-05-04T00:00:00Z'
author: Alice  # who I got this from
";
        std::fs::write(&path, hand_edited).unwrap();

        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: Some("Bob".into()),
                discard_orphan_overlays: false,
            },
        )
        .unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("# who I got this from"),
            "inline comment lost:\n{after}"
        );
        assert!(after.contains("Bob"), "new author missing:\n{after}");
        assert!(!after.contains("Alice"), "old author still there:\n{after}");
    }
}
