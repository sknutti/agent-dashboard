//! P5.2: Bootstrap cross-reference — classify each [`DedupeGroup`] against
//! the existing library so the wizard can render
//! `Found N: A already, B drifted, C new`.
//!
//! Compares the source bundle (re-read from disk, canonicalized to the
//! library layout) against the library's current-version `base/` content.
//! Per-file blake3 hash maps; equality on the maps determines
//! `AlreadyImported` vs `Drifted`. `NeedsManualReview` flows through.
//!
//! Why re-read the source instead of reusing the scanner's `content_hash`:
//! the library normalizes layout at import time (e.g. (Agent, Claude) flat
//! `<name>.md` lands as `agent.md`). The scanner's hash captures source-form
//! bytes; cross-reference needs library-form bytes. One small fresh walk
//! per group at bootstrap time is cheaper than threading canonicalization
//! through every classifier.

use std::collections::HashMap;

use camino::Utf8PathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::fs_helpers::walk_into;
use crate::{
    overlay_merge, DedupeContent, DedupeGroup, DedupeOutput, Error, LibraryLayout,
    ManualReviewGroup, PrimitiveKind, PrimitiveName, SymlinkedItem, Target, UnclassifiedItem,
    VersionStore,
};

/// Output of cross-referencing dedupe groups against the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CrossReferenced {
    /// Groups the wizard can route to import/skip/reimport actions.
    pub groups: Vec<ClassifiedGroup>,
    /// `(kind, name)` groups whose every member failed to parse — pass-through
    /// from [`DedupeOutput`]; cross-reference doesn't second-guess them.
    pub needs_manual_review: Vec<ManualReviewGroup>,
    pub symlinked: Vec<SymlinkedItem>,
    pub unclassified: Vec<UnclassifiedItem>,
}

/// One dedupe group, classified against the library's current state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ClassifiedGroup {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub classification: Classification,
}

/// Variant data for a [`ClassifiedGroup`]. Carries no `(kind, name)` —
/// those fields are lifted to the outer struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum Classification {
    /// No primitive at `(kind, name)` in the library — wizard proposes a
    /// fresh import.
    New { content: DedupeContent },
    /// Library has this primitive and its current-version `base/` content
    /// matches the source bundle byte-for-byte. Wizard silently links it.
    AlreadyImported,
    /// Library has the primitive but at least one source target's content
    /// differs from the library's EFFECTIVE content for that target (base
    /// merged with the target's overlay). Wizard routes to `Re-import as new
    /// version`. `drifted_targets` names exactly the targets that diverge so
    /// the wizard can say "claude overlay drifted" rather than just "drifted".
    Drifted {
        content: DedupeContent,
        drifted_targets: Vec<Target>,
    },
}

/// Counts for the wizard's "Found N candidates: A already, B drifted, C new" banner.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CrossReferenceSummary {
    pub new: u32,
    pub already_imported: u32,
    pub drifted: u32,
    pub needs_manual_review: u32,
}

impl CrossReferenced {
    pub fn summary(&self) -> CrossReferenceSummary {
        let mut s = CrossReferenceSummary::default();
        for g in &self.groups {
            match g.classification {
                Classification::New { .. } => s.new += 1,
                Classification::AlreadyImported => s.already_imported += 1,
                Classification::Drifted { .. } => s.drifted += 1,
            }
        }
        s.needs_manual_review = self.needs_manual_review.len() as u32;
        s
    }
}

/// Classify every [`DedupeGroup`] against the library at `layout`.
///
/// Reads `current.txt` + `versions/<current>/base/` per group; non-existent
/// primitives short-circuit to `New` without further I/O. `Symlinked`,
/// `Unclassified`, and `needs_manual_review` flow through unchanged.
pub fn cross_reference(
    output: DedupeOutput,
    layout: LibraryLayout<'_>,
) -> Result<CrossReferenced, Error> {
    let store = VersionStore::new(layout);
    let groups = output
        .groups
        .into_iter()
        .map(|g| classify_one(g, &store))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CrossReferenced {
        groups,
        needs_manual_review: output.needs_manual_review,
        symlinked: output.symlinked,
        unclassified: output.unclassified,
    })
}

fn classify_one(
    group: DedupeGroup,
    store: &VersionStore<'_>,
) -> Result<ClassifiedGroup, Error> {
    let DedupeGroup { kind, name, content } = group;

    let current = store.read_current(kind, &name)?;
    let Some(label) = current else {
        return Ok(ClassifiedGroup {
            kind,
            name,
            classification: Classification::New { content },
        });
    };

    // Compare each source target against the library's EFFECTIVE content for
    // that target (base merged with the target's overlay), not against `base`
    // alone. A primitive whose targets legitimately diverge (e.g. a claude
    // copy with an extra paragraph + an unmodified codex copy) is modelled in
    // the library as base + per-target overlays; comparing one source bundle
    // against `base` only would phantom-flag it as drifted forever.
    let library = store.read_version(kind, &name, &label)?;
    let mut drifted_targets = Vec::new();
    for (target, source_path) in source_targets(&content) {
        let source = read_source_canonicalized(kind, &name, source_path)?;
        let effective = overlay_merge::merge(&library, target);
        if !hashes_equal(&effective, &source) {
            drifted_targets.push(target);
        }
    }

    let classification = if drifted_targets.is_empty() {
        Classification::AlreadyImported
    } else {
        Classification::Drifted {
            content,
            drifted_targets,
        }
    };
    Ok(ClassifiedGroup {
        kind,
        name,
        classification,
    })
}

/// Every `(target, source_path)` pair in a dedupe group: the base candidate
/// plus any overlay candidates. The base is the deduper's pick (by file
/// count / mtime / priority), which need not match the library's stored base
/// target — that mismatch is exactly why we compare per-target.
fn source_targets(content: &DedupeContent) -> Vec<(Target, &camino::Utf8Path)> {
    match content {
        DedupeContent::Identical { base } => vec![(base.target, base.source_path.as_path())],
        DedupeContent::Differs { base, overlays } => {
            let mut out = vec![(base.target, base.source_path.as_path())];
            out.extend(overlays.iter().map(|o| (o.target, o.source_path.as_path())));
            out
        }
    }
}

/// Read the source bundle at `path` and canonicalize relpaths to the
/// library's working/base/ layout. Single-file sources land under
/// `kind.primary_filename(name)`; dir-form sources keep their relative
/// layout.
fn read_source_canonicalized(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    path: &camino::Utf8Path,
) -> Result<HashMap<Utf8PathBuf, Vec<u8>>, Error> {
    let meta = std::fs::metadata(path.as_std_path()).map_err(|source| Error::Io {
        path: path.to_string(),
        source,
    })?;

    let mut out = HashMap::new();
    if meta.is_file() {
        let bytes = std::fs::read(path.as_std_path()).map_err(|source| Error::Io {
            path: path.to_string(),
            source,
        })?;
        out.insert(Utf8PathBuf::from(kind.primary_filename(name)), bytes);
    } else {
        walk_into(path, path, &mut out)?;
    }
    Ok(out)
}

fn hashes_equal(a: &HashMap<Utf8PathBuf, Vec<u8>>, b: &HashMap<Utf8PathBuf, Vec<u8>>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (k, v) in a {
        match b.get(k) {
            Some(other) if other == v => {}
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BaseAssignment, VersionLabel, VersionMetadata, WorkingCopy};
    use camino::Utf8Path;
    use tempfile::TempDir;

    fn make_layout(root: &Utf8Path) -> LibraryLayout<'_> {
        LibraryLayout::new(root)
    }

    /// Publish a primitive with the given base files at v1 + set current.
    fn publish_v1(
        layout: LibraryLayout<'_>,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        base: &[(&str, &[u8])],
    ) {
        let working = WorkingCopy::new(layout);
        for (rel, bytes) in base {
            working
                .save_base_file(kind, name, Utf8Path::new(rel), bytes)
                .unwrap();
        }
        let label = VersionLabel::try_new("v1").unwrap();
        let meta = VersionMetadata {
            created_at: "2026-05-05T00:00:00Z".into(),
            notes: None,
        };
        VersionStore::new(layout)
            .snapshot(kind, name, &label, &meta)
            .unwrap();
    }

    /// Write a source bundle (single-file or dir) under `home`, return the
    /// path the scanner would emit as the candidate's source_path.
    fn write_source_dir(
        home: &Utf8Path,
        rel_dir: &str,
        files: &[(&str, &[u8])],
    ) -> Utf8PathBuf {
        let dir = home.join(rel_dir);
        std::fs::create_dir_all(dir.as_std_path()).unwrap();
        for (rel, bytes) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap().as_std_path()).unwrap();
            std::fs::write(p.as_std_path(), bytes).unwrap();
        }
        dir
    }

    fn write_source_file(home: &Utf8Path, rel: &str, bytes: &[u8]) -> Utf8PathBuf {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap().as_std_path()).unwrap();
        std::fs::write(p.as_std_path(), bytes).unwrap();
        p
    }

    fn identical_group(kind: PrimitiveKind, name: PrimitiveName, source_path: Utf8PathBuf) -> DedupeGroup {
        DedupeGroup {
            kind,
            name,
            content: DedupeContent::Identical {
                base: BaseAssignment {
                    target: Target::Claude,
                    source_path,
                    parse: crate::ParseStatus::Parsed,
                },
            },
        }
    }

    /// Publish a primitive at v1 with base files PLUS one target overlay,
    /// modelling a multi-target primitive whose targets diverge.
    fn publish_v1_with_overlay(
        layout: LibraryLayout<'_>,
        kind: PrimitiveKind,
        name: &PrimitiveName,
        base: &[(&str, &[u8])],
        overlay_target: Target,
        overlay: &[(&str, &[u8])],
    ) {
        let working = WorkingCopy::new(layout);
        for (rel, bytes) in base {
            working
                .save_base_file(kind, name, Utf8Path::new(rel), bytes)
                .unwrap();
        }
        for (rel, bytes) in overlay {
            working
                .save_target_file(kind, name, overlay_target, Utf8Path::new(rel), bytes)
                .unwrap();
        }
        let label = VersionLabel::try_new("v1").unwrap();
        let meta = VersionMetadata {
            created_at: "2026-05-05T00:00:00Z".into(),
            notes: None,
        };
        VersionStore::new(layout)
            .snapshot(kind, name, &label, &meta)
            .unwrap();
    }

    /// A `Differs` dedupe group: one base candidate + N overlay candidates,
    /// each `(target, source_path)`.
    fn differs_group(
        kind: PrimitiveKind,
        name: PrimitiveName,
        base: (Target, Utf8PathBuf),
        overlays: Vec<(Target, Utf8PathBuf)>,
    ) -> DedupeGroup {
        DedupeGroup {
            kind,
            name,
            content: DedupeContent::Differs {
                base: BaseAssignment {
                    target: base.0,
                    source_path: base.1,
                    parse: crate::ParseStatus::Parsed,
                },
                overlays: overlays
                    .into_iter()
                    .map(|(t, p)| crate::OverlayCandidate {
                        target: t,
                        source_path: p,
                        parse: crate::ParseStatus::Parsed,
                    })
                    .collect(),
            },
        }
    }

    fn dedupe_output_with(groups: Vec<DedupeGroup>) -> DedupeOutput {
        DedupeOutput {
            groups,
            needs_manual_review: vec![],
            symlinked: vec![],
            unclassified: vec![],
        }
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = make_layout(&root);
        let out = cross_reference(dedupe_output_with(vec![]), layout).unwrap();
        assert!(out.groups.is_empty());
        assert!(out.symlinked.is_empty());
        assert!(out.unclassified.is_empty());
        assert!(out.needs_manual_review.is_empty());
    }

    #[test]
    fn primitive_absent_from_library_is_new() {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = make_layout(&root);
        let nm = PrimitiveName::try_new("diagnose").unwrap();
        let group = identical_group(
            PrimitiveKind::Skill,
            nm.clone(),
            Utf8PathBuf::from("/x/.claude/skills/diagnose"),
        );
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        let g = &out.groups[0];
        assert_eq!(g.kind, PrimitiveKind::Skill);
        assert_eq!(g.name, nm);
        assert!(matches!(g.classification, Classification::New { .. }));
    }

    #[test]
    fn skill_with_matching_base_is_already_imported() {
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("diagnose").unwrap();
        let body = b"---\ndescription: shared\n---\nbody\n";
        publish_v1(layout, PrimitiveKind::Skill, &nm, &[("SKILL.md", body)]);

        let source = write_source_dir(&home, ".claude/skills/diagnose", &[("SKILL.md", body)]);
        let group = identical_group(PrimitiveKind::Skill, nm.clone(), source);
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        let g = &out.groups[0];
        assert_eq!(g.name, nm);
        assert!(matches!(g.classification, Classification::AlreadyImported));
    }

    #[test]
    fn multi_target_skill_with_matching_overlays_is_already_imported() {
        // The `improve` regression: a skill installed to two targets with
        // divergent content. The library models it as base (codex content) +
        // a claude overlay (claude content). Both source targets match their
        // EFFECTIVE library content (base merged with the per-target overlay),
        // so the group is AlreadyImported — not phantom-Drifted just because
        // the deduper's base pick (claude) differs from the library's stored
        // base target (codex).
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("improve").unwrap();
        let codex_body = b"---\n---\nshared base\n";
        let claude_body = b"---\n---\nshared base\nscope note\n";
        publish_v1_with_overlay(
            layout,
            PrimitiveKind::Skill,
            &nm,
            &[("SKILL.md", codex_body)],
            Target::Claude,
            &[("SKILL.md", claude_body)],
        );

        // Deduper picks claude as base (e.g. newer mtime); codex is an overlay
        // candidate. Both diverge from each other, but each matches the
        // library's effective content for its target.
        let claude_src =
            write_source_dir(&home, ".claude/skills/improve", &[("SKILL.md", claude_body)]);
        let codex_src =
            write_source_dir(&home, ".codex/skills/improve", &[("SKILL.md", codex_body)]);
        let group = differs_group(
            PrimitiveKind::Skill,
            nm,
            (Target::Claude, claude_src),
            vec![(Target::Codex, codex_src)],
        );
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        assert!(
            matches!(out.groups[0].classification, Classification::AlreadyImported),
            "expected AlreadyImported, got {:?}",
            out.groups[0].classification
        );
    }

    #[test]
    fn multi_target_drift_names_only_the_diverged_target() {
        // Library: base (codex) + claude overlay. Source: codex still matches
        // base, but the claude copy was edited further so it no longer matches
        // the library's effective claude content. Only claude should be named.
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("improve").unwrap();
        let codex_body = b"---\n---\nshared base\n";
        let claude_body = b"---\n---\nshared base\nscope note\n";
        publish_v1_with_overlay(
            layout,
            PrimitiveKind::Skill,
            &nm,
            &[("SKILL.md", codex_body)],
            Target::Claude,
            &[("SKILL.md", claude_body)],
        );

        let claude_src = write_source_dir(
            &home,
            ".claude/skills/improve",
            &[("SKILL.md", b"---\n---\nshared base\nscope note\nEDITED AGAIN\n")],
        );
        let codex_src =
            write_source_dir(&home, ".codex/skills/improve", &[("SKILL.md", codex_body)]);
        let group = differs_group(
            PrimitiveKind::Skill,
            nm,
            (Target::Claude, claude_src),
            vec![(Target::Codex, codex_src)],
        );
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        match &out.groups[0].classification {
            Classification::Drifted { drifted_targets, .. } => {
                assert_eq!(drifted_targets, &vec![Target::Claude]);
            }
            other => panic!("expected Drifted, got {other:?}"),
        }
    }

    #[test]
    fn skill_with_diverging_base_is_drifted() {
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("diagnose").unwrap();
        publish_v1(
            layout,
            PrimitiveKind::Skill,
            &nm,
            &[("SKILL.md", b"---\n---\nlibrary version\n")],
        );
        let source = write_source_dir(
            &home,
            ".claude/skills/diagnose",
            &[("SKILL.md", b"---\n---\nedited locally\n")],
        );
        let group = identical_group(PrimitiveKind::Skill, nm, source);
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        assert!(matches!(
            out.groups[0].classification,
            Classification::Drifted { .. }
        ));
    }

    #[test]
    fn skill_with_extra_file_in_source_is_drifted() {
        // Source has SKILL.md identical to library + an extra README.md.
        // Extra file in source dir → Drifted (file_count differs).
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("diagnose").unwrap();
        let body = b"---\n---\nshared\n";
        publish_v1(layout, PrimitiveKind::Skill, &nm, &[("SKILL.md", body)]);
        let source = write_source_dir(
            &home,
            ".claude/skills/diagnose",
            &[("SKILL.md", body), ("README.md", b"new helper")],
        );
        let group = identical_group(PrimitiveKind::Skill, nm, source);
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        assert!(matches!(
            out.groups[0].classification,
            Classification::Drifted { .. }
        ));
    }

    #[test]
    fn agent_claude_flat_source_matches_library_agent_md() {
        // Library has Agent "helper" with base/agent.md = bytes B. Source
        // is flat-form ~/.claude/agents/helper.md with bytes B. Filenames
        // differ ("helper.md" on source, "agent.md" in library) but bytes
        // match → AlreadyImported.
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let nm = PrimitiveName::try_new("helper").unwrap();
        let body = b"---\n---\nflat agent body\n";
        publish_v1(layout, PrimitiveKind::Agent, &nm, &[("agent.md", body)]);
        let source = write_source_file(&home, ".claude/agents/helper.md", body);
        let group = identical_group(PrimitiveKind::Agent, nm, source);
        let out = cross_reference(dedupe_output_with(vec![group]), layout).unwrap();
        assert!(matches!(
            out.groups[0].classification,
            Classification::AlreadyImported
        ));
    }

    #[test]
    fn summary_counts_each_classification_bucket() {
        let tmp = TempDir::new().unwrap();
        let lib_root = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib_root.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let layout = make_layout(&lib_root);

        let kept = PrimitiveName::try_new("kept").unwrap();
        let kept_body = b"---\n---\nkept\n";
        publish_v1(layout, PrimitiveKind::Skill, &kept, &[("SKILL.md", kept_body)]);
        let drifted_name = PrimitiveName::try_new("drifted").unwrap();
        publish_v1(
            layout,
            PrimitiveKind::Skill,
            &drifted_name,
            &[("SKILL.md", b"---\n---\nlibrary\n")],
        );

        let kept_src = write_source_dir(&home, ".claude/skills/kept", &[("SKILL.md", kept_body)]);
        let drifted_src = write_source_dir(
            &home,
            ".claude/skills/drifted",
            &[("SKILL.md", b"---\n---\nedited\n")],
        );
        let new_src = write_source_dir(
            &home,
            ".claude/skills/fresh",
            &[("SKILL.md", b"---\n---\nbrand new\n")],
        );

        let groups = vec![
            identical_group(PrimitiveKind::Skill, kept, kept_src),
            identical_group(PrimitiveKind::Skill, drifted_name, drifted_src),
            identical_group(
                PrimitiveKind::Skill,
                PrimitiveName::try_new("fresh").unwrap(),
                new_src,
            ),
        ];
        let needs_manual_review = vec![ManualReviewGroup {
            kind: PrimitiveKind::Skill,
            name: PrimitiveName::try_new("broken").unwrap(),
            members: vec![],
        }];
        let out = cross_reference(
            DedupeOutput {
                groups,
                needs_manual_review,
                symlinked: vec![],
                unclassified: vec![],
            },
            layout,
        )
        .unwrap();
        let s = out.summary();
        assert_eq!(s.already_imported, 1);
        assert_eq!(s.drifted, 1);
        assert_eq!(s.new, 1);
        assert_eq!(s.needs_manual_review, 1);
    }

    #[test]
    fn needs_manual_review_passes_through_unchanged() {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let layout = make_layout(&root);
        let nm = PrimitiveName::try_new("broken").unwrap();
        let manual = ManualReviewGroup {
            kind: PrimitiveKind::Skill,
            name: nm.clone(),
            members: vec![crate::MemberInfo {
                target: Target::Claude,
                source_path: Utf8PathBuf::from("/x/.claude/skills/broken"),
                parse: crate::ParseStatus::Unparseable {
                    reason: "no fm".into(),
                },
            }],
        };
        let out = cross_reference(
            DedupeOutput {
                groups: vec![],
                needs_manual_review: vec![manual],
                symlinked: vec![],
                unclassified: vec![],
            },
            layout,
        )
        .unwrap();
        assert_eq!(out.needs_manual_review.len(), 1);
        assert_eq!(out.needs_manual_review[0].name, nm);
        assert!(out.groups.is_empty());
    }
}
