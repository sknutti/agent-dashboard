pub mod bootstrap;
pub mod bootstrap_scan;
pub mod bootstrap_session;
pub mod codex_agent;
pub mod cross_reference;
pub mod deduper;
pub mod detail;
pub mod domain;
pub mod drift;
pub mod error;
mod fs_helpers;
pub mod icloud_check;
pub mod ignored;
pub mod install_paths;
pub mod install_state;
pub mod installer;
pub mod kind_target;
pub mod layout;
pub mod library_drift;
pub mod library_init;
pub mod listing;
pub mod md_primitive;
pub mod materializer;
pub mod metadata;
pub mod overlay_merge;
pub mod duplicate;
pub mod find;
pub mod import_path;
pub mod primitive_name;
pub mod reimport;
pub mod rename;
pub mod remote_url;
pub mod scaffold;
pub mod scanner;
pub mod settings;
pub mod source_backup;
pub mod url_import;
pub mod version_label;
pub mod version_store;
pub mod working_copy;
pub mod working_files;
pub mod yaml_splice;

pub use bootstrap::{
    bootstrap_execute, derive_plan, execute_creates, execute_reimports, BootstrapExecuteRequest,
    BootstrapExecuteSummary, BootstrapPlan, BootstrapReimportSummary, BootstrapSkipReason,
    BootstrapSkippedItem, BootstrapSummary, CreateAction, ReimportAction,
};
pub use bootstrap_scan::{bootstrap_scan, ScanProgress};
pub use bootstrap_session::{
    ActionKind, BootstrapSession, CompletedItem,
    FORMAT_VERSION as BOOTSTRAP_SESSION_FORMAT_VERSION,
};
pub use codex_agent::CodexAgentFile;
pub use cross_reference::{
    cross_reference, Classification, ClassifiedGroup, CrossReferenceSummary, CrossReferenced,
};
pub use deduper::{
    dedupe, BaseAssignment, DedupeContent, DedupeGroup, DedupeOutput, ManualReviewGroup,
    MemberInfo, OverlayCandidate, SymlinkedItem, UnclassifiedItem,
};
pub use scaffold::{scaffold_primitive, scaffold_skill, ScaffoldSource};
pub use url_import::{fetch_from_url, is_skill_md_url, FetchedPrimitive, RefFile};

/// Test-only escape hatch for integration tests that need to reach into
/// `url_import::walk_skill_folder` or override the GitHub API base.
/// Not intended for production callers — the signatures are unstable.
#[doc(hidden)]
pub mod test_only {
    pub use crate::url_import::{fetch_from_url_for_tests, walk_skill_folder_for_tests};
}
pub use domain::{
    BodyFormat, KindInfo, KindInfoTable, KindMetadata, PrimaryFilename, PrimitiveKind, Target,
};
pub use drift::{
    acknowledge_drift, scan_drift_for_primitive, scan_record, DriftReport, DriftStatus,
};
pub use error::Error;
pub use icloud_check::is_in_icloud_drive;
pub use ignored::is_ignored;
pub use install_paths::InstallPaths;
pub use install_state::{InstallRecord, InstallsFile, FORMAT_VERSION as INSTALLS_FORMAT_VERSION};
pub use installer::{
    install, uninstall, InstallFailureKind, InstallRequest, InstallSummary, TargetFailure,
    TargetOutcome, TargetResult, TargetUninstallResult, UninstallOutcome, UninstallRequest,
    UninstallSummary,
};
pub use kind_target::{InstallLayout, KindTarget};
pub use layout::LibraryLayout;
pub use library_drift::{
    delete_primitive, forget_primitive, scan_library_drift, DeletePrimitiveRequest,
    DeletePrimitiveSummary, MissingPrimitive,
};
pub use materializer::{materialize, Materialized};
pub use md_primitive::MdPrimitive;
pub use metadata::{update_primitive_metadata, MetadataUpdate, PrimitiveMetadata};
pub use primitive_name::PrimitiveName;
pub use reimport::{reimport_install_as_version, ReimportRequest, ReimportResult};
pub use rename::{rename_primitive, RenamePrimitiveRequest, RenamePrimitiveSummary};
pub use duplicate::{
    duplicate_primitive, DuplicatePrimitiveRequest, DuplicatePrimitiveSummary,
};
pub use find::{find_in_library, FindHit, FindOptions};
pub use import_path::{import_primitive_from_path, ImportFromPathResult};
pub use scanner::{scan_install_roots, CandidateInfo, ParseStatus, ScanResult};
pub use settings::Settings;
pub use source_backup::create_source_backup;
pub use version_label::VersionLabel;
pub use version_store::{VersionMetadata, VersionStore};
pub use working_copy::{OverlayBytes, WorkingCopy};
