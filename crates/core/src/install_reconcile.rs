//! Case-only install-record reconciliation.
//!
//! A manual disk rename that changes *only case* (e.g. `Teach`→`teach`) on a
//! case-insensitive filesystem leaves the `installs.json` records pointing at
//! the old case. Because `(kind, name, target)` matching is **case-sensitive**
//! (`install_state.rs`), the renamed library primitive can never find its
//! record — drift never classifies it and Reimport is never offered, so the
//! primitive is silently frozen.
//!
//! This module detects those **case-only orphans** — a record whose
//! `(kind, name)` has no exact-case library primitive but exactly one
//! non-ambiguous case-insensitive match whose canonical name differs only in
//! case — and re-links the record to the library's canonical case.
//!
//! It is deliberately conservative:
//! - It NEVER changes the `(kind, name, target)` equality invariant
//!   (case-sensitivity stays — `foo` and `Foo` are distinct on case-sensitive
//!   filesystems). It only *renames a record to match a primitive that already
//!   exists*.
//! - It NEVER fires on an ambiguous library case collision (both `foo` and
//!   `Foo` present) or when a record already exists at the canonical name for
//!   an affected target (would clobber a live record).
//! - A true orphan (no case-insensitive match at all) is left untouched for
//!   the existing UI orphan-surfacing path to handle.
//!
//! Charset is ASCII-only (`primitive_name.rs`), so case comparison uses
//! `eq_ignore_ascii_case` / `to_ascii_lowercase` — no Unicode case-folding.

use std::collections::{HashMap, HashSet};

use crate::install_state::InstallsFile;
use crate::{PrimitiveKind, PrimitiveName, Target};

/// A planned case-only re-link: rewrite every `(kind, from_name, *)` record's
/// `name` to `to_name`. `targets` records which targets were affected (purely
/// for reporting/logging — the rewrite keys on `(kind, from_name)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseRelink {
    pub kind: PrimitiveKind,
    pub from_name: PrimitiveName,
    pub to_name: PrimitiveName,
    pub targets: Vec<Target>,
}

/// Compute the set of case-only re-link actions needed to reconcile
/// `installs` against the current `library` primitive set. Pure — reads only,
/// returns a plan. See the module docs for the safety rules.
pub fn plan_case_relinks(
    library: &[(PrimitiveKind, PrimitiveName)],
    installs: &InstallsFile,
) -> Vec<CaseRelink> {
    // 1. Exact-case library membership + a case-insensitive canonical index.
    //    The ci index maps `(kind, lowercased)` → every canonical name sharing
    //    that key, so a >1 entry marks an ambiguous in-library case collision.
    let mut exact: HashSet<(PrimitiveKind, &str)> = HashSet::new();
    let mut ci: HashMap<(PrimitiveKind, String), Vec<&PrimitiveName>> = HashMap::new();
    for (kind, pname) in library {
        exact.insert((*kind, pname.as_str()));
        ci.entry((*kind, pname.as_str().to_ascii_lowercase()))
            .or_default()
            .push(pname);
    }

    // 2. Group install records by `(kind, name)`, preserving first-seen order
    //    and collecting the affected targets.
    let mut groups: Vec<(PrimitiveKind, &PrimitiveName, Vec<Target>)> = Vec::new();
    let mut index: HashMap<(PrimitiveKind, &str), usize> = HashMap::new();
    for r in &installs.records {
        let key = (r.kind, r.name.as_str());
        match index.get(&key) {
            Some(&i) => {
                if !groups[i].2.contains(&r.target) {
                    groups[i].2.push(r.target);
                }
            }
            None => {
                index.insert(key, groups.len());
                groups.push((r.kind, &r.name, vec![r.target]));
            }
        }
    }

    // 3. Emit a relink only for an unambiguous case-only orphan.
    let mut relinks = Vec::new();
    for (kind, rname, targets) in &groups {
        // Exact-case library match → healthy, nothing to do.
        if exact.contains(&(*kind, rname.as_str())) {
            continue;
        }
        let lower = rname.as_str().to_ascii_lowercase();
        let canon = match ci.get(&(*kind, lower)) {
            // No case-insensitive match → a *true* orphan; leave it for the
            // existing UI orphan-surfacing path.
            None => continue,
            // Ambiguous in-library case collision → never silently pick one.
            Some(c) if c.len() != 1 => continue,
            Some(c) => c[0],
        };
        // `canon` shares the lowercased key but isn't an exact match, so it
        // differs only in case. Q2: skip if a record already lives at the
        // canonical name for any affected target (would clobber it).
        let collides = targets.iter().any(|t| installs.get(*kind, canon, *t).is_some());
        if collides {
            continue;
        }
        relinks.push(CaseRelink {
            kind: *kind,
            from_name: (*rname).clone(),
            to_name: canon.clone(),
            targets: targets.clone(),
        });
    }
    relinks
}

/// Apply `relinks` to `installs` in memory: for each relink, rewrite the
/// `name` of every record matching `(kind, from_name)` to `to_name`.
/// Idempotent — re-running after a successful apply is a no-op because
/// `plan_case_relinks` won't re-emit an already-canonical record.
pub fn apply_case_relinks(installs: &mut InstallsFile, relinks: &[CaseRelink]) {
    for relink in relinks {
        for r in installs.records.iter_mut() {
            if r.kind == relink.kind && r.name == relink.from_name {
                r.name = relink.to_name.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_state::InstallRecord;
    use crate::VersionLabel;
    use camino::Utf8PathBuf;
    use std::collections::BTreeMap;

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn rec(kind: PrimitiveKind, n: &str, target: Target) -> InstallRecord {
        let mut fh = BTreeMap::new();
        fh.insert(Utf8PathBuf::from("SKILL.md"), "deadbeef".to_string());
        InstallRecord {
            kind,
            name: name(n),
            target,
            installed_version: VersionLabel::try_new("v1").unwrap(),
            file_hashes: fh.clone(),
            last_known_install_hashes: fh,
            mtimes: BTreeMap::new(),
            installed_at: "2026-06-08T18:41:16Z".to_string(),
        }
    }

    fn installs(records: Vec<InstallRecord>) -> InstallsFile {
        InstallsFile {
            format_version: crate::install_state::FORMAT_VERSION,
            records,
        }
    }

    fn lib(items: &[(PrimitiveKind, &str)]) -> Vec<(PrimitiveKind, PrimitiveName)> {
        items.iter().map(|(k, n)| (*k, name(n))).collect()
    }

    // The canonical reproduction of the live bug: library has lowercase
    // `teach`/`synthesize`; installs has uppercase `Teach`/`Synthesize` for
    // both targets. Expect two relinks and a full lowercase rewrite.
    #[test]
    fn teach_synthesize_case_only_orphan_produces_relinks() {
        let library = lib(&[
            (PrimitiveKind::Skill, "teach"),
            (PrimitiveKind::Skill, "synthesize"),
        ]);
        let mut file = installs(vec![
            rec(PrimitiveKind::Skill, "Teach", Target::Claude),
            rec(PrimitiveKind::Skill, "Teach", Target::Codex),
            rec(PrimitiveKind::Skill, "Synthesize", Target::Claude),
            rec(PrimitiveKind::Skill, "Synthesize", Target::Codex),
        ]);

        let relinks = plan_case_relinks(&library, &file);
        assert_eq!(relinks.len(), 2, "two case-only orphans: {relinks:?}");

        let teach = relinks
            .iter()
            .find(|r| r.from_name.as_str() == "Teach")
            .expect("Teach relink");
        assert_eq!(teach.to_name.as_str(), "teach");
        assert_eq!(teach.targets, vec![Target::Claude, Target::Codex]);

        apply_case_relinks(&mut file, &relinks);
        let names: Vec<&str> = file.records.iter().map(|r| r.name.as_str()).collect();
        assert!(
            names.iter().all(|n| *n == "teach" || *n == "synthesize"),
            "all records lowercased: {names:?}"
        );
    }

    #[test]
    fn exact_case_match_produces_no_relink() {
        let library = lib(&[(PrimitiveKind::Skill, "teach")]);
        let file = installs(vec![rec(PrimitiveKind::Skill, "teach", Target::Claude)]);
        assert!(plan_case_relinks(&library, &file).is_empty());
    }

    #[test]
    fn true_orphan_no_ci_match_is_left_alone() {
        // `Ghost` has no `ghost` (or any-case) primitive — reconciliation must
        // NOT touch it; the existing UI orphan path owns it.
        let library = lib(&[(PrimitiveKind::Skill, "teach")]);
        let file = installs(vec![rec(PrimitiveKind::Skill, "Ghost", Target::Claude)]);
        assert!(plan_case_relinks(&library, &file).is_empty());
    }

    #[test]
    fn ambiguous_library_case_collision_is_skipped() {
        // Library legitimately has BOTH `foo` and `Foo` (possible on a
        // case-sensitive FS). A record `FOO` is ambiguous → never silently
        // pick one.
        let library = lib(&[(PrimitiveKind::Skill, "foo"), (PrimitiveKind::Skill, "Foo")]);
        let file = installs(vec![rec(PrimitiveKind::Skill, "FOO", Target::Claude)]);
        assert!(plan_case_relinks(&library, &file).is_empty());
    }

    #[test]
    fn canonical_target_collision_is_skipped() {
        // Both `Teach` and `teach` records exist for Claude. Renaming `Teach`
        // → `teach` would clobber the live `teach` record → skip (Q2).
        let library = lib(&[(PrimitiveKind::Skill, "teach")]);
        let file = installs(vec![
            rec(PrimitiveKind::Skill, "Teach", Target::Claude),
            rec(PrimitiveKind::Skill, "teach", Target::Claude),
        ]);
        assert!(
            plan_case_relinks(&library, &file).is_empty(),
            "must not clobber a live canonical record"
        );
    }

    #[test]
    fn kind_is_part_of_the_match() {
        // A `teach` Agent primitive must NOT satisfy a `Teach` Skill record.
        let library = lib(&[(PrimitiveKind::Agent, "teach")]);
        let file = installs(vec![rec(PrimitiveKind::Skill, "Teach", Target::Claude)]);
        assert!(plan_case_relinks(&library, &file).is_empty());
    }

    #[test]
    fn apply_is_idempotent() {
        let library = lib(&[(PrimitiveKind::Skill, "teach")]);
        let mut file = installs(vec![rec(PrimitiveKind::Skill, "Teach", Target::Claude)]);
        let relinks = plan_case_relinks(&library, &file);
        apply_case_relinks(&mut file, &relinks);
        // Second pass: nothing left to do.
        let again = plan_case_relinks(&library, &file);
        assert!(again.is_empty(), "already canonical: {again:?}");
        assert_eq!(file.records[0].name.as_str(), "teach");
    }

    #[test]
    fn non_case_difference_is_not_a_relink() {
        // `teehc` is not a case variant of `teach` — never treat an arbitrary
        // rename as a case-only relink.
        let library = lib(&[(PrimitiveKind::Skill, "teach")]);
        let file = installs(vec![rec(PrimitiveKind::Skill, "teehc", Target::Claude)]);
        assert!(plan_case_relinks(&library, &file).is_empty());
    }
}
