//! P5.0: Bootstrap scanner — read the user's existing
//! `~/.claude/`, `~/.pi/`, `~/.codex/` source dirs and classify each entry.
//!
//! The output is a flat `Vec<ScanResult>` where each entry is one of:
//!
//! - [`ScanResult::Candidate`] — a proper primitive matching the expected
//!   layout. `parse` flags whether the primary file's frontmatter/TOML
//!   parsed (`Parsed`) or didn't (`Unparseable { reason }`); the latter is
//!   demoted to "import-as-overlay-with-warning" by the deduper.
//! - [`ScanResult::Symlinked`] — `lstat` identified a symlink under a known
//!   root. We do not follow symlinks; the wizard surfaces these and lets
//!   the user choose to resolve, skip, or import as-is.
//! - [`ScanResult::Unclassified`] — the entry sits under a known root but
//!   doesn't match the expected layout (e.g. a "skill" dir without
//!   `SKILL.md`, or a stray file where a directory was expected). Never
//!   auto-imported.
//!
//! Hidden files (`.DS_Store`, `._*`, `*.swp`, `*~`, `.git/`, …) are filtered
//! via the shared [`is_ignored`] allowlist. Project-scope sources
//! (`<repo>/.claude/skills/`) are out of scope for v1 — only user-scope
//! roots are scanned.

use std::fs;
use std::time::UNIX_EPOCH;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    is_ignored, CodexAgentFile, MdPrimitive, PrimitiveKind, PrimitiveName, Target,
};

/// One entry observed while scanning the source dirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ScanResult {
    /// Layout matches; primary file may or may not have parsed.
    Candidate {
        #[specta(type = String)]
        source_path: Utf8PathBuf,
        kind: PrimitiveKind,
        target: Target,
        name: PrimitiveName,
        parse: ParseStatus,
        /// Aggregate info the deduper uses to decide identical-vs-differs
        /// and which target wins the base assignment.
        info: CandidateInfo,
    },
    /// `lstat` showed a symlink under a known root. The wizard offers
    /// `[Resolve & import] [Skip] [Import as-is]`.
    Symlinked {
        #[specta(type = String)]
        source_path: Utf8PathBuf,
        kind: PrimitiveKind,
        target: Target,
        #[specta(type = Option<String>)]
        link_target: Option<Utf8PathBuf>,
    },
    /// Entry is under a known root but doesn't match the expected layout —
    /// surfaced to the wizard's "Couldn't classify" pane. The user picks a
    /// kind manually or skips.
    Unclassified {
        #[specta(type = String)]
        source_path: Utf8PathBuf,
        kind: PrimitiveKind,
        target: Target,
        reason: String,
    },
}

/// Whether the candidate's primary file (frontmatter/TOML) parsed cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ParseStatus {
    Parsed,
    /// Primary file is malformed. Eligible for import-as-overlay-with-warning;
    /// if every member of a dedupe group is unparseable the deduper surfaces
    /// the group as "needs manual review".
    Unparseable { reason: String },
}

/// Aggregate info computed once per candidate during the scan.
///
/// `content_hash` is a blake3 over the sorted `(relpath, bytes)` tuples for
/// dir-form candidates, or the single file's bytes for flat-form. Two
/// candidates with the same hash are byte-identical.
///
/// `file_count` is 1 for flat-form, the count of non-ignored files (recursive)
/// for dir-form. Used as the primary tiebreak when picking a `Differs` base.
///
/// `latest_mtime_unix` is the max file mtime in the candidate, in seconds
/// since the epoch. Used as the secondary tiebreak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CandidateInfo {
    pub content_hash: String,
    pub file_count: u32,
    pub latest_mtime_unix: i64,
}

/// (kind, target, path-suffix-from-home). Order is the user-visible scan
/// order; the wizard renders groups in this order so longer-running scans
/// stream a stable surface.
pub(crate) const SCAN_MATRIX: &[(PrimitiveKind, Target, &str)] = &[
    (PrimitiveKind::Skill, Target::Claude, ".claude/skills"),
    (PrimitiveKind::Skill, Target::Pi, ".pi/agent/skills"),
    (PrimitiveKind::Skill, Target::Codex, ".codex/skills"),
    (PrimitiveKind::Agent, Target::Claude, ".claude/agents"),
    (PrimitiveKind::Agent, Target::Pi, ".pi/agent/agents"),
    (PrimitiveKind::Command, Target::Claude, ".claude/commands"),
    (PrimitiveKind::Command, Target::Pi, ".pi/agent/prompts"),
    (PrimitiveKind::Command, Target::Codex, ".codex/prompts"),
    (PrimitiveKind::CodexAgent, Target::Codex, ".codex/agents"),
];

/// Walk every (kind, target) root under `home` and emit one [`ScanResult`]
/// per entry. Missing roots are silently skipped — many users only have a
/// subset of the supported tools installed.
///
/// Pure file I/O — no network, no library writes. Safe to run on the user's
/// real `~` from a dry-run preview.
pub fn scan_install_roots(home: &Utf8Path) -> Vec<ScanResult> {
    let mut out = Vec::new();
    for &(kind, target, suffix) in SCAN_MATRIX {
        let root = home.join(suffix);
        if !root.exists() {
            continue;
        }
        scan_root(kind, target, &root, &mut out);
    }
    out
}

/// Classify a single dropped path. Returns `None` when the path is not
/// directly under one of the install roots in [`SCAN_MATRIX`] — in that case
/// the caller should fall back to the multi-step bootstrap wizard. Used by
/// the drag-drop fast path to import one file/dir without scanning the whole
/// home tree.
pub fn classify_path(home: &Utf8Path, path: &Utf8Path) -> Option<ScanResult> {
    for &(kind, target, suffix) in SCAN_MATRIX {
        let root = home.join(suffix);
        let rel = match path.strip_prefix(&root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Only direct children of an install root are recognized — nested
        // entries (e.g. files inside a Skill dir) should drop the parent.
        if rel.components().count() != 1 {
            return None;
        }
        let lmeta = fs::symlink_metadata(path.as_std_path()).ok()?;
        if lmeta.file_type().is_symlink() {
            let link_target = fs::read_link(path.as_std_path())
                .ok()
                .and_then(|p| Utf8PathBuf::from_path_buf(p).ok());
            return Some(ScanResult::Symlinked {
                source_path: path.to_owned(),
                kind,
                target,
                link_target,
            });
        }
        return Some(classify_entry(
            kind,
            target,
            path.to_owned(),
            lmeta.file_type().is_dir(),
        ));
    }
    None
}

fn scan_root(
    kind: PrimitiveKind,
    target: Target,
    root: &Utf8Path,
    out: &mut Vec<ScanResult>,
) {
    let entries = match fs::read_dir(root.as_std_path()) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = match Utf8PathBuf::from_path_buf(entry.path()) {
            Ok(p) => p,
            Err(_) => continue, // non-UTF-8 — skip silently
        };
        let leaf = match path.file_name() {
            Some(n) => n,
            None => continue,
        };
        if is_ignored(Utf8Path::new(leaf)) {
            continue;
        }
        let lmeta = match fs::symlink_metadata(path.as_std_path()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if lmeta.file_type().is_symlink() {
            let link_target = fs::read_link(path.as_std_path())
                .ok()
                .and_then(|p| Utf8PathBuf::from_path_buf(p).ok());
            out.push(ScanResult::Symlinked {
                source_path: path,
                kind,
                target,
                link_target,
            });
            continue;
        }
        out.push(classify_entry(kind, target, path, lmeta.file_type().is_dir()));
    }
}

fn classify_entry(
    kind: PrimitiveKind,
    target: Target,
    path: Utf8PathBuf,
    is_dir: bool,
) -> ScanResult {
    let leaf = path.file_name().expect("scan entry has file_name").to_owned();

    match (kind, target) {
        // Skill: always a directory with SKILL.md inside.
        (PrimitiveKind::Skill, _) => {
            if !is_dir {
                return unclassified(kind, target, path, "expected a directory for a Skill entry");
            }
            classify_dir_with_primary(kind, target, path, &leaf, "SKILL.md", PrimaryFormat::Md)
        }
        // Agent on Claude: flat `<name>.md` OR dir form `<name>/agent.md`.
        (PrimitiveKind::Agent, Target::Claude) => {
            if is_dir {
                classify_dir_with_primary(kind, target, path, &leaf, "agent.md", PrimaryFormat::Md)
            } else {
                classify_flat_md(kind, target, path, &leaf)
            }
        }
        // Agent on Pi: dir form only.
        (PrimitiveKind::Agent, Target::Pi) => {
            if !is_dir {
                return unclassified(
                    kind,
                    target,
                    path,
                    "expected a directory for an Agent on Pi",
                );
            }
            classify_dir_with_primary(kind, target, path, &leaf, "agent.md", PrimaryFormat::Md)
        }
        // Command: flat `<name>.md` only.
        (PrimitiveKind::Command, _) => {
            if is_dir {
                return unclassified(kind, target, path, "expected a single file for a Command");
            }
            classify_flat_md(kind, target, path, &leaf)
        }
        // CodexAgent: flat `<name>.toml` only.
        (PrimitiveKind::CodexAgent, Target::Codex) => {
            if is_dir {
                return unclassified(
                    kind,
                    target,
                    path,
                    "expected a .toml file for a Codex Agent",
                );
            }
            classify_flat_toml(kind, target, path, &leaf)
        }
        // Any other (kind, target) shouldn't be in SCAN_MATRIX, but be
        // explicit so the compiler warns if the matrix gains a new pair.
        _ => unclassified(
            kind,
            target,
            path,
            "no scan layout for this (kind, target) pair",
        ),
    }
}

#[derive(Debug, Clone, Copy)]
enum PrimaryFormat {
    Md,
}

fn classify_dir_with_primary(
    kind: PrimitiveKind,
    target: Target,
    dir_path: Utf8PathBuf,
    dir_leaf: &str,
    primary_filename: &str,
    fmt: PrimaryFormat,
) -> ScanResult {
    let name = match PrimitiveName::try_new(dir_leaf) {
        Ok(n) => n,
        Err(e) => return unclassified(kind, target, dir_path, e.to_string()),
    };
    let primary = dir_path.join(primary_filename);
    if !primary.exists() {
        return ScanResult::Unclassified {
            source_path: dir_path,
            kind,
            target,
            reason: format!("missing `{primary_filename}` inside the directory"),
        };
    }
    let parse = parse_primary(&primary, fmt);
    let info = compute_dir_info(&dir_path);
    ScanResult::Candidate {
        source_path: dir_path,
        kind,
        target,
        name,
        parse,
        info,
    }
}

fn classify_flat_md(
    kind: PrimitiveKind,
    target: Target,
    path: Utf8PathBuf,
    leaf: &str,
) -> ScanResult {
    let stem = match leaf.strip_suffix(".md") {
        Some(s) => s,
        None => return unclassified(kind, target, path, format!("expected a .md file, got `{leaf}`")),
    };
    let name = match PrimitiveName::try_new(stem) {
        Ok(n) => n,
        Err(e) => return unclassified(kind, target, path, e.to_string()),
    };
    let parse = parse_primary(&path, PrimaryFormat::Md);
    let info = compute_flat_info(&path);
    ScanResult::Candidate {
        source_path: path,
        kind,
        target,
        name,
        parse,
        info,
    }
}

fn classify_flat_toml(
    kind: PrimitiveKind,
    target: Target,
    path: Utf8PathBuf,
    leaf: &str,
) -> ScanResult {
    let stem = match leaf.strip_suffix(".toml") {
        Some(s) => s,
        None => {
            return unclassified(kind, target, path, format!("expected a .toml file, got `{leaf}`"))
        }
    };
    let name = match PrimitiveName::try_new(stem) {
        Ok(n) => n,
        Err(e) => return unclassified(kind, target, path, e.to_string()),
    };
    let parse = match fs::read(path.as_std_path()) {
        Ok(bytes) => match CodexAgentFile::parse(&bytes) {
            Ok(_) => ParseStatus::Parsed,
            Err(e) => ParseStatus::Unparseable {
                reason: e.to_string(),
            },
        },
        Err(e) => ParseStatus::Unparseable {
            reason: e.to_string(),
        },
    };
    let info = compute_flat_info(&path);
    ScanResult::Candidate {
        source_path: path,
        kind,
        target,
        name,
        parse,
        info,
    }
}

fn parse_primary(primary: &Utf8Path, fmt: PrimaryFormat) -> ParseStatus {
    let bytes = match fs::read(primary.as_std_path()) {
        Ok(b) => b,
        Err(e) => {
            return ParseStatus::Unparseable {
                reason: e.to_string(),
            };
        }
    };
    match fmt {
        PrimaryFormat::Md => match MdPrimitive::parse(&bytes) {
            Ok(_) => ParseStatus::Parsed,
            Err(e) => ParseStatus::Unparseable {
                reason: e.to_string(),
            },
        },
    }
}

/// Hash + count + latest mtime over every non-ignored file under `dir_path`
/// (recursive). On any I/O error we degrade to a sentinel `CandidateInfo`
/// rather than re-classify the candidate — the parse status already covers
/// "we couldn't read enough to import this".
fn compute_dir_info(dir_path: &Utf8Path) -> CandidateInfo {
    let mut files: Vec<(Utf8PathBuf, Vec<u8>, i64)> = Vec::new();
    if walk_collect(dir_path, dir_path, &mut files).is_err() {
        return CandidateInfo {
            content_hash: String::new(),
            file_count: 0,
            latest_mtime_unix: 0,
        };
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = blake3::Hasher::new();
    let mut latest = 0i64;
    for (rel, bytes, mtime) in &files {
        // Length-prefixed framing keeps `(rel, bytes)` boundaries unambiguous.
        let rel_str = rel.as_str();
        h.update(&(rel_str.len() as u64).to_le_bytes());
        h.update(rel_str.as_bytes());
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(bytes);
        if *mtime > latest {
            latest = *mtime;
        }
    }
    CandidateInfo {
        content_hash: h.finalize().to_hex().to_string(),
        file_count: files.len() as u32,
        latest_mtime_unix: latest,
    }
}

/// Hash + count + mtime of a single flat file.
fn compute_flat_info(path: &Utf8Path) -> CandidateInfo {
    let bytes = match fs::read(path.as_std_path()) {
        Ok(b) => b,
        Err(_) => {
            return CandidateInfo {
                content_hash: String::new(),
                file_count: 0,
                latest_mtime_unix: 0,
            }
        }
    };
    let mtime = mtime_unix(path).unwrap_or(0);
    CandidateInfo {
        content_hash: blake3::hash(&bytes).to_hex().to_string(),
        file_count: 1,
        latest_mtime_unix: mtime,
    }
}

fn walk_collect(
    root: &Utf8Path,
    cur: &Utf8Path,
    out: &mut Vec<(Utf8PathBuf, Vec<u8>, i64)>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(cur.as_std_path())? {
        let entry = entry?;
        let abs = match Utf8PathBuf::from_path_buf(entry.path()) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let leaf = match abs.file_name() {
            Some(n) => n,
            None => continue,
        };
        if is_ignored(Utf8Path::new(leaf)) {
            continue;
        }
        let lmeta = fs::symlink_metadata(abs.as_std_path())?;
        // Don't descend into symlinks — the candidate scanner already
        // surfaces top-level symlinks as their own variant; nested links
        // inside a candidate dir are skipped to keep hashing deterministic.
        if lmeta.file_type().is_symlink() {
            continue;
        }
        if lmeta.is_dir() {
            walk_collect(root, &abs, out)?;
        } else {
            let bytes = fs::read(abs.as_std_path())?;
            let mtime = mtime_unix(&abs).unwrap_or(0);
            let rel = abs.strip_prefix(root).unwrap_or(&abs).to_owned();
            out.push((rel, bytes, mtime));
        }
    }
    Ok(())
}

fn mtime_unix(p: &Utf8Path) -> Option<i64> {
    fs::metadata(p.as_std_path())
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn unclassified(
    kind: PrimitiveKind,
    target: Target,
    source_path: Utf8PathBuf,
    reason: impl Into<String>,
) -> ScanResult {
    ScanResult::Unclassified {
        source_path,
        kind,
        target,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs as unix_fs;
    use tempfile::TempDir;

    struct Fixture {
        _tmp: TempDir,
        home: Utf8PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = TempDir::new().unwrap();
            let home = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
            Self { _tmp: tmp, home }
        }

        fn write(&self, rel: &str, bytes: &[u8]) -> Utf8PathBuf {
            let abs = self.home.join(rel);
            std::fs::create_dir_all(abs.parent().unwrap().as_std_path()).unwrap();
            std::fs::write(abs.as_std_path(), bytes).unwrap();
            abs
        }

        fn mkdir(&self, rel: &str) -> Utf8PathBuf {
            let abs = self.home.join(rel);
            std::fs::create_dir_all(abs.as_std_path()).unwrap();
            abs
        }
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn find_candidate<'a>(
        results: &'a [ScanResult],
        kind: PrimitiveKind,
        target: Target,
        n: &PrimitiveName,
    ) -> Option<&'a ScanResult> {
        results.iter().find(|r| match r {
            ScanResult::Candidate {
                kind: k,
                target: t,
                name: cn,
                ..
            } => k == &kind && t == &target && cn == n,
            _ => false,
        })
    }

    #[test]
    fn empty_home_returns_no_results() {
        let fx = Fixture::new();
        let results = scan_install_roots(&fx.home);
        assert!(results.is_empty(), "got: {results:?}");
    }

    #[test]
    fn claude_skill_with_skill_md_is_parsed_candidate() {
        let fx = Fixture::new();
        fx.write(
            ".claude/skills/diagnose/SKILL.md",
            b"---\ndescription: ok\n---\nbody\n",
        );
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Skill, Target::Claude, &name("diagnose"))
            .expect("Skill claude diagnose found");
        match c {
            ScanResult::Candidate {
                source_path,
                parse,
                ..
            } => {
                assert!(source_path.ends_with(".claude/skills/diagnose"));
                assert_eq!(parse, &ParseStatus::Parsed);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn unparseable_skill_md_yields_candidate_with_unparseable_status() {
        let fx = Fixture::new();
        fx.write(
            ".claude/skills/broken/SKILL.md",
            b"no frontmatter here just text",
        );
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Skill, Target::Claude, &name("broken"))
            .expect("broken candidate present");
        match c {
            ScanResult::Candidate { parse, .. } => {
                assert!(matches!(parse, ParseStatus::Unparseable { .. }));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn skill_dir_without_skill_md_is_unclassified() {
        let fx = Fixture::new();
        fx.mkdir(".claude/skills/no-primary");
        let results = scan_install_roots(&fx.home);
        let unclass = results.iter().find_map(|r| match r {
            ScanResult::Unclassified {
                kind: PrimitiveKind::Skill,
                target: Target::Claude,
                reason,
                source_path,
                ..
            } if source_path.ends_with("no-primary") => Some(reason.clone()),
            _ => None,
        });
        let reason = unclass.expect("expected Unclassified for empty skill dir");
        assert!(reason.contains("SKILL.md"), "got: {reason}");
    }

    #[test]
    fn agent_claude_flat_md_is_parsed_candidate() {
        let fx = Fixture::new();
        fx.write(".claude/agents/helper.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Agent, Target::Claude, &name("helper"))
            .expect("flat agent.md candidate");
        match c {
            ScanResult::Candidate { source_path, parse, .. } => {
                assert!(source_path.ends_with("helper.md"));
                assert_eq!(parse, &ParseStatus::Parsed);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn agent_claude_dir_form_is_parsed_candidate() {
        let fx = Fixture::new();
        fx.write(".claude/agents/multi/agent.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Agent, Target::Claude, &name("multi"))
            .expect("dir-form agent candidate");
        match c {
            ScanResult::Candidate { source_path, .. } => {
                assert!(source_path.ends_with("multi"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn agent_pi_must_be_dir_form() {
        let fx = Fixture::new();
        fx.write(".pi/agent/agents/helper.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        // Should produce Unclassified, not Candidate.
        assert!(find_candidate(&results, PrimitiveKind::Agent, Target::Pi, &name("helper")).is_none());
        let unclass = results.iter().any(|r| matches!(
            r,
            ScanResult::Unclassified { kind: PrimitiveKind::Agent, target: Target::Pi, .. }
        ));
        assert!(unclass);
    }

    #[test]
    fn command_flat_md_is_parsed_candidate() {
        let fx = Fixture::new();
        fx.write(".claude/commands/diag.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Command, Target::Claude, &name("diag"))
            .expect("command candidate");
        assert!(matches!(c, ScanResult::Candidate { .. }));
    }

    #[test]
    fn command_codex_lives_under_codex_prompts() {
        let fx = Fixture::new();
        fx.write(".codex/prompts/run.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::Command, Target::Codex, &name("run"))
            .expect("codex command candidate");
        assert!(matches!(c, ScanResult::Candidate { .. }));
    }

    #[test]
    fn codex_agent_toml_is_parsed_candidate() {
        let fx = Fixture::new();
        fx.write(".codex/agents/review.toml", b"name = \"review\"\n");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::CodexAgent, Target::Codex, &name("review"))
            .expect("codex agent candidate");
        match c {
            ScanResult::Candidate { parse, .. } => assert_eq!(parse, &ParseStatus::Parsed),
            _ => unreachable!(),
        }
    }

    #[test]
    fn unparseable_codex_agent_toml_marked_unparseable() {
        let fx = Fixture::new();
        fx.write(".codex/agents/bad.toml", b"= not valid toml");
        let results = scan_install_roots(&fx.home);
        let c = find_candidate(&results, PrimitiveKind::CodexAgent, Target::Codex, &name("bad"))
            .expect("bad toml candidate");
        match c {
            ScanResult::Candidate { parse, .. } => {
                assert!(matches!(parse, ParseStatus::Unparseable { .. }));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn ds_store_and_other_hidden_files_are_filtered() {
        let fx = Fixture::new();
        fx.mkdir(".claude/skills");
        fx.write(".claude/skills/.DS_Store", b"junk");
        fx.write(".claude/skills/._hidden", b"junk");
        fx.write(".claude/skills/diagnose/SKILL.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        // Only the proper skill survives.
        let candidate_count = results.iter().filter(|r| matches!(r, ScanResult::Candidate { .. })).count();
        assert_eq!(candidate_count, 1);
        // No Unclassified for .DS_Store either — filtered before classification.
        let unclassified_count =
            results.iter().filter(|r| matches!(r, ScanResult::Unclassified { .. })).count();
        assert_eq!(unclassified_count, 0);
    }

    #[test]
    fn symlinked_skill_dir_is_emitted_as_symlinked_not_followed() {
        let fx = Fixture::new();
        // Real skill outside the scan root.
        let real = fx.write("elsewhere/realskill/SKILL.md", b"---\n---\nbody\n");
        let real_dir = real.parent().unwrap().to_owned();
        // Symlink under .claude/skills pointing at the real dir.
        fx.mkdir(".claude/skills");
        let link = fx.home.join(".claude/skills/linked");
        unix_fs::symlink(real_dir.as_std_path(), link.as_std_path()).unwrap();
        let results = scan_install_roots(&fx.home);
        let symlinked = results.iter().find_map(|r| match r {
            ScanResult::Symlinked {
                source_path,
                link_target,
                ..
            } if source_path.ends_with("linked") => Some(link_target.clone()),
            _ => None,
        });
        assert!(symlinked.is_some(), "expected Symlinked entry: {results:?}");
        // The real skill's content was NOT scanned — no Candidate for it
        // since the scanner doesn't follow symlinks.
        assert!(find_candidate(&results, PrimitiveKind::Skill, Target::Claude, &name("linked")).is_none());
    }

    #[test]
    fn invalid_primitive_name_yields_unclassified() {
        let fx = Fixture::new();
        // Stem is rejected by PrimitiveName::try_new (leading dot in stem).
        // The whole filename `.hidden.md` is not an `is_ignored` match, so
        // it passes the filter and surfaces as Unclassified for the
        // wizard's "Couldn't classify" pane.
        fx.write(".claude/commands/.hidden.md", b"---\n---\nbody\n");
        let results = scan_install_roots(&fx.home);
        let unclass = results.iter().any(|r| matches!(
            r,
            ScanResult::Unclassified {
                kind: PrimitiveKind::Command,
                target: Target::Claude,
                source_path,
                ..
            } if source_path.ends_with(".hidden.md")
        ));
        assert!(unclass, "expected Unclassified for `.hidden.md`: {results:?}");
    }

    #[test]
    fn cross_target_same_name_emits_one_candidate_per_target() {
        let fx = Fixture::new();
        fx.write(".claude/skills/diagnose/SKILL.md", b"---\n---\nclaude\n");
        fx.write(".pi/agent/skills/diagnose/SKILL.md", b"---\n---\npi\n");
        fx.write(".codex/skills/diagnose/SKILL.md", b"---\n---\ncodex\n");
        let results = scan_install_roots(&fx.home);
        for target in [Target::Claude, Target::Pi, Target::Codex] {
            assert!(
                find_candidate(&results, PrimitiveKind::Skill, target, &name("diagnose")).is_some(),
                "missing diagnose for {target:?}"
            );
        }
    }

    #[test]
    fn missing_root_dirs_are_silently_skipped() {
        // No roots exist at all — caller still gets a clean Vec.
        let fx = Fixture::new();
        let results = scan_install_roots(&fx.home);
        assert!(results.is_empty());
    }

    #[test]
    fn codex_system_and_memories_dirs_are_not_scanned() {
        // SCAN_MATRIX only enumerates skills/prompts/agents under .codex/ —
        // anything under .codex/.system/, .codex/memories/, .codex/rules/
        // is naturally never touched.
        let fx = Fixture::new();
        fx.write(".codex/.system/foo.md", b"system rule");
        fx.write(".codex/memories/bar.md", b"memory");
        fx.write(".codex/rules/baz.md", b"rule");
        let results = scan_install_roots(&fx.home);
        assert!(results.is_empty());
    }
}
