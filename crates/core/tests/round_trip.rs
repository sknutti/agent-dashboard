//! End-to-end round-trip: write working/ → snapshot → load version → materialize.
//!
//! Verifies the storage layer + materializer compose cleanly: bytes written
//! into `working/` survive snapshotting and re-emerge byte-equal from
//! materialization for every allowed target.

use camino::{Utf8Path, Utf8PathBuf};
use prompt_library_core::{
    detail::{
        list_overlays, read_primitive_detail, read_primitive_for_target, read_primitive_version_view,
        revert_primitive_to_version,
    },
    install as core_install, library_init::init_library, listing::list_primitives,
    scaffold::scaffold_primitive, uninstall as core_uninstall, update_primitive_metadata,
    InstallLayout, InstallPaths, InstallRequest, InstallsFile, MetadataUpdate, TargetOutcome,
    UninstallOutcome, UninstallRequest,
};
use prompt_library_core::working_files::{
    create_working_file, delete_working_file, list_working_files, read_working_file,
    rename_working_file, save_working_file, WorkingFileBytes, WorkingFileRole,
};
use prompt_library_core::{
    materialize, Error, LibraryLayout, OverlayBytes, PrimitiveKind, PrimitiveName, Target,
    VersionLabel, VersionMetadata, VersionStore, WorkingCopy,
};
use tempfile::TempDir;

const NOW: &str = "2026-04-30T12:00:00Z";
const SKILL: PrimitiveKind = PrimitiveKind::Skill;

fn fresh_layout() -> (TempDir, Utf8PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
    (tmp, root)
}

#[test]
fn skill_with_base_and_overlays_round_trips_per_target() {
    let (_tmp, root) = fresh_layout();
    let layout = LibraryLayout::new(&root);
    let wc = WorkingCopy::new(layout);
    let store = VersionStore::new(layout);
    let name = PrimitiveName::try_new("diagnose").unwrap();

    // Write base + claude + pi overlays into working/.
    let base = b"# Diagnose skill\n\nBase content shared across targets.\n";
    let claude_override = b"# Diagnose skill\n\nClaude-specific instructions.\n";
    let pi_override = b"# Diagnose skill\n\nPi-specific instructions.\n";

    wc.save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new("SKILL.md"), base)
        .unwrap();
    wc.save_target_file(
        PrimitiveKind::Skill,
        &name,
        Target::Claude,
        Utf8Path::new("SKILL.md"),
        claude_override,
    )
    .unwrap();
    wc.save_target_file(
        PrimitiveKind::Skill,
        &name,
        Target::Pi,
        Utf8Path::new("SKILL.md"),
        pi_override,
    )
    .unwrap();

    // Snapshot to v1.
    let v1 = VersionLabel::try_new("v1").unwrap();
    let meta = VersionMetadata {
        created_at: "2026-04-30T12:00:00Z".into(),
        notes: None,
    };
    store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();

    // Reload v1 from disk.
    let overlay: OverlayBytes = store
        .read_version(PrimitiveKind::Skill, &name, &v1)
        .unwrap();

    // Materialize for each target — bytes must match the originals.
    let allowed = [Target::Claude, Target::Pi, Target::Codex];

    let claude_m = materialize(
        PrimitiveKind::Skill,
        &name,
        &allowed,
        &overlay,
        Target::Claude,
    )
    .unwrap();
    assert_eq!(claude_m.files[Utf8Path::new("SKILL.md")], claude_override);

    let pi_m = materialize(PrimitiveKind::Skill, &name, &allowed, &overlay, Target::Pi).unwrap();
    assert_eq!(pi_m.files[Utf8Path::new("SKILL.md")], pi_override);

    let codex_m = materialize(
        PrimitiveKind::Skill,
        &name,
        &allowed,
        &overlay,
        Target::Codex,
    )
    .unwrap();
    assert_eq!(codex_m.files[Utf8Path::new("SKILL.md")], base);
}

#[test]
fn agent_claude_single_file_flattens_after_round_trip() {
    let (_tmp, root) = fresh_layout();
    let layout = LibraryLayout::new(&root);
    let wc = WorkingCopy::new(layout);
    let store = VersionStore::new(layout);
    let name = PrimitiveName::try_new("helper").unwrap();

    let bytes = b"# Helper agent\n\nAgent body.\n";
    wc.save_base_file(PrimitiveKind::Agent, &name, Utf8Path::new("agent.md"), bytes)
        .unwrap();

    let v1 = VersionLabel::try_new("v1").unwrap();
    let meta = VersionMetadata {
        created_at: "2026-04-30T12:00:00Z".into(),
        notes: None,
    };
    store.snapshot(PrimitiveKind::Agent, &name, &v1, &meta).unwrap();

    let overlay = store
        .read_version(PrimitiveKind::Agent, &name, &v1)
        .unwrap();
    let m = materialize(
        PrimitiveKind::Agent,
        &name,
        &[Target::Claude, Target::Pi, Target::Codex],
        &overlay,
        Target::Claude,
    )
    .unwrap();
    assert_eq!(
        m.layout,
        InstallLayout::SingleFile,
        "(Agent, Claude) with sole agent.md must flatten to SingleFile"
    );
    assert_eq!(m.files[Utf8Path::new("agent.md")], bytes);
}

#[test]
fn ds_store_dropped_on_disk_does_not_appear_in_materialization() {
    let (_tmp, root) = fresh_layout();
    let layout = LibraryLayout::new(&root);
    let wc = WorkingCopy::new(layout);
    let store = VersionStore::new(layout);
    let name = PrimitiveName::try_new("x").unwrap();

    wc.save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new("SKILL.md"), b"ok")
        .unwrap();
    // Plant a .DS_Store directly on disk inside working/base/.
    let ds = layout.working_base(PrimitiveKind::Skill, &name).join(".DS_Store");
    std::fs::write(&ds, b"junk").unwrap();

    let v1 = VersionLabel::try_new("v1").unwrap();
    let meta = VersionMetadata {
        created_at: "2026-04-30T12:00:00Z".into(),
        notes: None,
    };
    store.snapshot(PrimitiveKind::Skill, &name, &v1, &meta).unwrap();

    let overlay = store
        .read_version(PrimitiveKind::Skill, &name, &v1)
        .unwrap();
    let m = materialize(
        PrimitiveKind::Skill,
        &name,
        &[Target::Claude],
        &overlay,
        Target::Claude,
    )
    .unwrap();
    assert!(m.files.contains_key(Utf8Path::new("SKILL.md")));
    assert!(!m.files.contains_key(Utf8Path::new(".DS_Store")));
}

// --- Feature integration tests migrated from src-tauri/src/commands.rs ---
// These exercise the same core flows the Tauri command layer wraps; they
// live in core because the seam they test is core, not the IPC layer.

fn fresh_library() -> (TempDir, Utf8PathBuf) {
    let (tmp, root) = fresh_layout();
    init_library(&root, NOW).unwrap();
    (tmp, root)
}

fn name(s: &str) -> PrimitiveName {
    PrimitiveName::try_new(s).unwrap()
}

fn version(s: &str) -> VersionLabel {
    VersionLabel::try_new(s).unwrap()
}

#[test]
fn init_then_list_returns_empty() {
    let (_tmp, root) = fresh_library();
    let listed = list_primitives(LibraryLayout::new(&root)).unwrap();
    assert!(listed.is_empty());
}

#[test]
fn create_skill_then_list_includes_it() {
    let (_tmp, root) = fresh_library();
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &name("diagnose"), NOW, None).unwrap();
    let listed = list_primitives(LibraryLayout::new(&root)).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name.as_str(), "diagnose");
}

#[test]
fn read_primitive_returns_scaffolded_detail() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    assert_eq!(detail.kind, SKILL);
    let md = detail.working.as_md().expect("Skill is MD-shaped");
    assert_eq!(md.frontmatter, "");
    assert_eq!(md.body, "");
}

#[test]
fn save_working_then_read_round_trips_content() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(SKILL, &n, b"---\ndescription: hello\n---\nbody one\n")
        .unwrap();
    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    let md = detail.working.as_md().expect("Skill is MD-shaped");
    assert_eq!(md.frontmatter, "description: hello\n");
    assert_eq!(md.body, "body one\n");
}

#[test]
fn save_primary_base_rejects_broken_frontmatter() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    let err = WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(SKILL, &n, b"no frontmatter here")
        .unwrap_err();
    assert!(matches!(err, Error::MdFrontmatter(_)), "got: {err:?}");
}

#[test]
fn save_primary_base_rejects_invalid_toml_for_codex_agent() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), PrimitiveKind::CodexAgent, &n, NOW, None).unwrap();
    let err = WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(PrimitiveKind::CodexAgent, &n, b"= not valid toml")
        .unwrap_err();
    assert!(matches!(err, Error::CodexAgentParse(_)), "got: {err:?}");
}

#[test]
fn publish_creates_version_and_sets_current() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(SKILL, &n, b"---\ndescription: x\n---\nv1 body\n")
        .unwrap();
    VersionStore::new(LibraryLayout::new(&root))
        .snapshot(
            SKILL,
            &n,
            &version("v1"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: Some("first".into()),
            },
        )
        .unwrap();

    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    assert_eq!(detail.versions.len(), 1);
    assert_eq!(
        detail.current_version.as_ref().map(|l| l.as_str()),
        Some("v1")
    );
}

#[test]
fn update_metadata_replaces_allowed_targets() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();

    let updated = update_primitive_metadata(
        LibraryLayout::new(&root),
        SKILL,
        &n,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude, Target::Pi],
            display_name: Some("Diagnose".into()),
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .unwrap();
    assert_eq!(updated.allowed_targets, vec![Target::Claude, Target::Pi]);

    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    assert_eq!(
        detail.metadata.allowed_targets,
        vec![Target::Claude, Target::Pi]
    );
    assert_eq!(detail.metadata.display_name.as_deref(), Some("Diagnose"));
}

#[test]
fn read_primitive_version_returns_frozen_content() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(SKILL, &n, b"---\ndescription: hi\n---\nv1 body\n")
        .unwrap();
    let v1 = version("v1");
    VersionStore::new(LibraryLayout::new(&root))
        .snapshot(
            SKILL,
            &n,
            &v1,
            &VersionMetadata {
                created_at: NOW.into(),
                notes: Some("note".into()),
            },
        )
        .unwrap();

    let view = read_primitive_version_view(LibraryLayout::new(&root), SKILL, &n, &v1).unwrap();
    let md = view.working.as_md().expect("Skill version is MD-shaped");
    assert_eq!(md.body, "v1 body\n");
    assert_eq!(view.metadata.notes.as_deref(), Some("note"));
}

#[test]
fn revert_to_version_overwrites_working_with_frozen_bytes() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    let wc = WorkingCopy::new(LibraryLayout::new(&root));
    wc.save_primary_base(SKILL, &n, b"---\n---\nv1\n").unwrap();
    let v1 = version("v1");
    VersionStore::new(LibraryLayout::new(&root))
        .snapshot(
            SKILL,
            &n,
            &v1,
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    // Mutate working past v1
    wc.save_primary_base(SKILL, &n, b"---\n---\nWIP edits\n").unwrap();

    revert_primitive_to_version(LibraryLayout::new(&root), SKILL, &n, &v1).unwrap();
    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    let md = detail.working.as_md().expect("Skill is MD-shaped");
    assert_eq!(md.body, "v1\n");
}

#[test]
fn write_overlay_then_read_target_returns_overlay_bytes() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    update_primitive_metadata(
        LibraryLayout::new(&root),
        SKILL,
        &n,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude],
            display_name: None,
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .unwrap();
    let wc = WorkingCopy::new(LibraryLayout::new(&root));
    wc.save_primary_base(SKILL, &n, b"---\n---\nbase\n").unwrap();
    wc.save_primary_target(SKILL, &n, Target::Claude, b"---\n---\nclaude override\n")
        .unwrap();

    let view =
        read_primitive_for_target(LibraryLayout::new(&root), SKILL, &n, Target::Claude).unwrap();
    assert!(view.has_overlay);
    assert_eq!(view.working.as_md().unwrap().body, "claude override\n");

    // Now remove and confirm we fall back to base.
    wc.remove_primary_target(SKILL, &n, Target::Claude).unwrap();
    let view =
        read_primitive_for_target(LibraryLayout::new(&root), SKILL, &n, Target::Claude).unwrap();
    assert!(!view.has_overlay);
    assert_eq!(view.working.as_md().unwrap().body, "base\n");
}

#[test]
fn list_overlays_returns_empty_when_none_exist() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    let listed = list_overlays(LibraryLayout::new(&root), SKILL, &n).unwrap();
    assert!(listed.is_empty());
}

#[test]
fn codex_agent_round_trips_raw_toml_text() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), PrimitiveKind::CodexAgent, &n, NOW, None).unwrap();
    let toml = b"name = \"diagnose\"\n";
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(PrimitiveKind::CodexAgent, &n, toml)
        .unwrap();

    let detail =
        read_primitive_detail(LibraryLayout::new(&root), PrimitiveKind::CodexAgent, &n).unwrap();
    assert_eq!(detail.working.as_toml().unwrap().as_bytes(), toml);
}

#[test]
fn set_current_version_pins_back_to_older() {
    let (_tmp, root) = fresh_library();
    let n = name("diagnose");
    scaffold_primitive(LibraryLayout::new(&root), SKILL, &n, NOW, None).unwrap();
    let layout = LibraryLayout::new(&root);
    let wc = WorkingCopy::new(layout);
    let store = VersionStore::new(layout);

    // Publish v1
    wc.save_primary_base(SKILL, &n, b"---\n---\nv1\n").unwrap();
    store
        .snapshot(
            SKILL,
            &n,
            &version("v1"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    // Publish v2
    wc.save_primary_base(SKILL, &n, b"---\n---\nv2\n").unwrap();
    store
        .snapshot(
            SKILL,
            &n,
            &version("v2"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    // Pin back to v1
    store.set_current(SKILL, &n, &version("v1")).unwrap();

    let detail = read_primitive_detail(LibraryLayout::new(&root), SKILL, &n).unwrap();
    assert_eq!(
        detail.current_version.as_ref().map(|l| l.as_str()),
        Some("v1")
    );
}

#[test]
fn list_installs_for_primitive_empty_when_no_installs_file() {
    let (_tmp, root) = fresh_layout();
    let installs_path = root.join("installs.json");
    let installs = InstallsFile::load(&installs_path).unwrap();
    assert!(installs.records.is_empty());
}

#[test]
fn install_then_list_returns_installed_target() {
    let (_lib, library) = fresh_library();
    let (_home, home) = fresh_layout();
    let (_data, data) = fresh_layout();
    let installs_path = data.join("installs.json");
    let n = name("diagnose");

    scaffold_primitive(LibraryLayout::new(&library), SKILL, &n, NOW, None).unwrap();
    update_primitive_metadata(
        LibraryLayout::new(&library),
        SKILL,
        &n,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude],
            display_name: None,
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .unwrap();
    WorkingCopy::new(LibraryLayout::new(&library))
        .save_primary_base(SKILL, &n, b"---\n---\nbody\n")
        .unwrap();
    VersionStore::new(LibraryLayout::new(&library))
        .snapshot(
            SKILL,
            &n,
            &version("v1"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    let install_paths = InstallPaths::new(home.clone());
    let summary = core_install(InstallRequest {
        layout: LibraryLayout::new(&library),
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
        installed_at: NOW,
    })
    .unwrap();
    assert_eq!(summary.successes.len(), 1);
    assert!(matches!(
        summary.successes[0].outcome,
        TargetOutcome::Installed { .. }
    ));

    let installs = InstallsFile::load(&installs_path).unwrap();
    let listed: Vec<_> = installs
        .records
        .iter()
        .filter(|r| r.kind == SKILL && r.name == n)
        .collect();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].target, Target::Claude);
    assert_eq!(listed[0].installed_version.as_str(), "v1");

    // Disk has the file.
    assert!(home.join(".claude/skills/diagnose/SKILL.md").exists());
}

#[test]
fn install_without_pinned_version_returns_no_current_version_error() {
    let (_lib, library) = fresh_library();
    let (_home, home) = fresh_layout();
    let (_data, data) = fresh_layout();
    let installs_path = data.join("installs.json");
    let n = name("diagnose");

    scaffold_primitive(LibraryLayout::new(&library), SKILL, &n, NOW, None).unwrap();
    // No publish.

    let install_paths = InstallPaths::new(home);
    let err = core_install(InstallRequest {
        layout: LibraryLayout::new(&library),
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
        installed_at: NOW,
    })
    .unwrap_err();
    assert!(
        matches!(err, Error::NoCurrentVersionForInstall),
        "got: {err:?}"
    );
}

#[test]
fn uninstall_after_install_drops_record_and_removes_disk() {
    let (_lib, library) = fresh_library();
    let (_home, home) = fresh_layout();
    let (_data, data) = fresh_layout();
    let installs_path = data.join("installs.json");
    let n = name("diagnose");

    scaffold_primitive(LibraryLayout::new(&library), SKILL, &n, NOW, None).unwrap();
    update_primitive_metadata(
        LibraryLayout::new(&library),
        SKILL,
        &n,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude],
            display_name: None,
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .unwrap();
    WorkingCopy::new(LibraryLayout::new(&library))
        .save_primary_base(SKILL, &n, b"---\n---\nx\n")
        .unwrap();
    VersionStore::new(LibraryLayout::new(&library))
        .snapshot(
            SKILL,
            &n,
            &version("v1"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    let install_paths = InstallPaths::new(home.clone());
    core_install(InstallRequest {
        layout: LibraryLayout::new(&library),
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
        installed_at: NOW,
    })
    .unwrap();

    let summary = core_uninstall(UninstallRequest {
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
    })
    .unwrap();
    assert_eq!(summary.successes.len(), 1);
    assert!(matches!(
        summary.successes[0].outcome,
        UninstallOutcome::Removed
    ));

    // Disk gone, record gone.
    assert!(!home.join(".claude/skills/diagnose").exists());
    let installs = InstallsFile::load(&installs_path).unwrap();
    assert!(installs.records.is_empty());
}

#[test]
fn ref_file_crud_round_trip_returns_to_baseline() {
    let (_tmp, root) = fresh_library();
    let layout = LibraryLayout::new(&root);
    let n = name("diagnose");
    scaffold_primitive(layout, SKILL, &n, NOW, None).unwrap();

    // Baseline: only the primary file.
    let baseline = list_working_files(layout, SKILL, &n).unwrap();
    assert_eq!(baseline.len(), 1);
    assert_eq!(baseline[0].path, "SKILL.md");
    assert_eq!(baseline[0].role, WorkingFileRole::Primary);

    // Create a nested ref file via path-as-name.
    create_working_file(
        layout,
        SKILL,
        &n,
        Utf8Path::new("notes/intro.md"),
        "# Intro\n",
    )
    .unwrap();
    let listed = list_working_files(layout, SKILL, &n).unwrap();
    assert_eq!(
        listed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["SKILL.md", "notes/intro.md"],
    );

    // Read it back as text with extension.
    match read_working_file(layout, SKILL, &n, Utf8Path::new("notes/intro.md")).unwrap() {
        WorkingFileBytes::Text { text, ext } => {
            assert_eq!(text, "# Intro\n");
            assert_eq!(ext.as_deref(), Some("md"));
        }
        other => panic!("expected text, got {other:?}"),
    }

    // Save updates content.
    save_working_file(
        layout,
        SKILL,
        &n,
        Utf8Path::new("notes/intro.md"),
        "# Intro v2\n",
    )
    .unwrap();
    match read_working_file(layout, SKILL, &n, Utf8Path::new("notes/intro.md")).unwrap() {
        WorkingFileBytes::Text { text, .. } => assert_eq!(text, "# Intro v2\n"),
        other => panic!("expected text, got {other:?}"),
    }

    // Rename moves file across folders.
    rename_working_file(
        layout,
        SKILL,
        &n,
        Utf8Path::new("notes/intro.md"),
        Utf8Path::new("docs/intro.md"),
    )
    .unwrap();
    let after_rename = list_working_files(layout, SKILL, &n).unwrap();
    assert_eq!(
        after_rename
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        vec!["SKILL.md", "docs/intro.md"],
    );

    // Delete returns us to baseline.
    delete_working_file(layout, SKILL, &n, Utf8Path::new("docs/intro.md")).unwrap();
    let final_listed = list_working_files(layout, SKILL, &n).unwrap();
    assert_eq!(final_listed.len(), 1);
    assert_eq!(final_listed[0].path, "SKILL.md");
}

#[test]
fn published_ref_file_round_trips_through_install_and_uninstall() {
    // P11 acceptance criterion — published versions, installs, and drift
    // detection all carry ref files through the existing pipeline. No
    // materializer or installer changes were made for ref files; this
    // test guards against accidentally regressing that.
    let (_lib, library) = fresh_library();
    let (_home, home) = fresh_layout();
    let (_data, data) = fresh_layout();
    let installs_path = data.join("installs.json");
    let n = name("diagnose");

    scaffold_primitive(LibraryLayout::new(&library), SKILL, &n, NOW, None).unwrap();
    update_primitive_metadata(
        LibraryLayout::new(&library),
        SKILL,
        &n,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude],
            display_name: None,
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .unwrap();

    // Primary plus a nested ref file. Both go into v1 via the snapshot
    // route the editor uses (through the working/base/ tree).
    let wc = WorkingCopy::new(LibraryLayout::new(&library));
    wc.save_primary_base(SKILL, &n, b"---\n---\nprimary body\n")
        .unwrap();
    wc.save_base_file(
        SKILL,
        &n,
        Utf8Path::new("notes/intro.md"),
        b"# Notes\n\nHelper bytes.\n",
    )
    .unwrap();

    VersionStore::new(LibraryLayout::new(&library))
        .snapshot(
            SKILL,
            &n,
            &version("v1"),
            &VersionMetadata {
                created_at: NOW.into(),
                notes: None,
            },
        )
        .unwrap();

    // The version snapshot stores ref files under the same overlay shape
    // as the primary file.
    let snapshot_ref = library
        .join("skills")
        .join("diagnose")
        .join("versions")
        .join("v1")
        .join("base")
        .join("notes")
        .join("intro.md");
    assert!(
        snapshot_ref.exists(),
        "ref file must be captured in the version snapshot at {snapshot_ref}",
    );

    // Install: primary + ref file land together at the install root.
    let install_paths = InstallPaths::new(home.clone());
    core_install(InstallRequest {
        layout: LibraryLayout::new(&library),
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
        installed_at: NOW,
    })
    .unwrap();

    let installed_primary = home.join(".claude/skills/diagnose/SKILL.md");
    let installed_ref = home.join(".claude/skills/diagnose/notes/intro.md");
    assert!(installed_primary.exists());
    assert!(
        installed_ref.exists(),
        "ref file must install alongside the primary at {installed_ref}",
    );
    assert_eq!(
        std::fs::read(&installed_ref).unwrap(),
        b"# Notes\n\nHelper bytes.\n",
    );

    // Uninstall removes both — no orphaned ref files left behind.
    core_uninstall(UninstallRequest {
        install_paths: &install_paths,
        installs_file_path: &installs_path,
        kind: SKILL,
        name: &n,
        targets: &[Target::Claude],
        force: false,
    })
    .unwrap();
    assert!(!installed_primary.exists());
    assert!(!installed_ref.exists());
    assert!(!home.join(".claude/skills/diagnose").exists());
}

#[test]
fn list_working_files_surfaces_primary_and_ref_files_after_scaffold() {
    let (_tmp, root) = fresh_library();
    let layout = LibraryLayout::new(&root);
    let n = name("diagnose");
    scaffold_primitive(layout, SKILL, &n, NOW, None).unwrap();

    // Scaffold plants SKILL.md only.
    let listed = list_working_files(layout, SKILL, &n).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, "SKILL.md");
    assert_eq!(listed[0].role, WorkingFileRole::Primary);

    // Adding a ref file via WorkingCopy puts it under working/base/ where
    // list_working_files can pick it up.
    let wc = WorkingCopy::new(layout);
    wc.save_base_file(SKILL, &n, Utf8Path::new("notes/intro.md"), b"# notes\n")
        .unwrap();

    let listed = list_working_files(layout, SKILL, &n).unwrap();
    let paths: Vec<_> = listed.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["SKILL.md", "notes/intro.md"],
        "primary pinned first, refs alphabetical",
    );
    assert_eq!(listed[1].role, WorkingFileRole::Ref);
    assert!(listed[1].is_text);
}
