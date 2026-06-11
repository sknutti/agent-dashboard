use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::version_store::VersionMetadata;
use crate::{
    materialize, Error, LibraryLayout, MdPrimitive, PrimitiveKind, PrimitiveMetadata,
    PrimitiveName, Target, VersionLabel, VersionStore, WorkingCopy,
};

/// Editor payload for a single primitive.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PrimitiveDetail {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub metadata: PrimitiveMetadata,
    pub working: WorkingContent,
    pub versions: Vec<VersionLabel>,
    pub current_version: Option<VersionLabel>,
}

/// Per-kind shape of the editor's working buffer.
///
/// `Md` carries split frontmatter+body for `SKILL.md`/`agent.md`/`<name>.md`.
/// `Toml` carries the raw TOML text for `<name>.toml` (CodexAgent has no
/// frontmatter and no overlays — it's a single text blob).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkingContent {
    Md(WorkingMd),
    Toml { text: String },
}

/// Working-copy view of an MD primitive split into form fields.
///
/// `frontmatter` is the raw bytes between the `---` fences (no fences
/// themselves), as UTF-8. `body` is everything after the closing fence.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkingMd {
    pub frontmatter: String,
    pub body: String,
}

impl WorkingContent {
    pub fn as_md(&self) -> Option<&WorkingMd> {
        match self {
            WorkingContent::Md(m) => Some(m),
            WorkingContent::Toml { .. } => None,
        }
    }

    pub fn as_toml(&self) -> Option<&str> {
        match self {
            WorkingContent::Toml { text } => Some(text),
            WorkingContent::Md(_) => None,
        }
    }
}

/// Read the editor payload for any primitive kind.
///
/// MD-shaped kinds (Skill/Agent/Command) parse their primary file into
/// frontmatter + body. CodexAgent reads its `<name>.toml` as raw text.
pub fn read_primitive_detail(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<PrimitiveDetail, Error> {
    let metadata_path = layout.primitive_metadata(kind, name);
    let metadata_raw = std::fs::read_to_string(&metadata_path).map_err(|source| Error::Io {
        path: metadata_path.to_string(),
        source,
    })?;
    let metadata = PrimitiveMetadata::from_yaml(&metadata_raw)?;

    let primary = layout
        .working_base(kind, name)
        .join(kind.primary_filename(name));
    let bytes = std::fs::read(&primary).map_err(|source| Error::Io {
        path: primary.to_string(),
        source,
    })?;
    let working = if kind.is_md_kind() {
        let parsed = MdPrimitive::parse(&bytes)?;
        WorkingContent::Md(WorkingMd {
            frontmatter: std::str::from_utf8(parsed.frontmatter_bytes())?.to_string(),
            body: std::str::from_utf8(parsed.body())?.to_string(),
        })
    } else {
        WorkingContent::Toml {
            text: std::str::from_utf8(&bytes)?.to_string(),
        }
    };

    let store = VersionStore::new(layout);
    let versions = store.list_versions(kind, name)?;
    let current_version = store.read_current(kind, name)?;

    Ok(PrimitiveDetail {
        kind,
        name: name.clone(),
        metadata,
        working,
        versions,
        current_version,
    })
}

/// Frozen version's contents + metadata, parsed for the editor inspector.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PrimitiveVersionView {
    pub working: WorkingContent,
    pub metadata: VersionMetadata,
}

/// Editor view of a (primitive, target) pair: materialized merged primary
/// file + a flag for whether a target overlay file shadows the base.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TargetView {
    pub working: WorkingContent,
    /// True iff `working/targets/<target>/<primary>` exists. When false,
    /// `working` is just the base content; the editor should show it
    /// read-only with an "Add overlay" affordance.
    pub has_overlay: bool,
}

/// Materialize a primitive for a specific target — base merged with any
/// target overlay. Used when the editor's target tab is selected.
pub fn read_primitive_for_target(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    target: Target,
) -> Result<TargetView, Error> {
    let metadata_path = layout.primitive_metadata(kind, name);
    let metadata_raw = std::fs::read_to_string(&metadata_path).map_err(|source| Error::Io {
        path: metadata_path.to_string(),
        source,
    })?;
    let metadata = PrimitiveMetadata::from_yaml(&metadata_raw)?;

    let wc = WorkingCopy::new(layout);
    let overlay = wc.load(kind, name)?;
    let primary = kind.primary_filename(name);
    let primary_path = Utf8Path::new(&primary);

    let has_overlay = overlay
        .targets
        .get(&target)
        .map(|m| m.contains_key(primary_path))
        .unwrap_or(false);

    let materialized = materialize(kind, name, &metadata.allowed_targets, &overlay, target)?;
    let bytes = materialized
        .files
        .get(primary_path)
        .ok_or_else(|| Error::Io {
            path: primary_path.to_string(),
            source: std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "primary file missing from materialized tree",
            ),
        })?;

    let working = if kind.is_md_kind() {
        let parsed = MdPrimitive::parse(bytes)?;
        WorkingContent::Md(WorkingMd {
            frontmatter: std::str::from_utf8(parsed.frontmatter_bytes())?.to_string(),
            body: std::str::from_utf8(parsed.body())?.to_string(),
        })
    } else {
        WorkingContent::Toml {
            text: std::str::from_utf8(bytes)?.to_string(),
        }
    };

    Ok(TargetView { working, has_overlay })
}

/// One target's overlay surface — list of relative paths (as strings, so the
/// type crosses the IPC boundary) inside `working/targets/<target>/`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OverlayList {
    pub target: Target,
    pub paths: Vec<String>,
}

/// Enumerate every target overlay's files. Targets with no overlay files
/// are omitted. Used by future inspector views and pre-publish warnings.
pub fn list_overlays(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
) -> Result<Vec<OverlayList>, Error> {
    let wc = WorkingCopy::new(layout);
    let overlay = wc.load(kind, name)?;
    let mut out = Vec::new();
    for &target in Target::ALL {
        if let Some(files) = overlay.targets.get(&target) {
            if files.is_empty() {
                continue;
            }
            let mut paths: Vec<String> = files.keys().map(|p| p.to_string()).collect();
            paths.sort();
            out.push(OverlayList { target, paths });
        }
    }
    Ok(out)
}

/// Read a frozen version's primary file + `version.yaml`, shaped for the
/// editor's inspector pane. Decodes per kind (MD vs TOML).
pub fn read_primitive_version_view(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    label: &VersionLabel,
) -> Result<PrimitiveVersionView, Error> {
    let store = VersionStore::new(layout);
    let overlay = store.read_version(kind, name, label)?;
    let primary = kind.primary_filename(name);
    let bytes = overlay
        .base
        .get(Utf8Path::new(&primary))
        .ok_or_else(|| Error::VersionNotFound(label.as_str().into()))?;
    let working = if kind.is_md_kind() {
        let parsed = MdPrimitive::parse(bytes)?;
        WorkingContent::Md(WorkingMd {
            frontmatter: std::str::from_utf8(parsed.frontmatter_bytes())?.to_string(),
            body: std::str::from_utf8(parsed.body())?.to_string(),
        })
    } else {
        WorkingContent::Toml {
            text: std::str::from_utf8(bytes)?.to_string(),
        }
    };
    let metadata = store.read_version_metadata(kind, name, label)?;
    Ok(PrimitiveVersionView { working, metadata })
}

/// Replace `working/` with the frozen version's tree exactly: write every
/// base + target overlay file from the snapshot, then delete any working
/// file that the snapshot doesn't contain. Orphan files (added since the
/// snapshot) are removed so revert is a true rewind, not a merge.
pub fn revert_primitive_to_version(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    label: &VersionLabel,
) -> Result<(), Error> {
    let store = VersionStore::new(layout);
    let snapshot = store.read_version(kind, name, label)?;
    let wc = WorkingCopy::new(layout);
    let existing = wc.load(kind, name)?;

    for (rel, bytes) in &snapshot.base {
        wc.save_base_file(kind, name, rel, bytes)?;
    }
    for (target, files) in &snapshot.targets {
        for (rel, bytes) in files {
            wc.save_target_file(kind, name, *target, rel, bytes)?;
        }
    }

    for rel in existing.base.keys() {
        if !snapshot.base.contains_key(rel) {
            wc.remove_base_file(kind, name, rel)?;
        }
    }
    for (target, files) in &existing.targets {
        let snap_files = snapshot.targets.get(target);
        for rel in files.keys() {
            let kept = snap_files.is_some_and(|m| m.contains_key(rel));
            if !kept {
                wc.remove_target_file(kind, name, *target, rel)?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold::{scaffold_primitive, scaffold_skill};
    use crate::version_store::VersionMetadata;
    use crate::WorkingCopy;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Utf8PathBuf, PrimitiveName) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let name = PrimitiveName::try_new("diagnose").unwrap();
        (tmp, root, name)
    }

    #[test]
    fn fresh_scaffold_has_empty_frontmatter_body_and_no_versions() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let d = read_primitive_detail(layout, PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(d.kind, PrimitiveKind::Skill);
        assert_eq!(d.name.as_str(), "diagnose");
        assert_eq!(d.metadata.allowed_targets, Vec::new());
        let md = d.working.as_md().expect("Skill is MD-shaped");
        assert_eq!(md.frontmatter, "");
        assert_eq!(md.body, "");
        assert_eq!(d.versions, Vec::<VersionLabel>::new());
        assert_eq!(d.current_version, None);
    }

    #[test]
    fn returns_published_versions_and_current() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        // Edit working with a real frontmatter+body
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\ndescription: hello\n---\nbody one\n",
        )
        .unwrap();

        // Publish v1
        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        store
            .snapshot(
                PrimitiveKind::Skill,
                &name,
                &v1,
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();

        let d = read_primitive_detail(layout, PrimitiveKind::Skill, &name).unwrap();
        let md = d.working.as_md().expect("Skill is MD-shaped");
        assert_eq!(md.frontmatter, "description: hello\n");
        assert_eq!(md.body, "body one\n");
        assert_eq!(
            d.versions.iter().map(|v| v.as_str()).collect::<Vec<_>>(),
            vec!["v1"]
        );
        assert_eq!(d.current_version.as_ref().map(|v| v.as_str()), Some("v1"));
    }

    #[test]
    fn reads_agent_md_kind_with_frontmatter_split() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None).unwrap();

        // Edit working agent.md
        WorkingCopy::new(layout)
            .save_base_file(
                PrimitiveKind::Agent,
                &name,
                Utf8Path::new("agent.md"),
                b"---\ndescription: x\n---\nbody\n",
            )
            .unwrap();

        let d = read_primitive_detail(layout, PrimitiveKind::Agent, &name).unwrap();
        let md = d.working.as_md().expect("Agent is MD-shaped");
        assert_eq!(md.frontmatter, "description: x\n");
        assert_eq!(md.body, "body\n");
    }

    #[test]
    fn reads_codex_agent_as_raw_toml_text() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(
            layout,
            PrimitiveKind::CodexAgent,
            &name,
            "2026-05-04T00:00:00Z",
            None,
        )
        .unwrap();

        WorkingCopy::new(layout)
            .save_base_file(
                PrimitiveKind::CodexAgent,
                &name,
                Utf8Path::new("diagnose.toml"),
                b"name = \"diagnose\"\n",
            )
            .unwrap();

        let d = read_primitive_detail(layout, PrimitiveKind::CodexAgent, &name).unwrap();
        let text = d.working.as_toml().expect("CodexAgent is TOML-shaped");
        assert_eq!(text, "name = \"diagnose\"\n");
    }

    #[test]
    fn missing_primitive_surfaces_io_error_with_path() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let err = read_primitive_detail(layout, PrimitiveKind::Skill, &name).unwrap_err();
        assert!(
            matches!(err, Error::Io { ref path, .. } if path.contains("metadata.yaml")),
            "expected Io error referencing metadata.yaml, got: {err:?}"
        );
    }

    fn publish_v(
        layout: LibraryLayout<'_>,
        name: &PrimitiveName,
        label: &str,
        body: &[u8],
        notes: Option<&str>,
    ) -> VersionLabel {
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("SKILL.md"), body)
            .unwrap();
        let store = VersionStore::new(layout);
        let v = VersionLabel::try_new(label).unwrap();
        store
            .snapshot(
                PrimitiveKind::Skill,
                name,
                &v,
                &VersionMetadata {
                    created_at: format!("2026-05-04T00:00:0{label}Z"),
                    notes: notes.map(String::from),
                },
            )
            .unwrap();
        v
    }

    #[test]
    fn read_skill_version_view_returns_frozen_content_and_metadata() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let v1 = publish_v(
            layout,
            &name,
            "v1",
            b"---\ndescription: hello\n---\nbody one\n",
            Some("first cut"),
        );

        let view =
            read_primitive_version_view(layout, PrimitiveKind::Skill, &name, &v1).unwrap();
        let md = view.working.as_md().expect("Skill is MD-shaped");
        assert_eq!(md.frontmatter, "description: hello\n");
        assert_eq!(md.body, "body one\n");
        assert_eq!(view.metadata.notes.as_deref(), Some("first cut"));
    }

    #[test]
    fn read_primitive_version_view_errors_on_unknown_label() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let label = VersionLabel::try_new("v9").unwrap();
        let err =
            read_primitive_version_view(layout, PrimitiveKind::Skill, &name, &label).unwrap_err();
        assert!(matches!(err, Error::VersionNotFound(_)), "got: {err:?}");
    }

    #[test]
    fn read_primitive_for_target_returns_base_when_no_overlay() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        // Allow Claude target
        crate::update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            crate::MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        WorkingCopy::new(layout)
            .save_base_file(
                PrimitiveKind::Skill,
                &name,
                Utf8Path::new("SKILL.md"),
                b"---\n---\nbase content\n",
            )
            .unwrap();

        let view =
            read_primitive_for_target(layout, PrimitiveKind::Skill, &name, Target::Claude).unwrap();
        assert!(!view.has_overlay);
        assert_eq!(view.working.as_md().unwrap().body, "base content\n");
    }

    #[test]
    fn read_primitive_for_target_returns_overlay_when_present() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        crate::update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &name,
            crate::MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nbase\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nclaude override\n",
        )
        .unwrap();

        let view =
            read_primitive_for_target(layout, PrimitiveKind::Skill, &name, Target::Claude).unwrap();
        assert!(view.has_overlay);
        assert_eq!(view.working.as_md().unwrap().body, "claude override\n");
    }

    #[test]
    fn read_primitive_for_target_rejects_disallowed_target() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        // No allowed_targets configured
        let err =
            read_primitive_for_target(layout, PrimitiveKind::Skill, &name, Target::Claude)
                .unwrap_err();
        assert!(matches!(err, Error::TargetNotAllowed { .. }), "got: {err:?}");
    }

    #[test]
    fn list_overlays_returns_paths_per_target() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(layout);
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nclaude\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Pi,
            Utf8Path::new("SKILL.md"),
            b"---\n---\npi\n",
        )
        .unwrap();

        let listed = list_overlays(layout, PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(listed.len(), 2);
        let claude = listed.iter().find(|o| o.target == Target::Claude).unwrap();
        assert_eq!(claude.paths, vec!["SKILL.md".to_string()]);
    }

    #[test]
    fn revert_primitive_to_version_overwrites_working_with_frozen_bytes() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let v1 = publish_v(layout, &name, "v1", b"---\n---\nv1 body\n", None);
        // Edit working past v1
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("SKILL.md"),
            b"---\n---\nv2 work-in-progress\n",
        )
        .unwrap();

        revert_primitive_to_version(layout, PrimitiveKind::Skill, &name, &v1).unwrap();
        let detail = read_primitive_detail(layout, PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(
            detail.working.as_md().expect("Skill is MD-shaped").body,
            "v1 body\n"
        );
    }

    #[test]
    fn revert_deletes_orphan_base_files_added_after_snapshot() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();

        let v1 = publish_v(layout, &name, "v1", b"---\n---\nv1 body\n", None);

        // Add a stray file to working/base/ after the snapshot
        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Skill,
            &name,
            Utf8Path::new("extra.md"),
            b"junk added after v1\n",
        )
        .unwrap();
        let stray_path = layout
            .working_base(PrimitiveKind::Skill, &name)
            .join("extra.md");
        assert!(stray_path.exists());

        revert_primitive_to_version(layout, PrimitiveKind::Skill, &name, &v1).unwrap();

        assert!(
            !stray_path.exists(),
            "orphan working/base/ file must be removed by revert",
        );
        // Snapshot file is back.
        let primary = layout
            .working_base(PrimitiveKind::Skill, &name)
            .join("SKILL.md");
        assert_eq!(std::fs::read(&primary).unwrap(), b"---\n---\nv1 body\n");
    }

    #[test]
    fn revert_deletes_orphan_target_overlay_files() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None).unwrap();

        let wc = WorkingCopy::new(layout);
        // v1 has a base file but no target overlays.
        wc.save_base_file(
            PrimitiveKind::Agent,
            &name,
            Utf8Path::new("agent.md"),
            b"---\n---\nv1 base\n",
        )
        .unwrap();
        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        store
            .snapshot(
                PrimitiveKind::Agent,
                &name,
                &v1,
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();

        // After v1: add a Claude overlay file that the snapshot doesn't contain.
        wc.save_target_file(
            PrimitiveKind::Agent,
            &name,
            Target::Claude,
            Utf8Path::new("agent.md"),
            b"---\n---\nclaude override\n",
        )
        .unwrap();
        let overlay_path = layout
            .working_target(PrimitiveKind::Agent, &name, Target::Claude)
            .join("agent.md");
        assert!(overlay_path.exists());

        revert_primitive_to_version(layout, PrimitiveKind::Agent, &name, &v1).unwrap();

        assert!(
            !overlay_path.exists(),
            "orphan working/targets/claude/ file must be removed by revert",
        );
    }

    #[test]
    fn revert_restores_target_overlay_files_from_snapshot() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None).unwrap();

        let wc = WorkingCopy::new(layout);
        wc.save_base_file(
            PrimitiveKind::Agent,
            &name,
            Utf8Path::new("agent.md"),
            b"---\n---\nbase\n",
        )
        .unwrap();
        wc.save_target_file(
            PrimitiveKind::Agent,
            &name,
            Target::Claude,
            Utf8Path::new("agent.md"),
            b"---\n---\nclaude in v1\n",
        )
        .unwrap();
        let store = VersionStore::new(layout);
        let v1 = VersionLabel::try_new("v1").unwrap();
        store
            .snapshot(
                PrimitiveKind::Agent,
                &name,
                &v1,
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();

        // Mutate: change the overlay, drop the base file.
        wc.save_target_file(
            PrimitiveKind::Agent,
            &name,
            Target::Claude,
            Utf8Path::new("agent.md"),
            b"---\n---\nedited after v1\n",
        )
        .unwrap();
        wc.remove_base_file(PrimitiveKind::Agent, &name, Utf8Path::new("agent.md"))
            .unwrap();

        revert_primitive_to_version(layout, PrimitiveKind::Agent, &name, &v1).unwrap();

        let overlay = wc.load(PrimitiveKind::Agent, &name).unwrap();
        assert_eq!(
            overlay.base[Utf8Path::new("agent.md")],
            b"---\n---\nbase\n"
        );
        assert_eq!(
            overlay.targets[&Target::Claude][Utf8Path::new("agent.md")],
            b"---\n---\nclaude in v1\n"
        );
    }
}
