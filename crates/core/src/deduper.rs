//! P5.1: Bootstrap deduper — group `ScanResult::Candidate`s by `(kind, name)`
//! and decide for each group whether the on-disk content is identical across
//! the targets that have it (one primitive, no overlays) or differs (one
//! primitive with overlays).
//!
//! Inputs come from [`scan_install_roots`](crate::scan_install_roots).
//! `Symlinked` and `Unclassified` results pass through unchanged into their
//! own buckets — the wizard surfaces those in dedicated panes and the
//! deduper never auto-imports them.
//!
//! Pure logic — no FS I/O. Content comparison relies on the `content_hash`,
//! `file_count`, and `latest_mtime_unix` fields the scanner attached to each
//! Candidate.

use camino::Utf8PathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{CandidateInfo, ParseStatus, PrimitiveKind, PrimitiveName, ScanResult, Target};

/// Result of running the deduper over a `Vec<ScanResult>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DedupeOutput {
    /// Auto-importable groups: every entry is Identical or Differs.
    /// Groups whose every member failed to parse land in
    /// [`needs_manual_review`](Self::needs_manual_review).
    pub groups: Vec<DedupeGroup>,
    /// `(kind, name)` groups that the wizard surfaces in a manual-review
    /// pane — every member was unparseable. Nothing is auto-imported.
    pub needs_manual_review: Vec<ManualReviewGroup>,
    /// Symlinks under known scan roots — wizard pane offers
    /// `[Resolve & import] [Skip] [Import as-is]`.
    pub symlinked: Vec<SymlinkedItem>,
    /// Entries that didn't fit any expected layout — wizard's
    /// "Couldn't classify" pane.
    pub unclassified: Vec<UnclassifiedItem>,
}

/// One `(kind, name)` group, decided. Always Identical or Differs —
/// unparseable groups live in [`ManualReviewGroup`] on a separate stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DedupeGroup {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub content: DedupeContent,
}

/// Variant data for a [`DedupeGroup`]. Carries no `(kind, name)` — those
/// fields are lifted to the outer struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DedupeContent {
    /// Every candidate in the group has identical content. Base is picked
    /// by the stable target priority `claude > pi > codex`. No overlays.
    Identical { base: BaseAssignment },
    /// At least two candidates have different content. Base is picked by
    /// "most files, then latest mtime"; the rest become overlay candidates.
    Differs {
        base: BaseAssignment,
        overlays: Vec<OverlayCandidate>,
    },
}

/// A `(kind, name)` group every member of which failed to parse — the
/// wizard surfaces it in a manual-review pane and nothing auto-imports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ManualReviewGroup {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub members: Vec<MemberInfo>,
}

/// The candidate chosen as the primitive's `base` content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BaseAssignment {
    pub target: Target,
    #[specta(type = String)]
    pub source_path: Utf8PathBuf,
    pub parse: ParseStatus,
}

/// A non-base candidate that becomes a target overlay on the same primitive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OverlayCandidate {
    pub target: Target,
    #[specta(type = String)]
    pub source_path: Utf8PathBuf,
    pub parse: ParseStatus,
}

/// Member of a `NeedsManualReview` group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MemberInfo {
    pub target: Target,
    #[specta(type = String)]
    pub source_path: Utf8PathBuf,
    pub parse: ParseStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SymlinkedItem {
    #[specta(type = String)]
    pub source_path: Utf8PathBuf,
    pub kind: PrimitiveKind,
    pub target: Target,
    #[specta(type = Option<String>)]
    pub link_target: Option<Utf8PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UnclassifiedItem {
    #[specta(type = String)]
    pub source_path: Utf8PathBuf,
    pub kind: PrimitiveKind,
    pub target: Target,
    pub reason: String,
}

/// Stable target priority for the `Identical` branch (highest first).
/// Plan v1 fixes this; later phases may make it user-configurable.
const IDENTICAL_BASE_PRIORITY: &[Target] = &[Target::Claude, Target::Pi, Target::Codex];

/// Group `Candidate`s by `(kind, name)` and decide each group. `Symlinked`
/// and `Unclassified` flow through unchanged.
pub fn dedupe(results: Vec<ScanResult>) -> DedupeOutput {
    // Bucket by (kind, name) while preserving first-seen order. The scanner
    // emits results in `SCAN_MATRIX` order; the wizard renders groups in the
    // same order so streaming feels stable.
    let mut buckets: Vec<((PrimitiveKind, PrimitiveName), Vec<CandidateRow>)> = Vec::new();
    let mut symlinked = Vec::new();
    let mut unclassified = Vec::new();

    for r in results {
        match r {
            ScanResult::Candidate {
                source_path,
                kind,
                target,
                name,
                parse,
                info,
            } => {
                let row = CandidateRow {
                    target,
                    source_path,
                    parse,
                    info,
                };
                if let Some(b) = buckets
                    .iter_mut()
                    .find(|((k, n), _)| *k == kind && n == &name)
                {
                    b.1.push(row);
                } else {
                    buckets.push(((kind, name), vec![row]));
                }
            }
            ScanResult::Symlinked {
                source_path,
                kind,
                target,
                link_target,
            } => symlinked.push(SymlinkedItem {
                source_path,
                kind,
                target,
                link_target,
            }),
            ScanResult::Unclassified {
                source_path,
                kind,
                target,
                reason,
            } => unclassified.push(UnclassifiedItem {
                source_path,
                kind,
                target,
                reason,
            }),
        }
    }

    let mut groups = Vec::new();
    let mut needs_manual_review = Vec::new();
    for ((kind, name), members) in buckets {
        match decide_group(kind, name, members) {
            DecideOutcome::Auto(group) => groups.push(group),
            DecideOutcome::ManualReview(g) => needs_manual_review.push(g),
        }
    }

    DedupeOutput {
        groups,
        needs_manual_review,
        symlinked,
        unclassified,
    }
}

#[derive(Debug, Clone)]
struct CandidateRow {
    target: Target,
    source_path: Utf8PathBuf,
    parse: ParseStatus,
    info: CandidateInfo,
}

enum DecideOutcome {
    Auto(DedupeGroup),
    ManualReview(ManualReviewGroup),
}

fn decide_group(
    kind: PrimitiveKind,
    name: PrimitiveName,
    mut members: Vec<CandidateRow>,
) -> DecideOutcome {
    debug_assert!(!members.is_empty(), "dedupe groups always have ≥1 member");

    if members.iter().all(|m| !matches!(m.parse, ParseStatus::Parsed)) {
        let members = members
            .into_iter()
            .map(|m| MemberInfo {
                target: m.target,
                source_path: m.source_path,
                parse: m.parse,
            })
            .collect();
        return DecideOutcome::ManualReview(ManualReviewGroup {
            kind,
            name,
            members,
        });
    }

    let all_identical = members
        .iter()
        .all(|m| m.info.content_hash == members[0].info.content_hash);

    if all_identical {
        let idx = pick_priority_base(&members);
        let base = members.remove(idx);
        return DecideOutcome::Auto(DedupeGroup {
            kind,
            name,
            content: DedupeContent::Identical {
                base: BaseAssignment {
                    target: base.target,
                    source_path: base.source_path,
                    parse: base.parse,
                },
            },
        });
    }

    // Differs branch: pick base by file_count desc, then mtime desc, then
    // IDENTICAL_BASE_PRIORITY as final deterministic tiebreak. Unparseable
    // members are never eligible for base when any parsed alternative
    // exists — they can still serve as overlays (with-warning).
    let base_idx = pick_differs_base(&members);
    let base = members.remove(base_idx);
    let overlays = members
        .into_iter()
        .map(|m| OverlayCandidate {
            target: m.target,
            source_path: m.source_path,
            parse: m.parse,
        })
        .collect();
    DecideOutcome::Auto(DedupeGroup {
        kind,
        name,
        content: DedupeContent::Differs {
            base: BaseAssignment {
                target: base.target,
                source_path: base.source_path,
                parse: base.parse,
            },
            overlays,
        },
    })
}

/// Index into `members` of the candidate whose target appears first in
/// `IDENTICAL_BASE_PRIORITY`.
fn pick_priority_base(members: &[CandidateRow]) -> usize {
    IDENTICAL_BASE_PRIORITY
        .iter()
        .find_map(|pref| members.iter().position(|m| m.target == *pref))
        .unwrap_or(0)
}

/// Differs-branch base picker: most files wins; latest mtime breaks ties;
/// `IDENTICAL_BASE_PRIORITY` is the final deterministic tiebreak.
///
/// Unparseable members are skipped — caller has already verified at least
/// one parsed member exists (NeedsManualReview short-circuits otherwise).
fn pick_differs_base(members: &[CandidateRow]) -> usize {
    let parsed_indices: Vec<usize> = members
        .iter()
        .enumerate()
        .filter(|(_, m)| matches!(m.parse, ParseStatus::Parsed))
        .map(|(i, _)| i)
        .collect();
    debug_assert!(
        !parsed_indices.is_empty(),
        "decide_group should route to NeedsManualReview when no parsed members"
    );
    let mut best = parsed_indices[0];
    for &i in &parsed_indices[1..] {
        if differs_better(&members[i], &members[best]) {
            best = i;
        }
    }
    best
}

fn differs_better(a: &CandidateRow, b: &CandidateRow) -> bool {
    if a.info.file_count != b.info.file_count {
        return a.info.file_count > b.info.file_count;
    }
    if a.info.latest_mtime_unix != b.info.latest_mtime_unix {
        return a.info.latest_mtime_unix > b.info.latest_mtime_unix;
    }
    target_priority(a.target) < target_priority(b.target)
}

fn target_priority(t: Target) -> usize {
    IDENTICAL_BASE_PRIORITY
        .iter()
        .position(|p| *p == t)
        .expect("IDENTICAL_BASE_PRIORITY covers every Target variant")
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8Path;

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn candidate(
        kind: PrimitiveKind,
        target: Target,
        nm: &str,
        path: &str,
    ) -> ScanResult {
        candidate_with(kind, target, nm, path, "h-default", 1, 0)
    }

    fn candidate_with(
        kind: PrimitiveKind,
        target: Target,
        nm: &str,
        path: &str,
        content_hash: &str,
        file_count: u32,
        latest_mtime_unix: i64,
    ) -> ScanResult {
        ScanResult::Candidate {
            source_path: Utf8PathBuf::from(path),
            kind,
            target,
            name: name(nm),
            parse: ParseStatus::Parsed,
            info: CandidateInfo {
                content_hash: content_hash.to_string(),
                file_count,
                latest_mtime_unix,
            },
        }
    }

    /// End-to-end: real on-disk fixture scanned and deduped. Catches any
    /// drift between scanner-side hashing and deduper-side comparison.
    #[test]
    fn end_to_end_identical_skill_collapses_to_one_group() {
        use crate::scan_install_roots;
        let tmp = tempfile::TempDir::new().unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let same_bytes = b"---\ndescription: shared\n---\nbody\n";
        for rel in [
            ".claude/skills/diagnose/SKILL.md",
            ".pi/agent/skills/diagnose/SKILL.md",
            ".codex/skills/diagnose/SKILL.md",
        ] {
            let abs = home.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap().as_std_path()).unwrap();
            std::fs::write(abs.as_std_path(), same_bytes).unwrap();
        }
        let out = dedupe(scan_install_roots(&home));
        assert_eq!(out.groups.len(), 1);
        match &out.groups[0].content {
            DedupeContent::Identical { base } => {
                assert_eq!(base.target, Target::Claude);
            }
            c => panic!("expected Identical, got {c:?}"),
        }
    }

    #[test]
    fn end_to_end_differing_skill_yields_differs_group() {
        use crate::scan_install_roots;
        let tmp = tempfile::TempDir::new().unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        for (rel, body) in [
            (".claude/skills/diagnose/SKILL.md", "---\n---\nclaude\n"),
            (".pi/agent/skills/diagnose/SKILL.md", "---\n---\npi\n"),
        ] {
            let abs = home.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap().as_std_path()).unwrap();
            std::fs::write(abs.as_std_path(), body).unwrap();
        }
        let out = dedupe(scan_install_roots(&home));
        assert_eq!(out.groups.len(), 1);
        assert!(matches!(out.groups[0].content, DedupeContent::Differs { .. }));
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let out = dedupe(vec![]);
        assert!(out.groups.is_empty());
        assert!(out.needs_manual_review.is_empty());
        assert!(out.symlinked.is_empty());
        assert!(out.unclassified.is_empty());
    }

    #[test]
    fn two_targets_identical_content_picks_claude_as_base() {
        // claude > pi > codex priority — claude wins even though pi was
        // listed first.
        let out = dedupe(vec![
            candidate_with(
                PrimitiveKind::Skill,
                Target::Pi,
                "diagnose",
                "/x/.pi/agent/skills/diagnose",
                "abc123",
                1,
                0,
            ),
            candidate_with(
                PrimitiveKind::Skill,
                Target::Claude,
                "diagnose",
                "/x/.claude/skills/diagnose",
                "abc123",
                1,
                0,
            ),
        ]);
        assert_eq!(out.groups.len(), 1);
        match &out.groups[0].content {
            DedupeContent::Identical { base } => {
                assert_eq!(base.target, Target::Claude);
            }
            c => panic!("expected Identical, got {c:?}"),
        }
    }

    #[test]
    fn two_targets_differing_content_yields_differs_with_overlay() {
        // Same name, same file_count, different content hashes → Differs.
        // claude > pi priority still applies since file_counts tie at 1.
        let out = dedupe(vec![
            candidate_with(
                PrimitiveKind::Skill,
                Target::Pi,
                "diagnose",
                "/x/.pi/agent/skills/diagnose",
                "hash-pi",
                1,
                100,
            ),
            candidate_with(
                PrimitiveKind::Skill,
                Target::Claude,
                "diagnose",
                "/x/.claude/skills/diagnose",
                "hash-claude",
                1,
                200,
            ),
        ]);
        assert_eq!(out.groups.len(), 1);
        match &out.groups[0].content {
            DedupeContent::Differs { base, overlays } => {
                assert_eq!(base.target, Target::Claude);
                assert_eq!(overlays.len(), 1);
                assert_eq!(overlays[0].target, Target::Pi);
            }
            c => panic!("expected Differs, got {c:?}"),
        }
    }

    #[test]
    fn differs_base_is_target_with_most_files() {
        // Pi has 3 files, Claude has 1. Pi wins despite Claude's priority.
        let out = dedupe(vec![
            candidate_with(
                PrimitiveKind::Skill,
                Target::Claude,
                "diagnose",
                "/x/.claude/skills/diagnose",
                "hash-claude",
                1,
                500,
            ),
            candidate_with(
                PrimitiveKind::Skill,
                Target::Pi,
                "diagnose",
                "/x/.pi/agent/skills/diagnose",
                "hash-pi",
                3,
                100,
            ),
        ]);
        match &out.groups[0].content {
            DedupeContent::Differs { base, overlays } => {
                assert_eq!(base.target, Target::Pi);
                assert_eq!(overlays.len(), 1);
                assert_eq!(overlays[0].target, Target::Claude);
            }
            c => panic!("expected Differs, got {c:?}"),
        }
    }

    #[test]
    fn differs_file_count_tie_breaks_to_latest_mtime() {
        // Both have 1 file; Pi has newer mtime. Pi wins despite Claude's
        // priority and despite Codex appearing first in input order.
        let out = dedupe(vec![
            candidate_with(
                PrimitiveKind::Skill,
                Target::Codex,
                "diagnose",
                "/x/.codex/skills/diagnose",
                "hash-codex",
                1,
                100,
            ),
            candidate_with(
                PrimitiveKind::Skill,
                Target::Claude,
                "diagnose",
                "/x/.claude/skills/diagnose",
                "hash-claude",
                1,
                200,
            ),
            candidate_with(
                PrimitiveKind::Skill,
                Target::Pi,
                "diagnose",
                "/x/.pi/agent/skills/diagnose",
                "hash-pi",
                1,
                999,
            ),
        ]);
        match &out.groups[0].content {
            DedupeContent::Differs { base, .. } => {
                assert_eq!(base.target, Target::Pi);
            }
            c => panic!("expected Differs, got {c:?}"),
        }
    }

    #[test]
    fn all_unparseable_group_yields_needs_manual_review() {
        let unparseable = ParseStatus::Unparseable {
            reason: "yaml broken".into(),
        };
        let out = dedupe(vec![
            ScanResult::Candidate {
                source_path: Utf8PathBuf::from("/x/.claude/skills/diagnose"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                name: name("diagnose"),
                parse: unparseable.clone(),
                info: CandidateInfo {
                    content_hash: "h-c".into(),
                    file_count: 1,
                    latest_mtime_unix: 0,
                },
            },
            ScanResult::Candidate {
                source_path: Utf8PathBuf::from("/x/.pi/agent/skills/diagnose"),
                kind: PrimitiveKind::Skill,
                target: Target::Pi,
                name: name("diagnose"),
                parse: unparseable.clone(),
                info: CandidateInfo {
                    content_hash: "h-p".into(),
                    file_count: 1,
                    latest_mtime_unix: 0,
                },
            },
        ]);
        assert!(out.groups.is_empty());
        assert_eq!(out.needs_manual_review.len(), 1);
        let g = &out.needs_manual_review[0];
        assert_eq!(g.kind, PrimitiveKind::Skill);
        assert_eq!(g.name, name("diagnose"));
        assert_eq!(g.members.len(), 2);
        let targets: Vec<_> = g.members.iter().map(|m| m.target).collect();
        assert!(targets.contains(&Target::Claude));
        assert!(targets.contains(&Target::Pi));
    }

    #[test]
    fn singleton_unparseable_still_needs_manual_review() {
        // Even a singleton bucket falls into NeedsManualReview if its sole
        // member is unparseable — there's nothing to import as base.
        let out = dedupe(vec![ScanResult::Candidate {
            source_path: Utf8PathBuf::from("/x/.claude/skills/broken"),
            kind: PrimitiveKind::Skill,
            target: Target::Claude,
            name: name("broken"),
            parse: ParseStatus::Unparseable {
                reason: "no fm".into(),
            },
            info: CandidateInfo {
                content_hash: "h".into(),
                file_count: 1,
                latest_mtime_unix: 0,
            },
        }]);
        assert!(out.groups.is_empty());
        assert_eq!(out.needs_manual_review.len(), 1);
    }

    #[test]
    fn unparseable_member_never_picked_as_base_when_parsed_alternative_exists() {
        // Pi is unparseable but has more files than parsed Claude. Claude
        // still wins base — unparseable is demoted to overlay-only regardless
        // of file_count/mtime.
        let out = dedupe(vec![
            ScanResult::Candidate {
                source_path: Utf8PathBuf::from("/x/.pi/agent/skills/diagnose"),
                kind: PrimitiveKind::Skill,
                target: Target::Pi,
                name: name("diagnose"),
                parse: ParseStatus::Unparseable {
                    reason: "broken".into(),
                },
                info: CandidateInfo {
                    content_hash: "h-pi".into(),
                    file_count: 5,
                    latest_mtime_unix: 999,
                },
            },
            ScanResult::Candidate {
                source_path: Utf8PathBuf::from("/x/.claude/skills/diagnose"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                name: name("diagnose"),
                parse: ParseStatus::Parsed,
                info: CandidateInfo {
                    content_hash: "h-claude".into(),
                    file_count: 1,
                    latest_mtime_unix: 100,
                },
            },
        ]);
        match &out.groups[0].content {
            DedupeContent::Differs { base, overlays } => {
                assert_eq!(base.target, Target::Claude);
                assert_eq!(base.parse, ParseStatus::Parsed);
                assert_eq!(overlays.len(), 1);
                assert_eq!(overlays[0].target, Target::Pi);
                assert!(matches!(
                    overlays[0].parse,
                    ParseStatus::Unparseable { .. }
                ));
            }
            c => panic!("expected Differs, got {c:?}"),
        }
    }

    #[test]
    fn symlinked_and_unclassified_route_to_their_buckets_not_groups() {
        let out = dedupe(vec![
            ScanResult::Symlinked {
                source_path: Utf8PathBuf::from("/x/.claude/skills/linked"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                link_target: Some(Utf8PathBuf::from("/elsewhere/realskill")),
            },
            ScanResult::Unclassified {
                source_path: Utf8PathBuf::from("/x/.claude/skills/no-primary"),
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                reason: "missing SKILL.md".into(),
            },
            candidate(
                PrimitiveKind::Skill,
                Target::Claude,
                "diagnose",
                "/x/.claude/skills/diagnose",
            ),
        ]);
        assert_eq!(out.groups.len(), 1, "only the candidate becomes a group");
        assert_eq!(out.symlinked.len(), 1);
        assert_eq!(out.symlinked[0].link_target.as_deref(), Some(Utf8Path::new("/elsewhere/realskill")));
        assert_eq!(out.unclassified.len(), 1);
        assert_eq!(out.unclassified[0].reason, "missing SKILL.md");
    }

    #[test]
    fn same_name_different_kinds_form_separate_groups() {
        let out = dedupe(vec![
            candidate(
                PrimitiveKind::Skill,
                Target::Claude,
                "foo",
                "/x/.claude/skills/foo",
            ),
            candidate(
                PrimitiveKind::Agent,
                Target::Claude,
                "foo",
                "/x/.claude/agents/foo.md",
            ),
        ]);
        assert_eq!(out.groups.len(), 2, "kind separates groups");
        let kinds: Vec<_> = out.groups.iter().map(|g| g.kind).collect();
        assert!(kinds.contains(&PrimitiveKind::Skill));
        assert!(kinds.contains(&PrimitiveKind::Agent));
    }

    #[test]
    fn singleton_candidate_is_identical_with_that_target_as_base() {
        let out = dedupe(vec![candidate(
            PrimitiveKind::Skill,
            Target::Claude,
            "diagnose",
            "/x/.claude/skills/diagnose",
        )]);
        assert_eq!(out.groups.len(), 1);
        let g = &out.groups[0];
        assert_eq!(g.kind, PrimitiveKind::Skill);
        assert_eq!(g.name, name("diagnose"));
        match &g.content {
            DedupeContent::Identical { base } => {
                assert_eq!(base.target, Target::Claude);
                assert_eq!(base.source_path, "/x/.claude/skills/diagnose");
                assert_eq!(base.parse, ParseStatus::Parsed);
            }
            c => panic!("expected Identical, got {c:?}"),
        }
    }
}
