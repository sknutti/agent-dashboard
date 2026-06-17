//! Flatten: promote one **Target**'s **Overlay** into the **Base** (ADR-0009).
//!
//! Where reimport pulls *one target's installed bytes* into the library as a
//! new version, flatten promotes *one overlay* into the shared base and fans
//! out to *every converging target's* install on disk. The single rule:
//! a target with no overlay is a **base-follower** and converges to the new
//! base; a target with its own overlay is independent and is preserved (its
//! overlay recomputed as a delta against the new base so its Materialized
//! bytes are unchanged).
//!
//! The op (on one Primitive, given a chosen Target `X` that HAS an overlay):
//!
//! 1. Refuse if `X` has no overlay (`NotAnOverlayTarget`) or nothing is pinned
//!    (`NoCurrentVersion`).
//! 2. Hard-block (`WorkingCopyDirty`) if `working/` has unpublished edits.
//! 3. Pre-scan the converging base-follower targets for drift; if any are
//!    hand-edited and `!force`, abort (`ConvergingConflicts`) writing nothing.
//! 4. Rewrite working: `base := merge(base, X)`; drop `X`'s overlay; recompute
//!    every other overlay target's overlay as a set-difference vs the new base.
//! 5. Snapshot a new Version (never a reset) and let the bridge commit.
//! 6. Reinstall the converging targets (force) and re-baseline ALL affected
//!    `installs.json` records so both drift surfaces read Clean.

use std::fs;

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::drift::{scan_drift_for_primitive, DriftStatus};
use crate::install_paths::InstallPaths;
use crate::install_state::InstallsFile;
use crate::installer::{install, InstallRequest, InstallSummary};
use crate::version_store::{VersionMetadata, VersionStore};
use crate::working_copy::WorkingCopy;
use crate::{
    overlay_merge, Error, LibraryLayout, OverlayBytes, PrimitiveKind, PrimitiveMetadata,
    PrimitiveName, Target, VersionLabel,
};

/// Inputs to [`flatten_promote_to_base`].
pub struct FlattenRequest<'a> {
    pub layout: LibraryLayout<'a>,
    pub install_paths: &'a InstallPaths,
    pub installs_file_path: &'a Utf8Path,
    pub kind: PrimitiveKind,
    pub name: &'a PrimitiveName,
    /// The target whose overlay is promoted into the base.
    pub source_target: Target,
    pub new_version: VersionLabel,
    pub created_at: &'a str,
    pub notes: Option<String>,
    /// On `false`, a hand-edited converging base-follower returns
    /// [`FlattenResult::ConvergingConflicts`] and nothing is written. On
    /// `true`, those installs are overwritten.
    pub force: bool,
}

/// One target whose installed copy diverges from its install record, blocking
/// a non-forced flatten. `paths` are install-relative (string for IPC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TargetConflict {
    pub target: Target,
    pub paths: Vec<String>,
}

/// Outcome of a flatten call. Each non-`Flattened` variant is an actionable
/// state the UI routes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FlattenResult {
    /// Library rewritten + snapshotted, converging targets reinstalled, all
    /// affected records re-baselined. `reinstall` carries per-target install
    /// outcomes so the UI can surface any partial reinstall failure.
    Flattened {
        new_version: VersionLabel,
        converged_targets: Vec<Target>,
        preserved_targets: Vec<Target>,
        reinstall: InstallSummary,
    },
    /// `working/` diverges from the current pinned version. UI tells the user
    /// to publish/discard their working edits first.
    WorkingCopyDirty,
    /// One or more converging base-follower installs are hand-edited and
    /// `force` was not set. Nothing was written.
    ConvergingConflicts { conflicts: Vec<TargetConflict> },
    /// The chosen target has no overlay — promoting it is a no-op.
    NotAnOverlayTarget,
    /// No current version pinned, so there is no base to promote into.
    NoCurrentVersion,
}

/// Split the allowed targets (other than `source_target`) into the
/// **converging** base-followers (no overlay → follow the new base) and the
/// **preserved** independents (have an overlay → kept, rebased). Pure.
pub(crate) fn classify_flatten_targets(
    old: &OverlayBytes,
    allowed: &[Target],
    source_target: Target,
) -> (Vec<Target>, Vec<Target>) {
    let mut converged = Vec::new();
    let mut preserved = Vec::new();
    for &t in allowed {
        if t == source_target {
            continue;
        }
        if old.targets.contains_key(&t) {
            preserved.push(t);
        } else {
            converged.push(t);
        }
    }
    (converged, preserved)
}

/// Rewrite `working/` to promote `source_target`'s overlay into the base
/// (ADR-0009 D2). Operates entirely from the in-memory `old` snapshot, so the
/// order of disk writes does not affect correctness:
///
/// - `new_base = merge(old, source_target)`.
/// - For every OTHER overlay target `T`: recompute `T`'s overlay to exactly the
///   files where `merge(old, T)` differs from `new_base` (preserving `T`'s
///   effective bytes, including files `T` inherited from base that the promoted
///   overlay changed). Files now equal to `new_base` are dropped as redundant.
/// - Drop `source_target`'s overlay entirely.
/// - Replace base with `new_base`.
///
/// Overlays are additive whole-file shadows (no deletes), so if the promoted
/// overlay introduces a file absent from base, every other target gains it —
/// that is the one case where a preserved target's Materialized set grows
/// (it cannot be represented otherwise).
pub(crate) fn apply_flatten_rewrite(
    wc: &WorkingCopy<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    source_target: Target,
    old: &OverlayBytes,
) -> Result<(), Error> {
    let new_base = overlay_merge::merge(old, source_target);

    // Recompute every OTHER overlay target as a set-difference vs the new base,
    // preserving its effective bytes. Computed from `old` (in-memory), so the
    // disk write order below is irrelevant to correctness.
    for (&target, _) in old.targets.iter() {
        if target == source_target {
            continue;
        }
        let eff = overlay_merge::merge(old, target);
        // Clear the target's existing overlay, then re-add only the files whose
        // effective bytes differ from the new base (others are now redundant).
        if let Some(files) = old.targets.get(&target) {
            for rel in files.keys() {
                wc.remove_target_file(kind, name, target, rel)?;
            }
        }
        for (rel, bytes) in &eff {
            if new_base.get(rel) != Some(bytes) {
                wc.save_target_file(kind, name, target, rel, bytes)?;
            }
        }
    }

    // Drop the promoted target's overlay entirely.
    if let Some(files) = old.targets.get(&source_target) {
        for rel in files.keys() {
            wc.remove_target_file(kind, name, source_target, rel)?;
        }
    }

    // Replace base with the new base: remove old base files absent from it,
    // then write every new-base file.
    for rel in old.base.keys() {
        if !new_base.contains_key(rel) {
            wc.remove_base_file(kind, name, rel)?;
        }
    }
    for (rel, bytes) in &new_base {
        wc.save_base_file(kind, name, rel, bytes)?;
    }
    Ok(())
}

/// Promote `source_target`'s overlay into the base as a new Version, converge
/// base-follower targets on disk, and re-baseline every affected install
/// record so the Primitive shows no Drift (ADR-0009). The bridge commits on the
/// `Flattened` arm only.
pub fn flatten_promote_to_base(req: FlattenRequest<'_>) -> Result<FlattenResult, Error> {
    let store = VersionStore::new(req.layout);

    // 1. Must have a pinned current version to read base from.
    if store.read_current(req.kind, req.name)?.is_none() {
        return Ok(FlattenResult::NoCurrentVersion);
    }

    // 2. The chosen target must actually have an overlay.
    let wc = WorkingCopy::new(req.layout);
    let old = wc.load(req.kind, req.name)?;
    let source_has_overlay = old
        .targets
        .get(&req.source_target)
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    if !source_has_overlay {
        return Ok(FlattenResult::NotAnOverlayTarget);
    }

    // 3. Clean-working gate (shared with reimport): refuse if working/ has
    //    unpublished edits.
    if crate::reimport::working_diverges_from_current(req.layout, req.kind, req.name)? {
        return Ok(FlattenResult::WorkingCopyDirty);
    }

    // 4. Classify, then pre-scan the converging base-followers for drift. A
    //    hand-edited converging install blocks the whole op unless `force`.
    let metadata_raw = fs::read_to_string(req.layout.primitive_metadata(req.kind, req.name))
        .map_err(|source| Error::Io {
            path: req.layout.primitive_metadata(req.kind, req.name).to_string(),
            source,
        })?;
    let metadata = PrimitiveMetadata::from_yaml(&metadata_raw)?;
    let (converged, preserved) =
        classify_flatten_targets(&old, &metadata.allowed_targets, req.source_target);

    let reports = scan_drift_for_primitive(
        req.install_paths,
        req.installs_file_path,
        req.kind,
        req.name,
    )?;
    let mut conflicts = Vec::new();
    for report in &reports {
        if !converged.contains(&report.target) {
            continue;
        }
        match &report.status {
            DriftStatus::Clean => {}
            DriftStatus::Modified { conflicts: paths } => conflicts.push(TargetConflict {
                target: report.target,
                paths: paths.clone(),
            }),
            DriftStatus::Missing { missing } => conflicts.push(TargetConflict {
                target: report.target,
                paths: missing.clone(),
            }),
        }
    }
    if !conflicts.is_empty() && !req.force {
        return Ok(FlattenResult::ConvergingConflicts { conflicts });
    }

    // 5. Rewrite working/ (U1).
    apply_flatten_rewrite(&wc, req.kind, req.name, req.source_target, &old)?;

    // 6. Snapshot the new version + bump current.txt. A duplicate label errors
    //    (VersionExists) and propagates — the library is still in its
    //    pre-snapshot state for the working tree, but base was already
    //    rewritten; callers pass a fresh label (publish/reimport posture).
    store.snapshot(
        req.kind,
        req.name,
        &req.new_version,
        &VersionMetadata {
            created_at: req.created_at.into(),
            notes: req.notes.clone(),
        },
    )?;

    // 7. Reinstall converging base-followers that are actually installed (force
    //    per the step-4 gate). install() re-baselines their records to the new
    //    version, capturing fresh hashes from the rewritten disk.
    let installs = InstallsFile::load(req.installs_file_path)?;
    let converged_installed: Vec<Target> = converged
        .iter()
        .copied()
        .filter(|t| installs.get(req.kind, req.name, *t).is_some())
        .collect();
    let reinstall = install(InstallRequest {
        layout: req.layout,
        install_paths: req.install_paths,
        installs_file_path: req.installs_file_path,
        kind: req.kind,
        name: req.name,
        targets: &converged_installed,
        force: true,
        installed_at: req.created_at,
    })?;

    // 8. The promoted + preserved targets are byte-unchanged on disk (D2), so
    //    don't reinstall them (that could clobber a hand-edit the pre-scan
    //    didn't cover, or recompute a baseline that masks pre-existing drift).
    //    Just bump their record's version label so they no longer read as
    //    "outdated" — keeping their hashes/mtimes intact.
    let mut installs = InstallsFile::load(req.installs_file_path)?;
    let to_bump: Vec<_> = installs
        .records
        .iter()
        .filter(|r| {
            r.kind == req.kind
                && &r.name == req.name
                && r.installed_version != req.new_version
        })
        .cloned()
        .collect();
    for mut record in to_bump {
        record.installed_version = req.new_version.clone();
        installs.upsert(record);
    }
    installs.save(req.installs_file_path)?;

    Ok(FlattenResult::Flattened {
        new_version: req.new_version,
        converged_targets: converged,
        preserved_targets: preserved,
        reinstall,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_state::InstallsFile;
    use crate::installer::{install, InstallRequest};
    use crate::scaffold::scaffold_skill;
    use crate::working_copy::WorkingCopy;
    use crate::{update_primitive_metadata, MetadataUpdate, VersionLabel};
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    struct Fx {
        _lib: TempDir,
        _home: TempDir,
        lib_root: Utf8PathBuf,
        home: Utf8PathBuf,
        installs_path: Utf8PathBuf,
    }

    impl Fx {
        fn new() -> Self {
            let lib = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            let lib_root = Utf8PathBuf::from_path_buf(lib.path().to_path_buf()).unwrap();
            let home_path = Utf8PathBuf::from_path_buf(home.path().to_path_buf()).unwrap();
            let installs_path = home_path.join("installs.json");
            Self {
                _lib: lib,
                _home: home,
                lib_root,
                home: home_path,
                installs_path,
            }
        }
        fn layout(&self) -> LibraryLayout<'_> {
            LibraryLayout::new(&self.lib_root)
        }
        fn install_paths(&self) -> InstallPaths {
            InstallPaths::new(&self.home)
        }
    }

    fn n(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn label(s: &str) -> VersionLabel {
        VersionLabel::try_new(s).unwrap()
    }

    /// Publish a Skill at v1 with a base + a Claude overlay, allowed for
    /// `allowed`, and install to every allowed target. Claude materializes
    /// base∪overlay; other allowed targets are base-followers.
    fn published_with_overlay(
        fx: &Fx,
        base_body: &[u8],
        claude_overlay: &[u8],
        allowed: &[Target],
    ) -> PrimitiveName {
        let name = n("improve");
        scaffold_skill(fx.layout(), &name, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new("SKILL.md"), base_body)
            .unwrap();
        wc.save_target_file(
            PrimitiveKind::Skill,
            &name,
            Target::Claude,
            Utf8Path::new("SKILL.md"),
            claude_overlay,
        )
        .unwrap();
        update_primitive_metadata(
            fx.layout(),
            PrimitiveKind::Skill,
            &name,
            MetadataUpdate {
                allowed_targets: allowed.to_vec(),
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        VersionStore::new(fx.layout())
            .snapshot(
                PrimitiveKind::Skill,
                &name,
                &label("v1"),
                &VersionMetadata {
                    created_at: "2026-05-04T00:00:01Z".into(),
                    notes: None,
                },
            )
            .unwrap();
        let ip = fx.install_paths();
        install(InstallRequest {
            layout: fx.layout(),
            install_paths: &ip,
            installs_file_path: &fx.installs_path,
            kind: PrimitiveKind::Skill,
            name: &name,
            targets: allowed,
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();
        name
    }

    fn flatten_req<'a>(
        fx: &'a Fx,
        ip: &'a InstallPaths,
        name: &'a PrimitiveName,
        source: Target,
        new_v: &str,
        force: bool,
    ) -> FlattenRequest<'a> {
        FlattenRequest {
            layout: fx.layout(),
            install_paths: ip,
            installs_file_path: &fx.installs_path,
            kind: PrimitiveKind::Skill,
            name,
            source_target: source,
            new_version: label(new_v),
            created_at: "2026-05-04T01:00:00Z",
            notes: Some("flattened".into()),
            force,
        }
    }

    /// Seed a working copy with base files + per-target overlay files.
    fn seed_working(
        wc: &WorkingCopy<'_>,
        name: &PrimitiveName,
        base: &[(&str, &[u8])],
        overlays: &[(Target, &[(&str, &[u8])])],
    ) {
        for (rel, bytes) in base {
            wc.save_base_file(PrimitiveKind::Skill, name, Utf8Path::new(rel), bytes)
                .unwrap();
        }
        for (target, files) in overlays {
            for (rel, bytes) in *files {
                wc.save_target_file(PrimitiveKind::Skill, name, *target, Utf8Path::new(rel), bytes)
                    .unwrap();
            }
        }
    }

    #[test]
    fn rewrite_promotes_chosen_overlay_into_base() {
        let fx = Fx::new();
        let wc = WorkingCopy::new(fx.layout());
        let name = n("improve");
        seed_working(
            &wc,
            &name,
            &[("SKILL.md", b"base body")],
            &[(Target::Claude, &[("SKILL.md", b"claude body")])],
        );
        let old = wc.load(PrimitiveKind::Skill, &name).unwrap();
        apply_flatten_rewrite(&wc, PrimitiveKind::Skill, &name, Target::Claude, &old).unwrap();

        let new = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert_eq!(new.base[Utf8Path::new("SKILL.md")], b"claude body");
        assert!(new.targets.is_empty(), "promoted overlay should be gone");
    }

    #[test]
    fn rewrite_preserves_other_target_materialized_bytes() {
        let fx = Fx::new();
        let wc = WorkingCopy::new(fx.layout());
        let name = n("improve");
        seed_working(
            &wc,
            &name,
            &[("SKILL.md", b"base body")],
            &[
                (Target::Claude, &[("SKILL.md", b"claude body")]),
                (Target::Pi, &[("SKILL.md", b"pi body")]),
            ],
        );
        let old = wc.load(PrimitiveKind::Skill, &name).unwrap();
        let old_eff_pi = overlay_merge::merge(&old, Target::Pi);

        apply_flatten_rewrite(&wc, PrimitiveKind::Skill, &name, Target::Claude, &old).unwrap();

        let new = wc.load(PrimitiveKind::Skill, &name).unwrap();
        let new_eff_pi = overlay_merge::merge(&new, Target::Pi);
        assert_eq!(new_eff_pi, old_eff_pi, "Pi's Materialized bytes must be unchanged");
        assert_eq!(new.base[Utf8Path::new("SKILL.md")], b"claude body");
    }

    #[test]
    fn rewrite_converges_base_follower_in_memory() {
        let fx = Fx::new();
        let wc = WorkingCopy::new(fx.layout());
        let name = n("improve");
        // Codex has no overlay → base-follower.
        seed_working(
            &wc,
            &name,
            &[("SKILL.md", b"base body")],
            &[(Target::Claude, &[("SKILL.md", b"claude body")])],
        );
        let old = wc.load(PrimitiveKind::Skill, &name).unwrap();
        apply_flatten_rewrite(&wc, PrimitiveKind::Skill, &name, Target::Claude, &old).unwrap();

        let new = wc.load(PrimitiveKind::Skill, &name).unwrap();
        let codex_eff = overlay_merge::merge(&new, Target::Codex);
        assert_eq!(
            codex_eff[Utf8Path::new("SKILL.md")],
            b"claude body",
            "base-follower Codex converges to the new base"
        );
    }

    #[test]
    fn rewrite_drops_redundant_preserved_overlay_files() {
        let fx = Fx::new();
        let wc = WorkingCopy::new(fx.layout());
        let name = n("improve");
        // Pi's overlay file equals what will become the new base (claude body) →
        // it must be dropped from Pi's overlay as redundant after flatten.
        seed_working(
            &wc,
            &name,
            &[("SKILL.md", b"base body")],
            &[
                (Target::Claude, &[("SKILL.md", b"claude body")]),
                (Target::Pi, &[("SKILL.md", b"claude body")]),
            ],
        );
        let old = wc.load(PrimitiveKind::Skill, &name).unwrap();
        apply_flatten_rewrite(&wc, PrimitiveKind::Skill, &name, Target::Claude, &old).unwrap();

        let new = wc.load(PrimitiveKind::Skill, &name).unwrap();
        assert!(
            !new.targets.contains_key(&Target::Pi),
            "Pi overlay equal to the new base must be dropped"
        );
        // And Pi still materializes the same bytes (now via base).
        assert_eq!(
            overlay_merge::merge(&new, Target::Pi)[Utf8Path::new("SKILL.md")],
            b"claude body"
        );
    }

    #[test]
    fn classify_splits_converging_base_followers_from_preserved_overlays() {
        let fx = Fx::new();
        let wc = WorkingCopy::new(fx.layout());
        let name = n("improve");
        seed_working(
            &wc,
            &name,
            &[("SKILL.md", b"base body")],
            &[
                (Target::Claude, &[("SKILL.md", b"claude body")]),
                (Target::Pi, &[("SKILL.md", b"pi body")]),
            ],
        );
        let old = wc.load(PrimitiveKind::Skill, &name).unwrap();
        let (converged, preserved) = classify_flatten_targets(
            &old,
            &[Target::Claude, Target::Pi, Target::Codex],
            Target::Claude,
        );
        assert_eq!(converged, vec![Target::Codex]);
        assert_eq!(preserved, vec![Target::Pi]);
    }

    // ---- U2: full orchestration ----

    fn publish_two_overlays(
        fx: &Fx,
        base_body: &[u8],
        claude_body: &[u8],
        pi_body: &[u8],
    ) -> PrimitiveName {
        let name = n("improve");
        scaffold_skill(fx.layout(), &name, "2026-05-04T00:00:00Z").unwrap();
        let wc = WorkingCopy::new(fx.layout());
        wc.save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new("SKILL.md"), base_body)
            .unwrap();
        wc.save_target_file(PrimitiveKind::Skill, &name, Target::Claude, Utf8Path::new("SKILL.md"), claude_body)
            .unwrap();
        wc.save_target_file(PrimitiveKind::Skill, &name, Target::Pi, Utf8Path::new("SKILL.md"), pi_body)
            .unwrap();
        update_primitive_metadata(
            fx.layout(),
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
        VersionStore::new(fx.layout())
            .snapshot(
                PrimitiveKind::Skill,
                &name,
                &label("v1"),
                &VersionMetadata { created_at: "2026-05-04T00:00:01Z".into(), notes: None },
            )
            .unwrap();
        let ip = fx.install_paths();
        install(InstallRequest {
            layout: fx.layout(),
            install_paths: &ip,
            installs_file_path: &fx.installs_path,
            kind: PrimitiveKind::Skill,
            name: &name,
            targets: &[Target::Claude, Target::Pi],
            force: false,
            installed_at: "2026-05-04T00:00:02Z",
        })
        .unwrap();
        name
    }

    fn drift_all_clean(fx: &Fx, ip: &InstallPaths, name: &PrimitiveName) -> bool {
        scan_drift_for_primitive(ip, &fx.installs_path, PrimitiveKind::Skill, name)
            .unwrap()
            .iter()
            .all(|r| r.status == DriftStatus::Clean)
    }

    #[test]
    fn flatten_single_overlay_converges_everyone_and_clears_drift() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        let ip = fx.install_paths();
        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v2", false))
                .unwrap();
        match result {
            FlattenResult::Flattened { new_version, converged_targets, .. } => {
                assert_eq!(new_version.as_str(), "v2");
                assert_eq!(converged_targets, vec![Target::Codex]);
            }
            other => panic!("expected Flattened, got {other:?}"),
        }

        // New base == claude content; no overlays remain.
        let v2 = VersionStore::new(fx.layout())
            .read_version(PrimitiveKind::Skill, &name, &label("v2"))
            .unwrap();
        assert_eq!(v2.base[Utf8Path::new("SKILL.md")], b"---\n---\nclaude body\n");
        assert!(v2.targets.is_empty());

        // Codex install file rewritten to the new base.
        let codex_file = fx.home.join(".codex/skills/improve/SKILL.md");
        assert_eq!(std::fs::read(codex_file.as_std_path()).unwrap(), b"---\n---\nclaude body\n");

        // Both drift surfaces clean; every record on v2.
        assert!(drift_all_clean(&fx, &ip, &name));
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        for t in [Target::Claude, Target::Codex] {
            assert_eq!(
                installs.get(PrimitiveKind::Skill, &name, t).unwrap().installed_version.as_str(),
                "v2"
            );
        }
    }

    #[test]
    fn flatten_preserves_other_overlay_target_on_disk() {
        let fx = Fx::new();
        let name = publish_two_overlays(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            b"---\n---\npi body\n",
        );
        let ip = fx.install_paths();
        let pi_file = fx.home.join(".pi/agent/skills/improve/SKILL.md");
        let pi_before = std::fs::read(pi_file.as_std_path()).unwrap();

        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v2", false))
                .unwrap();
        match result {
            FlattenResult::Flattened { preserved_targets, .. } => {
                assert_eq!(preserved_targets, vec![Target::Pi]);
            }
            other => panic!("expected Flattened, got {other:?}"),
        }

        // Pi's install file is byte-unchanged and Pi drift stays Clean.
        assert_eq!(std::fs::read(pi_file.as_std_path()).unwrap(), pi_before);
        assert_eq!(pi_before, b"---\n---\npi body\n");
        assert!(drift_all_clean(&fx, &ip, &name));
    }

    #[test]
    fn flatten_aborts_on_dirty_base_follower_without_force() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        let ip = fx.install_paths();
        // Hand-edit the Codex install. Sleep past the 1s mtime resolution so the
        // drift scanner's mtime gate actually re-hashes and sees the edit.
        let codex_file = fx.home.join(".codex/skills/improve/SKILL.md");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(codex_file.as_std_path(), b"---\n---\nhand edited\n").unwrap();

        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v2", false))
                .unwrap();
        match result {
            FlattenResult::ConvergingConflicts { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert_eq!(conflicts[0].target, Target::Codex);
            }
            other => panic!("expected ConvergingConflicts, got {other:?}"),
        }

        // Nothing written: no v2, codex file unchanged, records still v1.
        let versions = VersionStore::new(fx.layout())
            .list_versions(PrimitiveKind::Skill, &name)
            .unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(std::fs::read(codex_file.as_std_path()).unwrap(), b"---\n---\nhand edited\n");
        let installs = InstallsFile::load(&fx.installs_path).unwrap();
        assert_eq!(
            installs.get(PrimitiveKind::Skill, &name, Target::Claude).unwrap().installed_version.as_str(),
            "v1"
        );
    }

    #[test]
    fn flatten_force_clobbers_dirty_base_follower() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        let ip = fx.install_paths();
        let codex_file = fx.home.join(".codex/skills/improve/SKILL.md");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(codex_file.as_std_path(), b"---\n---\nhand edited\n").unwrap();

        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v2", true))
                .unwrap();
        assert!(matches!(result, FlattenResult::Flattened { .. }));
        // Codex clobbered to the new base; drift clean.
        assert_eq!(std::fs::read(codex_file.as_std_path()).unwrap(), b"---\n---\nclaude body\n");
        assert!(drift_all_clean(&fx, &ip, &name));
    }

    #[test]
    fn flatten_refuses_dirty_working_copy() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        // Unpublished edit in working/.
        WorkingCopy::new(fx.layout())
            .save_base_file(PrimitiveKind::Skill, &name, Utf8Path::new("SKILL.md"), b"---\n---\nunpublished\n")
            .unwrap();
        let ip = fx.install_paths();
        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v2", false))
                .unwrap();
        assert_eq!(result, FlattenResult::WorkingCopyDirty);
        // No new version.
        let versions = VersionStore::new(fx.layout())
            .list_versions(PrimitiveKind::Skill, &name)
            .unwrap();
        assert_eq!(versions.len(), 1);
    }

    #[test]
    fn flatten_refuses_base_follower_source() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        let ip = fx.install_paths();
        // Codex has no overlay → cannot be promoted.
        let result =
            flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Codex, "v2", false))
                .unwrap();
        assert_eq!(result, FlattenResult::NotAnOverlayTarget);
    }

    #[test]
    fn flatten_existing_label_errors() {
        let fx = Fx::new();
        let name = published_with_overlay(
            &fx,
            b"---\n---\nbase body\n",
            b"---\n---\nclaude body\n",
            &[Target::Claude, Target::Codex],
        );
        let ip = fx.install_paths();
        // Reusing the current label must error (immutability).
        let err = flatten_promote_to_base(flatten_req(&fx, &ip, &name, Target::Claude, "v1", false))
            .unwrap_err();
        assert!(matches!(err, Error::VersionExists(_)), "got {err:?}");
    }
}
