use thiserror::Error;

use crate::detail::OverlayList;
use crate::{PrimitiveKind, Target};

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid primitive name `{name}`: {reason}")]
    InvalidPrimitiveName { name: String, reason: &'static str },

    #[error("invalid version label `{label}`: {reason}")]
    InvalidVersionLabel { label: String, reason: &'static str },

    #[error("metadata YAML parse error: {0}")]
    MetadataParse(#[from] serde_yaml_ng::Error),

    #[error("metadata YAML serialize error: {0}")]
    MetadataSerialize(String),

    #[error("codex agent TOML parse error: {0}")]
    CodexAgentParse(#[from] toml_edit::TomlError),

    #[error("file is not valid UTF-8: {0}")]
    NotUtf8(#[from] std::str::Utf8Error),

    #[error("markdown frontmatter error: {0}")]
    MdFrontmatter(&'static str),

    #[error("io error at `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("invalid working-copy path `{0}`: must start with `base/` or `targets/<target>/`")]
    InvalidWorkingPath(String),

    #[error("primitive bundle has {count} files; max is {limit}")]
    TooManyWorkingFiles { count: u32, limit: u32 },

    #[error("working file `{path}` already exists")]
    WorkingFileAlreadyExists { path: String },

    #[error("working file `{path}` not found")]
    WorkingFileNotFound { path: String },

    #[error("cannot rename the primary file `{path}` from the file tree; use the rename-primitive flow instead")]
    RefuseRenamePrimary { path: String },

    #[error("cannot delete the primary file `{path}` from the file tree; use the delete-primitive flow instead")]
    RefuseDeletePrimary { path: String },

    #[error("version `{0}` already exists")]
    VersionExists(String),

    #[error("version `{0}` not found")]
    VersionNotFound(String),

    #[error("invalid current.txt contents: {0}")]
    InvalidCurrentMarker(String),

    #[error("settings JSON parse error: {0}")]
    SettingsParse(String),

    #[error("settings JSON serialize error: {0}")]
    SettingsSerialize(String),

    #[error("`{path}` is not a prompt-library directory and is not empty")]
    NotALibrary { path: String },

    #[error("primitive `{name}` ({kind:?}) already exists")]
    PrimitiveAlreadyExists { kind: PrimitiveKind, name: String },

    #[error("primitive `{name}` ({kind:?}) not found in library")]
    PrimitiveNotFound { kind: PrimitiveKind, name: String },

    #[error("read not yet supported for kind {kind:?}")]
    UnsupportedKindForRead { kind: PrimitiveKind },

    #[error("target `{target:?}` not in primitive `{primitive}` allowed_targets")]
    TargetNotAllowed { primitive: String, target: Target },

    #[error("target `{target:?}` not allowed for kind `{kind:?}`")]
    TargetNotAllowedForKind { kind: PrimitiveKind, target: Target },

    #[error("dropping targets would orphan overlay files; pass discard_orphan_overlays to confirm")]
    TargetRemovedWithOverlays { dropped: Vec<OverlayList> },

    #[error("install not supported for kind {kind:?} on target {target:?}")]
    InstallNotSupported { kind: PrimitiveKind, target: Target },

    #[error("installs.json parse error: {0}")]
    InstallsParse(String),

    #[error("installs.json serialize error: {0}")]
    InstallsSerialize(String),

    #[error("primitive has no current version pinned; publish before installing")]
    NoCurrentVersionForInstall,

    #[error("materialized output had unexpected shape: {0}")]
    MaterializeShape(String),

    #[error("no install record for `{name}` ({kind:?}) on target {target:?}")]
    NoInstallRecord {
        kind: PrimitiveKind,
        name: String,
        target: Target,
    },

    #[error("unsupported import URL: {reason}")]
    UnsupportedSourceUrl { reason: String },

    #[error("failed to fetch `{url}`: {message}")]
    FetchFailed { url: String, message: String },

    /// Folder import: the bundle violates a structural constraint
    /// (count > 200, total bytes > 4 MiB, illegal ref path, …). Carries a
    /// user-facing reason string that's surfaced verbatim on `urlError`.
    #[error("folder import bundle is invalid: {reason}")]
    BundleInvalid { reason: String },

    /// Folder import hit GitHub's anonymous Contents API rate limit
    /// (60/hr per IP). Distinct from `FetchFailed` so the frontend can
    /// route the user to a "wait" message rather than a "broken" one.
    #[error("GitHub rate-limited the request (60/hr without auth)")]
    GitHubRateLimited,
}
