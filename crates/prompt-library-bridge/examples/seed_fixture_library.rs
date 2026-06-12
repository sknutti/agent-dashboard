//! Seed a deterministic fixture Library for the dashboard's bridge fixtures.
//!
//!   cargo run -p prompt-library-bridge --example seed_fixture_library -- <dir> [publish]
//!
//! Builds a real `.prompt-library` tree through core's own `init_library` +
//! `scaffold_primitive` (NOT hand-authored JSON) so the captured bridge stdout
//! in `scripts/fixtures/bridge/*.json` is genuine serde output. Regenerate the
//! fixtures by re-seeding into a fresh dir and re-running the bridge against it
//! (see `scripts/fixtures/bridge/README.md`). All four Kinds are seeded, with
//! one author-bearing primitive and both Working-content shapes (md + toml).
//!
//! With the optional `publish` arg, the `diagnose` skill is additionally
//! published (allowed_targets set + snapshotted as `v1`) so it is INSTALLABLE.
//! `capture.ts` seeds a SEPARATE lib with `publish` to capture the write-side
//! fixtures (install/uninstall/scan_drift/list_installs); the read fixtures come
//! from a publish-free seed, so this never perturbs them.
//!
//! With the optional `working` arg, the `diagnose` skill's `working/base/` is
//! seeded with a DETERMINISTIC bundle — a fixed primary (`SKILL.md`), one text
//! ref (`notes.md`), and one binary ref (`logo.bin`, NUL-bearing) — for the
//! working-file fixtures (`list_working_files`, `read_working_file_{text,binary}`).
//! These bytes are byte-identical to the bridge's own `working_fixture()` golden
//! test, so the committed JSON is drift-safe on BOTH sides. Captured in its own
//! SEPARATE lib, so it never perturbs the read/write fixtures.
//!
//! The timestamp is pinned so the tree is byte-stable across machines.

use camino::{Utf8Path, Utf8PathBuf};

use prompt_library_core::{
    library_init::init_library,
    scaffold::{scaffold_primitive, ScaffoldSource},
    update_primitive_metadata, LibraryLayout, MetadataUpdate, PrimitiveKind, PrimitiveName, Target,
    VersionLabel, VersionMetadata, VersionStore, WorkingCopy,
};

const NOW: &str = "2026-04-30T12:00:00Z";

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: seed_fixture_library <dir> [publish]");
        std::process::exit(2);
    });
    let mode = std::env::args().nth(2);
    let publish = mode.as_deref() == Some("publish");
    let working = mode.as_deref() == Some("working");
    let root = Utf8PathBuf::from(dir);
    std::fs::create_dir_all(&root).expect("create fixture dir");

    init_library(&root, NOW).expect("init_library");

    // A Skill carrying author + source_url attribution (covers the optional
    // metadata fields that are skip_serializing_if-None elsewhere).
    let diagnose = PrimitiveName::try_new("diagnose").unwrap();
    scaffold_primitive(
        LibraryLayout::new(&root),
        PrimitiveKind::Skill,
        &diagnose,
        NOW,
        Some(ScaffoldSource {
            content: b"---\ndisplay_name: Diagnose\n---\n# Diagnose\n\nReproduce, minimise, fix.\n",
            source_url: "https://example.com/skills/diagnose",
            author: Some("Ada Lovelace"),
            ref_files: &[],
        }),
    )
    .expect("scaffold diagnose skill");

    // The remaining three Kinds, scaffolded empty (author null, not dirty) —
    // enough to pin each Kind's list-summary + the toml Working-content shape.
    for (kind, name) in [
        (PrimitiveKind::Agent, "reviewer"),
        (PrimitiveKind::Command, "deploy"),
        (PrimitiveKind::CodexAgent, "code-gen"),
    ] {
        let n = PrimitiveName::try_new(name).unwrap();
        scaffold_primitive(LibraryLayout::new(&root), kind, &n, NOW, None)
            .unwrap_or_else(|e| panic!("scaffold {name}: {e}"));
    }

    if publish {
        publish_diagnose(&root, &diagnose);
    }
    if working {
        seed_working_bundle(&root, &diagnose);
    }

    println!("seeded fixture library at {root}");
}

/// Seed `diagnose`'s `working/base/` with a fixed bundle for the working-file
/// fixtures: a deterministic primary, one text ref, one binary ref. The bytes
/// are byte-identical to the bridge's `working_fixture()` golden test, so the
/// committed `list_working_files`/`read_working_file_{text,binary}` JSON is
/// asserted from both directions.
fn seed_working_bundle(root: &Utf8Path, name: &PrimitiveName) {
    let wc = WorkingCopy::new(LibraryLayout::new(root));
    // Overwrite the scaffolded primary with content-stable bytes (independent of
    // scaffold internals), matching the golden test exactly.
    wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("SKILL.md"), b"---\n---\nbody\n")
        .expect("seed primary");
    wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("notes.md"), b"hello\n")
        .expect("seed text ref");
    // NUL in the first 8 KiB → git's "binary" heuristic → read returns size only.
    wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new("logo.bin"), &[0xFFu8, 0x00, 0x01, 0x02])
        .expect("seed binary ref");
}

/// Make `diagnose` installable: set its allowed_targets and snapshot the current
/// working copy as `v1` (writes `current.txt`). Mirrors core's own
/// `published_skill` test helper so `install` has a pinned version to deploy.
fn publish_diagnose(root: &Utf8Path, name: &PrimitiveName) {
    let layout = LibraryLayout::new(root);
    // Re-anchor the working copy through a base-file save so the snapshot has a
    // deterministic, content-stable overlay (independent of scaffold internals).
    WorkingCopy::new(layout)
        .save_base_file(
            PrimitiveKind::Skill,
            name,
            Utf8Path::new("SKILL.md"),
            b"---\ndisplay_name: Diagnose\n---\n# Diagnose\n\nReproduce, minimise, fix.\n",
        )
        .expect("save diagnose base file");
    update_primitive_metadata(
        layout,
        PrimitiveKind::Skill,
        name,
        MetadataUpdate {
            allowed_targets: vec![Target::Claude, Target::Pi],
            display_name: None,
            author: None,
            discard_orphan_overlays: false,
        },
    )
    .expect("set diagnose allowed_targets");
    VersionStore::new(layout)
        .snapshot(
            PrimitiveKind::Skill,
            name,
            &VersionLabel::try_new("v1").unwrap(),
            &VersionMetadata { created_at: NOW.into(), notes: None },
        )
        .expect("snapshot diagnose v1");
}
