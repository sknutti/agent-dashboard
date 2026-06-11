//! Seed a deterministic fixture Library for the dashboard's bridge fixtures.
//!
//!   cargo run -p prompt-library-bridge --example seed_fixture_library -- <dir>
//!
//! Builds a real `.prompt-library` tree through core's own `init_library` +
//! `scaffold_primitive` (NOT hand-authored JSON) so the captured bridge stdout
//! in `scripts/fixtures/bridge/*.json` is genuine serde output. Regenerate the
//! fixtures by re-seeding into a fresh dir and re-running the bridge against it
//! (see `scripts/fixtures/bridge/README.md`). All four Kinds are seeded, with
//! one author-bearing primitive and both Working-content shapes (md + toml).
//!
//! The timestamp is pinned so the tree is byte-stable across machines.

use camino::Utf8PathBuf;

use prompt_library_core::{
    library_init::init_library,
    scaffold::{scaffold_primitive, ScaffoldSource},
    LibraryLayout, PrimitiveKind, PrimitiveName,
};

const NOW: &str = "2026-04-30T12:00:00Z";

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: seed_fixture_library <dir>");
        std::process::exit(2);
    });
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

    println!("seeded fixture library at {root}");
}
