//! P5.4c: Bootstrap session checkpoint state.
//!
//! `bootstrap-session.json` records which primitives in a bootstrap batch
//! have already landed in the library, so a relaunch after a crash or
//! quit-mid-bootstrap can offer Resume/Discard/Start-over without
//! re-doing completed work.
//!
//! Scope of this slice is the data layer only: [`BootstrapSession`] +
//! atomic save/load/clear. The orchestrator that calls [`record_create`]
//! /[`record_reimport`] between each successful primitive write lands in
//! P5.4d.

use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::fs_helpers::atomic_write;
use crate::{BootstrapPlan, CreateAction, Error, PrimitiveKind, PrimitiveName, ReimportAction};

/// Current schema version of `bootstrap-session.json`. Bump on breaking
/// changes; readers fall back to "no resumable session" on mismatch.
pub const FORMAT_VERSION: u32 = 2;

/// Persistent record of a bootstrap batch's progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BootstrapSession {
    pub format_version: u32,
    /// RFC3339 UTC timestamp the bootstrap began. Lets the wizard show
    /// "Resume bootstrap from <when>?" rather than a bare prompt.
    pub started_at: String,
    /// True once the source-dir backup has been written for this batch.
    /// Lets the frontend persist pre-execution review state without
    /// accidentally suppressing the first backup.
    pub backup_taken: bool,
    /// Executable action ids the user unchecked during review.
    pub excluded_ids: Vec<String>,
    pub completed: Vec<CompletedItem>,
}

/// A single primitive that's already been applied during this bootstrap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CompletedItem {
    pub kind: PrimitiveKind,
    pub name: PrimitiveName,
    pub action: ActionKind,
}

/// Whether the completed item was a `New` create (v1) or a `Drifted`
/// reimport (vN+1). Tracked separately so a primitive can in principle
/// appear twice in one session (theoretically impossible today —
/// `derive_plan` puts each (kind, name) into exactly one bucket — but
/// recording it explicitly keeps the resume filter robust if the plan
/// shape changes later).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActionKind {
    Create,
    Reimport,
}

impl BootstrapSession {
    /// Open a new empty session that started at `timestamp`.
    pub fn new(timestamp: impl Into<String>) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            started_at: timestamp.into(),
            backup_taken: false,
            excluded_ids: Vec::new(),
            completed: Vec::new(),
        }
    }

    /// Replace the persisted set of user-excluded action ids.
    pub fn set_excluded_ids(&mut self, excluded_ids: Vec<String>) {
        self.excluded_ids = excluded_ids;
    }

    /// Mark a `(kind, name)` create-action as done.
    pub fn record_create(&mut self, kind: PrimitiveKind, name: &PrimitiveName) {
        self.completed.push(CompletedItem {
            kind,
            name: name.clone(),
            action: ActionKind::Create,
        });
    }

    /// Mark a `(kind, name)` reimport-action as done.
    pub fn record_reimport(&mut self, kind: PrimitiveKind, name: &PrimitiveName) {
        self.completed.push(CompletedItem {
            kind,
            name: name.clone(),
            action: ActionKind::Reimport,
        });
    }

    /// Has the create for `(kind, name)` already landed?
    pub fn is_create_done(&self, kind: PrimitiveKind, name: &PrimitiveName) -> bool {
        self.completed.iter().any(|c| {
            c.kind == kind && &c.name == name && matches!(c.action, ActionKind::Create)
        })
    }

    /// Has the reimport for `(kind, name)` already landed?
    pub fn is_reimport_done(&self, kind: PrimitiveKind, name: &PrimitiveName) -> bool {
        self.completed.iter().any(|c| {
            c.kind == kind && &c.name == name && matches!(c.action, ActionKind::Reimport)
        })
    }

    /// Return a new [`BootstrapPlan`] containing only actions not yet
    /// recorded as done. Stable in input order.
    pub fn filter_remaining(&self, plan: &BootstrapPlan) -> BootstrapPlan {
        let creates = plan
            .creates
            .iter()
            .filter(|a: &&CreateAction| !self.is_create_done(a.kind, &a.name))
            .cloned()
            .collect();
        let reimports = plan
            .reimports
            .iter()
            .filter(|a: &&ReimportAction| !self.is_reimport_done(a.kind, &a.name))
            .cloned()
            .collect();
        BootstrapPlan { creates, reimports }
    }

    /// Atomic save (temp + rename via [`atomic_write`]). Caller chooses
    /// the path; typically `<app_data_dir>/bootstrap-session.json`.
    pub fn save(&self, path: &Utf8Path) -> Result<(), Error> {
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| Error::InstallsSerialize(e.to_string()))?;
        atomic_write(path, &body)
    }

    /// Load a session from `path`. Returns `Ok(None)` when the file does
    /// not exist (no resumable bootstrap). Parse errors surface via
    /// [`Error::InstallsParse`] — the caller can treat them as
    /// "non-resumable, offer Start over".
    pub fn load(path: &Utf8Path) -> Result<Option<Self>, Error> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| Error::InstallsParse(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(Error::Io {
                path: path.to_string(),
                source,
            }),
        }
    }

    /// Remove the session file at `path`. No-op when absent.
    pub fn clear(path: &Utf8Path) -> Result<(), Error> {
        match std::fs::remove_file(path.as_std_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(Error::Io {
                path: path.to_string(),
                source,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    use crate::{BaseAssignment, ParseStatus, Target};

    fn parsed_base(target: Target, path: &str) -> BaseAssignment {
        BaseAssignment {
            target,
            source_path: Utf8PathBuf::from(path),
            parse: ParseStatus::Parsed,
        }
    }

    fn create(kind: PrimitiveKind, n: &str) -> CreateAction {
        CreateAction {
            kind,
            name: name(n),
            base: parsed_base(Target::Claude, "/x"),
            overlays: vec![],
        }
    }

    fn reimport(kind: PrimitiveKind, n: &str) -> ReimportAction {
        ReimportAction {
            kind,
            name: name(n),
            base: parsed_base(Target::Claude, "/x"),
        }
    }

    fn name(s: &str) -> PrimitiveName {
        PrimitiveName::try_new(s).unwrap()
    }

    fn session_path(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().join("bootstrap-session.json")).unwrap()
    }

    #[test]
    fn load_returns_none_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let loaded = BootstrapSession::load(&session_path(&tmp)).unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn record_create_marks_item_done_and_survives_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        let mut s = BootstrapSession::new("ts");
        let nm = name("diagnose");
        assert!(!s.is_create_done(PrimitiveKind::Skill, &nm));
        s.record_create(PrimitiveKind::Skill, &nm);
        assert!(s.is_create_done(PrimitiveKind::Skill, &nm));
        // Reimport-done must still be false — different action kind.
        assert!(!s.is_reimport_done(PrimitiveKind::Skill, &nm));
        s.save(&path).unwrap();
        let reloaded = BootstrapSession::load(&path).unwrap().unwrap();
        assert!(reloaded.is_create_done(PrimitiveKind::Skill, &nm));
        assert_eq!(reloaded.completed.len(), 1);
        assert!(matches!(reloaded.completed[0].action, ActionKind::Create));
    }

    #[test]
    fn filter_remaining_drops_completed_creates_and_reimports() {
        let plan = BootstrapPlan {
            creates: vec![
                create(PrimitiveKind::Skill, "alpha"),
                create(PrimitiveKind::Skill, "beta"),
            ],
            reimports: vec![
                reimport(PrimitiveKind::Skill, "gamma"),
                reimport(PrimitiveKind::Skill, "delta"),
            ],
        };
        let mut s = BootstrapSession::new("ts");
        s.record_create(PrimitiveKind::Skill, &name("alpha"));
        s.record_reimport(PrimitiveKind::Skill, &name("gamma"));

        let remaining = s.filter_remaining(&plan);
        assert_eq!(remaining.creates.len(), 1);
        assert_eq!(remaining.creates[0].name.as_str(), "beta");
        assert_eq!(remaining.reimports.len(), 1);
        assert_eq!(remaining.reimports[0].name.as_str(), "delta");
    }

    #[test]
    fn filter_remaining_keeps_create_when_only_reimport_done_for_same_name() {
        // (Skill, "shared") appears as both a create and a reimport
        // (artificial — derive_plan never produces this — but the filter
        // should still distinguish action kinds).
        let plan = BootstrapPlan {
            creates: vec![create(PrimitiveKind::Skill, "shared")],
            reimports: vec![reimport(PrimitiveKind::Skill, "shared")],
        };
        let mut s = BootstrapSession::new("ts");
        s.record_reimport(PrimitiveKind::Skill, &name("shared"));

        let remaining = s.filter_remaining(&plan);
        assert_eq!(remaining.creates.len(), 1, "create not yet done");
        assert!(remaining.reimports.is_empty());
    }

    #[test]
    fn clear_removes_existing_session_file() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        BootstrapSession::new("ts").save(&path).unwrap();
        assert!(path.exists());
        BootstrapSession::clear(&path).unwrap();
        assert!(!path.exists());
        assert!(BootstrapSession::load(&path).unwrap().is_none());
    }

    #[test]
    fn clear_is_noop_when_file_absent() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        // No prior save — clear must succeed silently.
        BootstrapSession::clear(&path).unwrap();
    }

    #[test]
    fn load_surfaces_parse_error_on_garbage() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        std::fs::write(&path, b"not valid json").unwrap();
        let err = BootstrapSession::load(&path).unwrap_err();
        assert!(matches!(err, Error::InstallsParse(_)), "got {err:?}");
    }

    #[test]
    fn save_creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let nested = Utf8PathBuf::from_path_buf(
            tmp.path().join("a/b/c/bootstrap-session.json"),
        )
        .unwrap();
        BootstrapSession::new("ts").save(&nested).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn record_reimport_marks_item_done_independently_of_create() {
        let mut s = BootstrapSession::new("ts");
        let nm = name("diagnose");
        s.record_reimport(PrimitiveKind::Skill, &nm);
        assert!(s.is_reimport_done(PrimitiveKind::Skill, &nm));
        // Create-done is still false — same (kind, name), different action.
        assert!(!s.is_create_done(PrimitiveKind::Skill, &nm));
    }

    #[test]
    fn save_then_load_round_trips_an_empty_session() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        let original = BootstrapSession::new("2026-05-05T12:00:00Z");
        original.save(&path).unwrap();
        let loaded = BootstrapSession::load(&path).unwrap().unwrap();
        assert_eq!(loaded, original);
        assert_eq!(loaded.format_version, FORMAT_VERSION);
        assert_eq!(loaded.started_at, "2026-05-05T12:00:00Z");
        assert!(!loaded.backup_taken);
        assert!(loaded.excluded_ids.is_empty());
        assert!(loaded.completed.is_empty());
    }

    #[test]
    fn excluded_ids_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = session_path(&tmp);
        let mut original = BootstrapSession::new("2026-05-05T12:00:00Z");
        original.backup_taken = true;
        original.set_excluded_ids(vec![
            "new:skill:alpha".to_string(),
            "drifted:command:beta".to_string(),
        ]);
        original.save(&path).unwrap();

        let loaded = BootstrapSession::load(&path).unwrap().unwrap();
        assert!(loaded.backup_taken);
        assert_eq!(
            loaded.excluded_ids,
            vec![
                "new:skill:alpha".to_string(),
                "drifted:command:beta".to_string(),
            ]
        );
    }
}
