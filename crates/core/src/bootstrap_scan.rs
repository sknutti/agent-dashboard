//! P5.5b: Orchestrated scan — composes [`scan_install_roots`] +
//! [`dedupe`] + [`cross_reference`] into the single round-trip the
//! frontend's bootstrap wizard needs.
//!
//! Optionally emits [`ScanProgress`] events through a caller-provided
//! callback. The IPC layer wires that callback to a Tauri typed
//! channel; tests pass a recording closure.

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    cross_reference, dedupe, scan_install_roots, CrossReferenceSummary, CrossReferenced, Error,
    LibraryLayout,
};

/// Progress event emitted while [`bootstrap_scan`] runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScanProgress {
    /// Starting filesystem scan of the user's install roots.
    Stage { label: String },
    /// Final event — carries the wizard banner counts. Always fires last.
    Done { summary: CrossReferenceSummary },
}

/// Run the full bootstrap discovery pipeline against `home` and the
/// existing library at `layout`. `on_progress` receives one event per
/// stage and a final `Done`.
pub fn bootstrap_scan<F: FnMut(ScanProgress)>(
    home: &Utf8Path,
    layout: LibraryLayout<'_>,
    mut on_progress: F,
) -> Result<CrossReferenced, Error> {
    on_progress(ScanProgress::Stage {
        label: "Scanning install roots…".into(),
    });
    let scanned = scan_install_roots(home);
    on_progress(ScanProgress::Stage {
        label: "Deduplicating candidates…".into(),
    });
    let deduped = dedupe(scanned);
    on_progress(ScanProgress::Stage {
        label: "Cross-referencing library state…".into(),
    });
    let classified = cross_reference(deduped, layout)?;
    on_progress(ScanProgress::Done {
        summary: classified.summary(),
    });
    Ok(classified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PrimitiveKind;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Utf8PathBuf, Utf8PathBuf) {
        let tmp = TempDir::new().unwrap();
        let lib = Utf8PathBuf::from_path_buf(tmp.path().join("lib")).unwrap();
        let home = Utf8PathBuf::from_path_buf(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(lib.as_std_path()).unwrap();
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        (tmp, lib, home)
    }

    #[test]
    fn bootstrap_scan_emits_stage_events_then_done() {
        let (_tmp, lib, home) = fixture();
        let layout = LibraryLayout::new(&lib);
        let claude = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::write(claude.join("SKILL.md").as_std_path(), b"---\n---\nb\n").unwrap();

        let mut events: Vec<ScanProgress> = Vec::new();
        bootstrap_scan(&home, layout, |e| events.push(e)).unwrap();

        assert_eq!(
            events[0],
            ScanProgress::Stage {
                label: "Scanning install roots…".into()
            }
        );
        assert_eq!(
            events[1],
            ScanProgress::Stage {
                label: "Deduplicating candidates…".into()
            }
        );
        assert_eq!(
            events[2],
            ScanProgress::Stage {
                label: "Cross-referencing library state…".into()
            }
        );
        let last = events.last().expect("at least one event");
        match last {
            ScanProgress::Done { summary } => {
                assert_eq!(summary.new, 1);
                assert_eq!(summary.already_imported, 0);
            }
            ScanProgress::Stage { .. } => panic!("expected final Done event"),
        }
    }

    #[test]
    fn bootstrap_scan_returns_cross_referenced_for_a_fresh_candidate() {
        let (_tmp, lib, home) = fixture();
        let layout = LibraryLayout::new(&lib);
        let claude = home.join(".claude/skills/diagnose");
        std::fs::create_dir_all(claude.as_std_path()).unwrap();
        std::fs::write(
            claude.join("SKILL.md").as_std_path(),
            b"---\n---\nbody\n",
        )
        .unwrap();

        let result = bootstrap_scan(&home, layout, |_| {}).unwrap();
        // Library is empty → the candidate classifies as `New`.
        assert_eq!(result.groups.len(), 1);
        let s = result.summary();
        assert_eq!(s.new, 1);
        assert_eq!(s.already_imported, 0);
        assert_eq!(s.drifted, 0);
        let _ = PrimitiveKind::Skill; // silence unused import lint if no other use
    }
}
