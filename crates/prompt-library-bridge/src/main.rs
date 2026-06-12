//! prompt-library-bridge — a short-lived JSON stdin/stdout command bridge over
//! the Tauri-free Prompt Library core/git crates.
//!
//! Protocol (NDJSON, one request → one response, UTF-8, no embedded newlines):
//!
//!   request:  { "v": 1, "command": "<name>", "args": { ... } }
//!   response: { "v": 1, "ok": true,  "data": <value> }
//!         or  { "v": 1, "ok": false, "error": { "code", "message", "detail" } }
//!
//! Read-model commands (v1): `library_status`, `kind_info`, `target_info`,
//! `list_primitives`, `primitive_detail`. Write/drift commands (install-drift
//! slice): `install`, `uninstall`, `scan_drift`, `scan_drift_batch`,
//! `acknowledge_drift`, `list_installs_for_primitive`, `import_installs`.
//!
//! Invariants:
//! - **stdout carries protocol bytes only.** All diagnostics go to stderr. A
//!   stray stdout write corrupts the stream (the classic stdio-bridge bug).
//! - **main is infallible at the envelope level.** Expected application errors
//!   serialize as `{ok:false,...}` and STILL exit 0; non-zero exit + stderr is
//!   reserved for genuine panics/crashes, so "not found" stays distinguishable
//!   from "the binary crashed."
//! - **no network, no secrets on ANY path.** The crate does not depend on
//!   prompt-library-secrets at all (a SecretStore is unconstructible), and no
//!   command touches core's reqwest-backed url_import. Install is fs-only.
//! - **current_thread runtime only** — the fns touch std::fs; only the git
//!   status calls are async. No multi-thread worker pool per one-shot call.
//! - **writes are crash-safe at the file level.** core writes every target's
//!   bytes and `installs.json` via atomic temp-file + rename under an fd-lock,
//!   so a killed bridge leaves the ledger + target files intact (at worst a
//!   harmless orphan `.tmp`). This is the safety argument for the whole slice
//!   (D4). Note core is NOT atomic *across* targets: a kill mid-batch can leave
//!   on-disk files the not-yet-saved ledger has no record of (D3) — a
//!   re-install self-heals (re-runs to `no_op_identical` AND records the row).
//!   Cross-writer serialization (a process can't lost-update a concurrent one)
//!   is the route layer's job (D1), not this one-shot process's.

use std::io::{Read, Write};

use camino::Utf8PathBuf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use prompt_library_core::{
    acknowledge_drift, detail::read_primitive_detail, install, listing::list_primitives,
    scan_drift_for_primitive, scan_record, uninstall, DriftReport, Error as CoreError, InstallPaths,
    InstallRequest, InstallsFile, KindInfoTable, LibraryLayout, PrimitiveKind, PrimitiveName,
    Target, UninstallRequest, VersionLabel, INSTALLS_FORMAT_VERSION,
};
use prompt_library_git::{
    git_ops::{current_branch, git_diff_changed_files},
    runner::{GitRunner, TokioProcessRunner},
};

const PROTOCOL_VERSION: u32 = 1;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        emit(&err_envelope(&LibraryError::new(
            "bridge_bad_request",
            "could not read request from stdin",
            e.to_string(),
        )));
        return;
    }
    let envelope = handle(&input).await;
    emit(&envelope);
}

/// Parse one request, dispatch it, and return the response envelope as a JSON
/// value. Pure with respect to stdio (the whole request→response path is
/// unit-testable without spawning a process).
async fn handle(input: &str) -> Value {
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            return err_envelope(&LibraryError::new(
                "bridge_bad_request",
                "request was not valid JSON",
                e.to_string(),
            ))
        }
    };
    // A `v` mismatch is a transport error, not a misparse — surface it as its
    // own code so a future protocol bump fails loudly instead of silently
    // misreading args.
    if req.v != Some(PROTOCOL_VERSION) {
        return err_envelope(&LibraryError::new(
            "protocol_version_mismatch",
            "unsupported protocol version",
            format!("expected v={PROTOCOL_VERSION}, got {:?}", req.v),
        ));
    }
    match dispatch(&req.command, &req.args).await {
        Ok(data) => ok_envelope(data),
        Err(e) => err_envelope(&e),
    }
}

async fn dispatch(command: &str, args: &Value) -> Result<Value, LibraryError> {
    match command {
        "library_status" => cmd_library_status(args).await,
        "kind_info" => cmd_kind_info(),
        "target_info" => cmd_target_info(),
        "list_primitives" => cmd_list_primitives(args),
        "primitive_detail" => cmd_primitive_detail(args),
        // Write/drift slice. All sync core work — no `.await`; they touch
        // std::fs only (the current_thread runtime is only needed by the async
        // git calls in `library_status`).
        "install" => cmd_install(args),
        "uninstall" => cmd_uninstall(args),
        "scan_drift" => cmd_scan_drift(args),
        "scan_drift_batch" => cmd_scan_drift_batch(args),
        "acknowledge_drift" => cmd_acknowledge_drift(args),
        "list_installs_for_primitive" => cmd_list_installs_for_primitive(args),
        "import_installs" => cmd_import_installs(args),
        other => Err(LibraryError::new(
            "unknown_command",
            "unknown bridge command",
            format!("`{other}` is not a recognized command"),
        )),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Total per-Kind capability table (primary filenames, allowed Targets,
/// ref-file support) straight from Rust — the UI's source for legal options so
/// TypeScript never duplicates the install matrix.
fn cmd_kind_info() -> Result<Value, LibraryError> {
    serde_json::to_value(KindInfoTable::current()).map_err(serialize_err)
}

/// The Prompt Library Targets, learned from Rust (`Target::ALL`). Antigravity
/// is an observed dashboard Agent, not a Library Target until core defines its
/// install semantics — so it is intentionally absent here.
fn cmd_target_info() -> Result<Value, LibraryError> {
    let targets: Vec<TargetInfo> = Target::ALL
        .iter()
        .map(|&t| TargetInfo {
            // canonical wire value comes from the serde projection, not a
            // hand-mirrored string
            target: serde_json::to_value(t)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default(),
            dir_name: t.dir_name().to_string(),
        })
        .collect();
    Ok(json!({ "targets": targets }))
}

fn cmd_list_primitives(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let summaries = list_primitives(LibraryLayout::new(&root)).map_err(map_core_error)?;
    serde_json::to_value(summaries).map_err(serialize_err)
}

fn cmd_primitive_detail(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let layout = LibraryLayout::new(&root);
    // `read_primitive_detail` reads metadata.yaml first, so a missing primitive
    // would otherwise surface as a generic `Io` → `library_unreadable` (a 502).
    // Pre-check existence so "not found" stays a distinct, route-mappable code
    // (404), separate from a genuine read fault on a primitive that does exist.
    if !layout.primitive_dir(kind, &name).exists() {
        return Err(LibraryError::new(
            "primitive_not_found",
            "primitive not found",
            format!("{kind:?} `{}` not found in library", name.as_str()),
        ));
    }
    let detail = read_primitive_detail(layout, kind, &name).map_err(map_core_error)?;
    serde_json::to_value(detail).map_err(serialize_err)
}

/// Lightweight, informational git/marker status. Unlike list/detail this NEVER
/// errors on a bad path or missing marker — reporting validity is its whole
/// job, so those become `is_valid:false` data. "Not a git repo" is likewise a
/// first-class status, not an error.
async fn cmd_library_status(args: &Value) -> Result<Value, LibraryError> {
    let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
    let Some(root) = canonical_utf8(raw) else {
        return Ok(json!({
            "is_valid": false, "marker_exists": false, "is_git_repo": false,
            "branch": Value::Null, "dirty": Value::Null, "unpushed": Value::Null,
        }));
    };
    let marker_exists = root.join(".prompt-library").exists();

    let runner = TokioProcessRunner::new();
    let repo = root.as_std_path();
    let is_git_repo = matches!(
        runner.run(&["rev-parse", "--is-inside-work-tree"], repo, &[]).await,
        Ok(o) if o.status == 0
    );
    let branch = if is_git_repo {
        current_branch(&runner, repo).await.ok()
    } else {
        None
    };
    // dirty = working tree (incl. index) differs from HEAD. Unborn-branch / no
    // commits → indeterminate (None), never an error.
    let dirty = if is_git_repo {
        git_diff_changed_files(&runner, repo, "HEAD")
            .await
            .ok()
            .map(|changed| !changed.is_empty())
    } else {
        None
    };
    // unpushed = commits ahead of the upstream. No upstream configured (or any
    // failure) → indeterminate (None), not zero — don't claim "all pushed"
    // when we can't tell.
    let unpushed = if is_git_repo {
        match runner.run(&["rev-list", "--count", "@{u}..HEAD"], repo, &[]).await {
            Ok(o) if o.status == 0 => std::str::from_utf8(&o.stdout)
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|n| n > 0),
            _ => None,
        }
    } else {
        None
    };

    Ok(json!({
        "is_valid": marker_exists,
        "marker_exists": marker_exists,
        "is_git_repo": is_git_repo,
        "branch": branch,
        "dirty": dirty,
        "unpushed": unpushed,
    }))
}

// ---------------------------------------------------------------------------
// Write / drift commands (install-drift slice)
// ---------------------------------------------------------------------------

/// Install the current pinned version of `(kind, name)` to each requested
/// target. Per-target outcomes (`installed`/`no_op_identical`/`colliding_content`)
/// ride `summary.successes`; pre-flight aborts ride `summary.failures`. With
/// `force:false` a content collision is reported and NOTHING is written — the
/// route/UI prompts, then re-issues with `force:true` scoped to the colliding
/// targets. Needs the library layout (to materialize the version), so it goes
/// through `require_library` like the read commands.
fn cmd_install(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let targets = parse_targets(args)?;
    let force = parse_force(args);
    let installed_at = parse_installed_at(args)?;
    let summary = install(InstallRequest {
        layout: LibraryLayout::new(&root),
        install_paths: &install_paths,
        installs_file_path: &installs_file_path,
        kind,
        name: &name,
        targets: &targets,
        force,
        installed_at: &installed_at,
    })
    .map_err(map_core_error)?;
    serde_json::to_value(summary).map_err(serialize_err)
}

/// Remove `(kind, name)` from each requested target. Outcomes
/// (`removed`/`not_installed`/`drifted`) ride `summary.successes`; `drifted` is
/// the prompt-then-`force` shape, not a failure. Needs no library layout — it
/// works off `installs.json` + the install root only.
fn cmd_uninstall(args: &Value) -> Result<Value, LibraryError> {
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let targets = parse_targets(args)?;
    let force = parse_force(args);
    let summary = uninstall(UninstallRequest {
        install_paths: &install_paths,
        installs_file_path: &installs_file_path,
        kind,
        name: &name,
        targets: &targets,
        force,
    })
    .map_err(map_core_error)?;
    serde_json::to_value(summary).map_err(serialize_err)
}

/// Per-primitive drift: scan every recorded install of `(kind, name)` and
/// report each target's status. The authoritative source for the detail
/// pane's rows (fresh + scoped); the batch below feeds explorer badges (D8).
fn cmd_scan_drift(args: &Value) -> Result<Value, LibraryError> {
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let reports = scan_drift_for_primitive(&install_paths, &installs_file_path, kind, &name)
        .map_err(map_core_error)?;
    serde_json::to_value(reports).map_err(serialize_err)
}

/// Whole-ledger drift in ONE spawn: load `installs.json` once, then walk
/// `scan_record` over every record. This is O(N) — deliberately NOT a loop of
/// `scan_drift_for_primitive`, which reloads the whole file per primitive
/// (O(N²), D-deepening / Open Q1). Core mtime-gates the hashing, so steady
/// state is stat-bound, not hash-bound. Feeds the explorer's per-primitive
/// badges on the 30s poll.
fn cmd_scan_drift_batch(args: &Value) -> Result<Value, LibraryError> {
    let (install_paths, installs_file_path) = install_context(args)?;
    let installs = InstallsFile::load(&installs_file_path).map_err(map_core_error)?;
    let mut reports = Vec::with_capacity(installs.records.len());
    for record in &installs.records {
        let status = scan_record(&install_paths, record).map_err(map_core_error)?;
        reports.push(DriftReport {
            kind: record.kind,
            name: record.name.clone(),
            target: record.target,
            status,
        });
    }
    serde_json::to_value(reports).map_err(serialize_err)
}

/// Re-baseline the `(kind, name, target)` record against current on-disk
/// content — the "adopt current contents as truth" affordance. Errors
/// `drift_no_install_record` if nothing is recorded for that triple.
fn cmd_acknowledge_drift(args: &Value) -> Result<Value, LibraryError> {
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let target = parse_target(args)?;
    acknowledge_drift(&install_paths, &installs_file_path, kind, &name, target)
        .map_err(map_core_error)?;
    Ok(json!({}))
}

/// The compact per-target install projection the UI renders Install/Update/
/// Uninstall rows from. Hashes/mtimes stay in core — off the wire.
#[derive(Serialize)]
struct InstalledTarget {
    target: Target,
    installed_version: VersionLabel,
    installed_at: String,
}

/// List the targets `(kind, name)` is currently installed to. Empty vec when
/// nothing matches (first-launch / empty-ledger parity).
fn cmd_list_installs_for_primitive(args: &Value) -> Result<Value, LibraryError> {
    let (_install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let installs = InstallsFile::load(&installs_file_path).map_err(map_core_error)?;
    let targets: Vec<InstalledTarget> = installs
        .records
        .iter()
        .filter(|r| r.kind == kind && r.name == name)
        .map(|r| InstalledTarget {
            target: r.target,
            installed_version: r.installed_version.clone(),
            installed_at: r.installed_at.clone(),
        })
        .collect();
    serde_json::to_value(targets).map_err(serialize_err)
}

/// One-time migration: copy the standalone app's `installs.json` into the
/// dashboard's `DATA_DIR`. Guarded + idempotent (ADR + D6):
/// - refuse only if the dest already holds ≥1 record (`installs_already_present`);
///   a missing/empty/default dest is nothing to protect — proceed;
/// - a dest that exists but won't parse is surfaced (`installs_destination_corrupt`),
///   never silently clobbered;
/// - probe the source's `format_version` BEFORE a full load so a version skew
///   is actionable, not a generic parse error. D9: the dashboard's bundled core
///   `FORMAT_VERSION` and the standalone app's are LOCKSTEP — a differing
///   version HARD-REJECTS (`installs_format_mismatch`) with no in-app upgrade
///   path; recovery is "upgrade the dashboard build". A future v2 bump on
///   either side is a deliberate, paired change.
///
/// The copy is load→validate→re-serialize (core's atomic + fd-locked `save`),
/// NOT a byte copy — every record's `PrimitiveName` is re-validated on
/// deserialize (a tampered record can't redirect a write, D7). Recorded
/// hashes/mtimes are copied VERBATIM: we do NOT re-baseline against disk, so a
/// user's pre-migration external edit correctly shows as `Modified` on the
/// first scan (D6). The source is left untouched (still used for authoring).
fn cmd_import_installs(args: &Value) -> Result<Value, LibraryError> {
    let source_path = args.get("source_path").and_then(Value::as_str).unwrap_or("");
    if source_path.is_empty() {
        return Err(LibraryError::new(
            "bridge_bad_request",
            "no import source path",
            "request args.source_path was missing or empty",
        ));
    }
    let installs_path = args.get("installs_path").and_then(Value::as_str).unwrap_or("");
    if installs_path.is_empty() {
        return Err(LibraryError::new(
            "installs_unconfigured",
            "no installs path configured",
            "request args.installs_path was missing or empty",
        ));
    }
    let source = Utf8PathBuf::from(source_path);
    let dest = Utf8PathBuf::from(installs_path);

    if dest.as_std_path().exists() {
        match InstallsFile::load(&dest) {
            Ok(existing) if !existing.records.is_empty() => {
                return Err(LibraryError::new(
                    "installs_already_present",
                    "installs already imported",
                    format!("destination already has {} record(s)", existing.records.len()),
                ));
            }
            // Empty/default dest — nothing to protect, import over it.
            Ok(_) => {}
            Err(_) => {
                return Err(LibraryError::new(
                    "installs_destination_corrupt",
                    "existing installs file is unreadable",
                    "destination installs.json exists but could not be parsed",
                ));
            }
        }
    }

    let raw = std::fs::read(source.as_std_path()).map_err(|e| {
        LibraryError::new(
            "installs_source_missing",
            "import source not found",
            format!("read source: {e}"),
        )
    })?;
    match serde_json::from_slice::<VersionProbe>(&raw) {
        Ok(probe) if probe.format_version != INSTALLS_FORMAT_VERSION => {
            return Err(LibraryError::new(
                "installs_format_mismatch",
                "installs format version mismatch",
                format!(
                    "source format_version {} != dashboard {INSTALLS_FORMAT_VERSION}; \
                     upgrade the dashboard build",
                    probe.format_version
                ),
            ));
        }
        Ok(_) => {}
        Err(e) => {
            return Err(LibraryError::new(
                "installs_source_corrupt",
                "import source is unreadable",
                format!("probe source: {e}"),
            ));
        }
    }

    let source_file = InstallsFile::load(&source).map_err(|_| {
        LibraryError::new(
            "installs_source_corrupt",
            "import source is unreadable",
            "source installs.json could not be parsed",
        )
    })?;
    let imported = source_file.records.len();
    source_file.save(&dest).map_err(map_core_error)?;
    Ok(json!({ "imported": imported }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Canonicalize a path string to an absolute UTF-8 path, or None if it can't
/// be resolved (missing, unreadable, or non-UTF-8).
fn canonical_utf8(raw: &str) -> Option<Utf8PathBuf> {
    if raw.is_empty() {
        return None;
    }
    let canon = std::fs::canonicalize(raw).ok()?;
    Utf8PathBuf::from_path_buf(canon).ok()
}

/// M2: resolve `library_path` to an absolute canonical path and REFUSE every
/// read command if `.prompt-library` is absent. Without this guard a mis-set
/// path turns the bridge into a filesystem-read oracle over any readable dir.
fn require_library(args: &Value) -> Result<Utf8PathBuf, LibraryError> {
    let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
    if raw.is_empty() {
        return Err(LibraryError::new(
            "library_unconfigured",
            "no library path configured",
            "request args.path was missing or empty",
        ));
    }
    let canon = std::fs::canonicalize(raw).map_err(|e| {
        LibraryError::new(
            "library_invalid_path",
            "library path does not exist or is unreadable",
            format!("canonicalize `{raw}`: {e}"),
        )
    })?;
    let root = Utf8PathBuf::from_path_buf(canon).map_err(|p| {
        LibraryError::new(
            "library_invalid_path_encoding",
            "library path is not valid UTF-8",
            format!("non-UTF-8 path: {}", p.display()),
        )
    })?;
    if !root.join(".prompt-library").exists() {
        return Err(LibraryError::new(
            "library_marker_missing",
            "not a prompt-library directory",
            format!("missing .prompt-library marker at `{root}`"),
        ));
    }
    Ok(root)
}

fn parse_kind(args: &Value) -> Result<PrimitiveKind, LibraryError> {
    let raw = args.get("kind").and_then(Value::as_str).unwrap_or("");
    serde_json::from_value::<PrimitiveKind>(Value::String(raw.to_string())).map_err(|_| {
        LibraryError::new(
            "library_invalid_kind",
            "unknown primitive kind",
            format!("kind `{raw}` is not one of skill|agent|command|codex_agent"),
        )
    })
}

/// M3: bind the untrusted `name` through the validating constructor —
/// `try_new` rejects `..`, `/`, `\`, leading dots (≤64, `[A-Za-z0-9._-]`), so
/// traversal payloads become `library_invalid_name`, never a path join. Shared
/// by every command that takes a `:name`.
fn parse_name(args: &Value) -> Result<PrimitiveName, LibraryError> {
    let raw = args.get("name").and_then(Value::as_str).unwrap_or("");
    PrimitiveName::try_new(raw).map_err(map_core_error)
}

/// Resolve the install destination root + `installs.json` path from request
/// args. The TS route layer injects BOTH from server config/env
/// (`CC_LIBRARY_HOME`, default user home; `CC_LIBRARY_INSTALLS_PATH`, default
/// `DATA_DIR/installs.json`). They are NEVER read from an HTTP body — the route
/// layer is the containment boundary (`InstallPaths::new` does zero validation)
/// and asserts that as a tripwire (D7). Missing/empty here is a config fault,
/// not a user error.
fn install_context(args: &Value) -> Result<(InstallPaths, Utf8PathBuf), LibraryError> {
    let installs_path = args.get("installs_path").and_then(Value::as_str).unwrap_or("");
    if installs_path.is_empty() {
        return Err(LibraryError::new(
            "installs_unconfigured",
            "no installs path configured",
            "request args.installs_path was missing or empty",
        ));
    }
    let home = args.get("home").and_then(Value::as_str).unwrap_or("");
    if home.is_empty() {
        return Err(LibraryError::new(
            "installs_unconfigured",
            "no install home configured",
            "request args.home was missing or empty",
        ));
    }
    Ok((InstallPaths::new(home), Utf8PathBuf::from(installs_path)))
}

/// Parse the closed `targets` enum array (`claude`/`pi`/`codex`). A malformed
/// or unknown target is a typed error, never a silent drop.
fn parse_targets(args: &Value) -> Result<Vec<Target>, LibraryError> {
    let raw = args.get("targets").cloned().unwrap_or(Value::Null);
    serde_json::from_value::<Vec<Target>>(raw).map_err(|e| {
        LibraryError::new(
            "library_invalid_target",
            "unknown or malformed install target",
            format!("targets must be an array of claude|pi|codex: {e}"),
        )
    })
}

/// Parse a single `target` enum value (acknowledge-drift is per-target).
fn parse_target(args: &Value) -> Result<Target, LibraryError> {
    let raw = args.get("target").cloned().unwrap_or(Value::Null);
    serde_json::from_value::<Target>(raw).map_err(|e| {
        LibraryError::new(
            "library_invalid_target",
            "unknown install target",
            format!("target must be one of claude|pi|codex: {e}"),
        )
    })
}

/// `force` defaults to `false` — the two-phase-confirm safe default. An
/// overwrite is only ever the result of an explicit `force:true`.
fn parse_force(args: &Value) -> bool {
    args.get("force").and_then(Value::as_bool).unwrap_or(false)
}

/// Validate the caller-supplied install timestamp. `installed_at` is never
/// user-controlled — the TS layer sends `new Date().toISOString()` — so this
/// is defense against a caller bug persisting an empty/garbage timestamp (core
/// does ZERO validation). A dependency-free RFC3339 *shape* check (not a full
/// calendar parser); strict calendar validation isn't worth a date crate in
/// this deliberately-minimal bridge.
fn parse_installed_at(args: &Value) -> Result<String, LibraryError> {
    let raw = args.get("installed_at").and_then(Value::as_str).unwrap_or("");
    if !looks_like_rfc3339(raw) {
        return Err(LibraryError::new(
            "bridge_bad_request",
            "missing or malformed install timestamp",
            format!("installed_at `{raw}` is not an RFC3339 UTC timestamp"),
        ));
    }
    Ok(raw.to_string())
}

/// `YYYY-MM-DDTHH:MM:SS` with an optional fractional second and a `Z` or
/// `±HH:MM` offset. Positional digit checks reject look-alikes (e.g. a unix
/// millis string) that a bare "contains a T" test would pass.
fn looks_like_rfc3339(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 {
        return false;
    }
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let sep = |i: usize, c: u8| b.get(i) == Some(&c);
    let datetime = digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && sep(4, b'-')
        && digit(5)
        && digit(6)
        && sep(7, b'-')
        && digit(8)
        && digit(9)
        && sep(10, b'T')
        && digit(11)
        && digit(12)
        && sep(13, b':')
        && digit(14)
        && digit(15)
        && sep(16, b':')
        && digit(17)
        && digit(18);
    if !datetime {
        return false;
    }
    // Remainder after the seconds: an optional `.fraction`, then a zone.
    let rest = &s[19..];
    let rest = rest
        .strip_prefix('.')
        .map(|frac| &frac[frac.bytes().take_while(u8::is_ascii_digit).count()..])
        .unwrap_or(rest);
    rest.eq_ignore_ascii_case("Z") || is_numeric_offset(rest)
}

/// `±HH:MM` numeric timezone offset.
fn is_numeric_offset(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 6
        && (b[0] == b'+' || b[0] == b'-')
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3] == b':'
        && b[4].is_ascii_digit()
        && b[5].is_ascii_digit()
}

/// Map every `core::Error` to a dashboard-stable code. `message` is a fixed
/// human string per code and NEVER interpolates a filesystem path (m4);
/// `detail` carries the path-bearing Display as server-side diagnostics only —
/// the route layer logs it and must not forward it to clients.
fn map_core_error(e: CoreError) -> LibraryError {
    let detail = e.to_string();
    let (code, message): (&str, &str) = match e {
        CoreError::InvalidPrimitiveName { .. } => ("library_invalid_name", "invalid primitive name"),
        CoreError::InvalidVersionLabel { .. } => ("library_invalid_version", "invalid version label"),
        CoreError::Io { .. } => ("library_unreadable", "could not read a library file"),
        CoreError::NotALibrary { .. } => ("library_marker_missing", "not a prompt-library directory"),
        CoreError::PrimitiveNotFound { .. } => ("primitive_not_found", "primitive not found"),
        CoreError::MetadataParse(_)
        | CoreError::CodexAgentParse(_)
        | CoreError::NotUtf8(_)
        | CoreError::MdFrontmatter(_)
        | CoreError::SettingsParse(_)
        | CoreError::InvalidCurrentMarker(_) => ("library_parse_error", "could not parse a library file"),
        // Write/drift variants the install-drift slice now reaches — promoted
        // out of the catch-all so the route layer can map them to actionable
        // HTTP statuses and the UI can offer the right next step.
        CoreError::NoCurrentVersionForInstall => {
            ("library_no_current_version", "primitive has no current version to install")
        }
        CoreError::NoInstallRecord { .. } => {
            ("drift_no_install_record", "no install record for that target")
        }
        CoreError::InstallsParse(_) => ("installs_parse_error", "could not parse installs.json"),
        CoreError::InstallsSerialize(_) => ("installs_serialize_error", "could not write installs.json"),
        CoreError::TargetNotAllowed { .. } => {
            ("library_target_not_allowed", "target is not in the primitive's allowed_targets")
        }
        CoreError::TargetNotAllowedForKind { .. } => {
            ("library_target_not_allowed_for_kind", "target is not allowed for this kind")
        }
        CoreError::InstallNotSupported { .. } => {
            ("library_install_not_supported", "install is not supported for this kind/target")
        }
        // Anything still unmapped is a genuine bridge bug, not a known
        // application state.
        _ => ("bridge_command_failed", "library command failed"),
    };
    LibraryError::new(code, message, detail)
}

fn serialize_err(e: serde_json::Error) -> LibraryError {
    LibraryError::new(
        "bridge_command_failed",
        "could not serialize response",
        e.to_string(),
    )
}

// ---------------------------------------------------------------------------
// Envelope + types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    v: Option<u32>,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct TargetInfo {
    target: String,
    dir_name: String,
}

/// Minimal probe over a source `installs.json` — reads ONLY `format_version`
/// (serde ignores the rest), so a version skew is detected before a full
/// `InstallsFile::load` that could fail on an unknown v2 field first (D6/D9).
#[derive(Deserialize)]
struct VersionProbe {
    format_version: u32,
}

#[derive(Debug)]
struct LibraryError {
    code: &'static str,
    message: &'static str,
    detail: String,
}

impl LibraryError {
    fn new(code: &'static str, message: &'static str, detail: impl Into<String>) -> Self {
        Self { code, message, detail: detail.into() }
    }
}

fn ok_envelope(data: Value) -> Value {
    json!({ "v": PROTOCOL_VERSION, "ok": true, "data": data })
}

fn err_envelope(e: &LibraryError) -> Value {
    json!({
        "v": PROTOCOL_VERSION,
        "ok": false,
        "error": { "code": e.code, "message": e.message, "detail": e.detail },
    })
}

/// Write the response envelope to stdout as a single NDJSON line. stdout is
/// protocol-only; everything else in this process must go to stderr.
fn emit(envelope: &Value) {
    let line = serde_json::to_string(envelope)
        .unwrap_or_else(|_| String::from(r#"{"v":1,"ok":false,"error":{"code":"bridge_command_failed","message":"could not serialize response","detail":""}}"#));
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use prompt_library_core::{
        library_init::init_library, scaffold::scaffold_primitive, scaffold_skill,
        update_primitive_metadata, MetadataUpdate, VersionMetadata, VersionStore, WorkingCopy,
    };
    use tempfile::TempDir;

    const NOW: &str = "2026-04-30T12:00:00Z";

    /// A fixture Library built with core's own scaffolding (not hand-authored
    /// JSON) so the bridge contract is exercised against real serde output.
    fn fixture_library() -> (TempDir, Utf8PathBuf) {
        let tmp = TempDir::new().unwrap();
        // canonicalize so the path matches what require_library resolves to
        // (macOS /var → /private/var symlink would otherwise diverge).
        let root = Utf8PathBuf::from_path_buf(tmp.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        let n = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_primitive(LibraryLayout::new(&root), PrimitiveKind::Skill, &n, NOW, None).unwrap();
        (tmp, root)
    }

    fn args_path(root: &Utf8PathBuf) -> Value {
        json!({ "path": root.as_str() })
    }

    // ---- install/drift fixtures --------------------------------------------

    /// A published, installable `diagnose` skill + a temp install home + a temp
    /// `installs.json` path — everything an install/drift command needs. The
    /// three `TempDir`s are held so they outlive the test.
    struct InstallFx {
        _lib: TempDir,
        _home: TempDir,
        _data: TempDir,
        root: Utf8PathBuf,
        home: Utf8PathBuf,
        installs: Utf8PathBuf,
    }

    fn install_fx(allowed: Vec<Target>) -> InstallFx {
        let lib = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(lib.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        publish_skill(&root, "diagnose", allowed);

        let home_tmp = TempDir::new().unwrap();
        let home = Utf8PathBuf::from_path_buf(home_tmp.path().canonicalize().unwrap()).unwrap();
        let data = TempDir::new().unwrap();
        let installs = Utf8PathBuf::from_path_buf(data.path().canonicalize().unwrap())
            .unwrap()
            .join("installs.json");
        InstallFx { _lib: lib, _home: home_tmp, _data: data, root, home, installs }
    }

    /// scaffold → seed a base `SKILL.md` → set `allowed_targets` → snapshot as
    /// v1 (writes `current.txt`). Mirrors core's own `published_skill` helper so
    /// `install` has a pinned version to deploy.
    fn publish_skill(root: &Utf8PathBuf, name: &str, allowed: Vec<Target>) {
        let layout = LibraryLayout::new(root);
        let n = PrimitiveName::try_new(name).unwrap();
        scaffold_skill(layout, &n, NOW).unwrap();
        WorkingCopy::new(layout)
            .save_base_file(
                PrimitiveKind::Skill,
                &n,
                camino::Utf8Path::new("SKILL.md"),
                b"---\n---\nbody-v1\n",
            )
            .unwrap();
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &n,
            MetadataUpdate {
                allowed_targets: allowed,
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        VersionStore::new(layout)
            .snapshot(
                PrimitiveKind::Skill,
                &n,
                &VersionLabel::try_new("v1").unwrap(),
                &VersionMetadata { created_at: NOW.into(), notes: None },
            )
            .unwrap();
    }

    /// Full args for an install/uninstall of `diagnose`.
    fn write_args(fx: &InstallFx, targets: Value, force: bool) -> Value {
        json!({
            "path": fx.root.as_str(),
            "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "kind": "skill",
            "name": "diagnose",
            "targets": targets,
            "force": force,
            "installed_at": NOW,
        })
    }

    /// Args for the per-primitive scan / list commands (no targets/force/clock).
    fn drift_args(fx: &InstallFx) -> Value {
        json!({
            "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "kind": "skill",
            "name": "diagnose",
        })
    }

    /// Args for a per-target acknowledge.
    fn ack_args(fx: &InstallFx, target: &str) -> Value {
        json!({
            "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "kind": "skill",
            "name": "diagnose",
            "target": target,
        })
    }

    /// The on-disk file a Skill→Claude install lands at (a directory holding
    /// `SKILL.md`).
    fn claude_skill_file(fx: &InstallFx, name: &str) -> Utf8PathBuf {
        fx.home.join(".claude/skills").join(name).join("SKILL.md")
    }

    // ---- envelope + dispatch ------------------------------------------------

    #[tokio::test]
    async fn kind_info_returns_total_table() {
        let env = handle(r#"{"v":1,"command":"kind_info"}"#).await;
        assert_eq!(env["ok"], json!(true));
        assert_eq!(env["v"], json!(1));
        let data = &env["data"];
        // total record keyed by Kind — every Kind present, no optionality
        for k in ["skill", "agent", "command", "codex_agent"] {
            assert!(data.get(k).is_some(), "missing kind {k}");
        }
        assert_eq!(data["skill"]["primary_filename"]["value"], json!("SKILL.md"));
        assert_eq!(data["codex_agent"]["allowed_targets"], json!(["codex"]));
    }

    #[tokio::test]
    async fn target_info_lists_library_targets_only() {
        let env = handle(r#"{"v":1,"command":"target_info"}"#).await;
        assert_eq!(env["ok"], json!(true));
        assert_eq!(
            env["data"]["targets"],
            json!([
                { "target": "claude", "dir_name": "claude" },
                { "target": "pi", "dir_name": "pi" },
                { "target": "codex", "dir_name": "codex" },
            ])
        );
    }

    #[tokio::test]
    async fn list_primitives_returns_scaffolded_summary() {
        let (_tmp, root) = fixture_library();
        let data = cmd_list_primitives(&args_path(&root)).unwrap();
        let arr = data.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["kind"], json!("skill"));
        assert_eq!(arr[0]["name"], json!("diagnose"));
        assert_eq!(arr[0]["dirty"], json!(false));
        assert_eq!(arr[0]["author"], Value::Null);
    }

    #[tokio::test]
    async fn primitive_detail_returns_tagged_working_content() {
        let (_tmp, root) = fixture_library();
        let mut args = args_path(&root);
        args["kind"] = json!("skill");
        args["name"] = json!("diagnose");
        let data = cmd_primitive_detail(&args).unwrap();
        assert_eq!(data["kind"], json!("skill"));
        assert_eq!(data["name"], json!("diagnose"));
        // WorkingContent is a tagged enum — MD-shaped for a Skill
        assert_eq!(data["working"]["kind"], json!("md"));
        assert!(data["working"]["frontmatter"].is_string());
        assert!(data["metadata"]["allowed_targets"].is_array());
    }

    #[tokio::test]
    async fn library_status_reports_valid_marker() {
        let (_tmp, root) = fixture_library();
        let data = cmd_library_status(&args_path(&root)).await.unwrap();
        assert_eq!(data["is_valid"], json!(true));
        assert_eq!(data["marker_exists"], json!(true));
        // tempdir is not a git repo → first-class status, not an error
        assert_eq!(data["is_git_repo"], json!(false));
        assert_eq!(data["branch"], Value::Null);
    }

    // ---- error mapping ------------------------------------------------------

    #[tokio::test]
    async fn missing_marker_is_marker_missing_for_all_read_commands() {
        // a real dir with NO .prompt-library marker
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().canonicalize().unwrap()).unwrap();
        let mut args = args_path(&root);
        args["kind"] = json!("skill");
        args["name"] = json!("diagnose");

        let list = cmd_list_primitives(&args).unwrap_err();
        assert_eq!(list.code, "library_marker_missing");
        let detail = cmd_primitive_detail(&args).unwrap_err();
        assert_eq!(detail.code, "library_marker_missing");
        // status, by contrast, reports it as data — never an error
        let status = cmd_library_status(&args).await.unwrap();
        assert_eq!(status["is_valid"], json!(false));
        assert_eq!(status["marker_exists"], json!(false));
    }

    #[tokio::test]
    async fn nonexistent_path_is_invalid_path() {
        let args = json!({ "path": "/no/such/library/here" });
        let err = cmd_list_primitives(&args).unwrap_err();
        assert_eq!(err.code, "library_invalid_path");
    }

    #[tokio::test]
    async fn empty_path_is_unconfigured() {
        let err = cmd_list_primitives(&json!({ "path": "" })).unwrap_err();
        assert_eq!(err.code, "library_unconfigured");
    }

    #[tokio::test]
    async fn traversal_name_is_invalid_name_not_a_path_join() {
        let (_tmp, root) = fixture_library();
        for payload in ["../../etc/passwd", "..", "/etc/passwd", ".hidden", "a/b"] {
            let mut args = args_path(&root);
            args["kind"] = json!("skill");
            args["name"] = json!(payload);
            let err = cmd_primitive_detail(&args).unwrap_err();
            assert_eq!(
                err.code, "library_invalid_name",
                "payload `{payload}` should be rejected by PrimitiveName::try_new"
            );
        }
    }

    #[tokio::test]
    async fn unknown_kind_is_invalid_kind() {
        let (_tmp, root) = fixture_library();
        let mut args = args_path(&root);
        args["kind"] = json!("widget");
        args["name"] = json!("diagnose");
        let err = cmd_primitive_detail(&args).unwrap_err();
        assert_eq!(err.code, "library_invalid_kind");
    }

    #[tokio::test]
    async fn missing_primitive_is_not_found() {
        let (_tmp, root) = fixture_library();
        let mut args = args_path(&root);
        args["kind"] = json!("skill");
        args["name"] = json!("does-not-exist");
        let err = cmd_primitive_detail(&args).unwrap_err();
        assert_eq!(err.code, "primitive_not_found");
    }

    // ---- protocol envelope --------------------------------------------------

    #[tokio::test]
    async fn bad_json_is_bridge_bad_request() {
        let env = handle("not json at all").await;
        assert_eq!(env["ok"], json!(false));
        assert_eq!(env["error"]["code"], json!("bridge_bad_request"));
    }

    #[tokio::test]
    async fn wrong_protocol_version_is_rejected() {
        let env = handle(r#"{"v":2,"command":"kind_info"}"#).await;
        assert_eq!(env["error"]["code"], json!("protocol_version_mismatch"));
    }

    #[tokio::test]
    async fn missing_protocol_version_is_rejected() {
        let env = handle(r#"{"command":"kind_info"}"#).await;
        assert_eq!(env["error"]["code"], json!("protocol_version_mismatch"));
    }

    #[tokio::test]
    async fn unknown_command_is_rejected() {
        let env = handle(r#"{"v":1,"command":"install_everything"}"#).await;
        assert_eq!(env["error"]["code"], json!("unknown_command"));
    }

    // ---- golden fixtures (drift guard vs the dashboard's committed JSON) ----

    /// The path-independent capability tables are the dashboard's source for
    /// legal Kinds/Targets/filenames. If a core serde rename changes their
    /// shape, the committed `scripts/fixtures/bridge/*.json` (which the TS
    /// validators are tested against) would silently desync — they're frozen.
    /// These goldens make that a Rust test failure instead, pointing at
    /// `capture.ts` for regeneration.
    fn golden_data(fixture: &str) -> Value {
        let env: Value = serde_json::from_str(fixture).expect("fixture is valid JSON");
        env["data"].clone()
    }

    #[tokio::test]
    async fn kind_info_matches_committed_fixture() {
        let env = handle(r#"{"v":1,"command":"kind_info"}"#).await;
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/kind_info.json"));
        assert_eq!(
            env["data"], expected,
            "kind_info drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[tokio::test]
    async fn target_info_matches_committed_fixture() {
        let env = handle(r#"{"v":1,"command":"target_info"}"#).await;
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/target_info.json"));
        assert_eq!(
            env["data"], expected,
            "target_info drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    // The write-side goldens tie the committed install/uninstall/scan_drift/
    // list_installs bytes (which the TS validators parse) to LIVE core output, so
    // a serde rename on the tagged enums fails `cargo test` instead of silently
    // desyncing the frozen fixtures. Their `data` carries no absolute path
    // (conflicts are install-relative; version/timestamp pinned), so a fresh
    // temp-home install reproduces the committed bytes exactly.

    #[test]
    fn install_summary_matches_committed_fixture() {
        let fx = install_fx(vec![Target::Claude]);
        let data = cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/install_summary.json"));
        assert_eq!(
            data, expected,
            "install_summary drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[test]
    fn scan_drift_matches_committed_fixture() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let data = cmd_scan_drift(&drift_args(&fx)).unwrap();
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/scan_drift.json"));
        assert_eq!(
            data, expected,
            "scan_drift drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[test]
    fn list_installs_matches_committed_fixture() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let data = cmd_list_installs_for_primitive(&drift_args(&fx)).unwrap();
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/list_installs.json"));
        assert_eq!(
            data, expected,
            "list_installs drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[test]
    fn uninstall_summary_matches_committed_fixture() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let data = cmd_uninstall(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let expected = golden_data(include_str!("../../../scripts/fixtures/bridge/uninstall_summary.json"));
        assert_eq!(
            data, expected,
            "uninstall_summary drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[tokio::test]
    async fn error_message_carries_no_filesystem_path() {
        // m4: `message` is path-free; only `detail` may carry the path.
        let env = handle(r#"{"v":1,"command":"list_primitives","args":{"path":"/no/such/lib"}}"#).await;
        let message = env["error"]["message"].as_str().unwrap();
        assert!(!message.contains('/'), "message leaked a path: {message}");
    }

    // ---- install / uninstall (write path) -----------------------------------
    //
    // Every test injects a temp `home` (the `CC_LIBRARY_HOME` mechanism) — no
    // test writes the real `~/.claude`. The no-network/no-secrets invariant is
    // structural: the crate doesn't depend on `prompt-library-secrets` (a
    // `SecretStore` is unconstructible) and install is fs-only.

    #[test]
    fn install_writes_files_and_records_state() {
        let fx = install_fx(vec![Target::Claude]);
        let data = cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(data["successes"][0]["outcome"]["kind"], json!("installed"));
        assert!(data["failures"].as_array().unwrap().is_empty());
        assert!(claude_skill_file(&fx, "diagnose").exists());
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert_eq!(installs.records.len(), 1);
        assert_eq!(installs.records[0].target, Target::Claude);
    }

    #[test]
    fn reinstall_identical_content_is_no_op() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let again = cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(again["successes"][0]["outcome"]["kind"], json!("no_op_identical"));
    }

    #[test]
    fn collision_without_force_preserves_disk_then_force_overwrites() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let file = claude_skill_file(&fx, "diagnose");
        std::fs::write(file.as_std_path(), b"externally edited").unwrap();

        // force:false → colliding_content, disk untouched. (Collision detection
        // hashes directly, so no mtime sleep is needed here.)
        let collide = cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let outcome = &collide["successes"][0]["outcome"];
        assert_eq!(outcome["kind"], json!("colliding_content"));
        assert!(!outcome["conflicts"].as_array().unwrap().is_empty());
        assert_eq!(std::fs::read(file.as_std_path()).unwrap(), b"externally edited");

        // force:true → installed, disk overwritten.
        let forced = cmd_install(&write_args(&fx, json!(["claude"]), true)).unwrap();
        assert_eq!(forced["successes"][0]["outcome"]["kind"], json!("installed"));
        assert_ne!(std::fs::read(file.as_std_path()).unwrap(), b"externally edited");
    }

    #[test]
    fn install_requires_well_formed_installed_at() {
        let fx = install_fx(vec![Target::Claude]);
        // Missing entirely.
        let mut missing = write_args(&fx, json!(["claude"]), false);
        missing.as_object_mut().unwrap().remove("installed_at");
        assert_eq!(cmd_install(&missing).unwrap_err().code, "bridge_bad_request");
        // A unix-millis string is the classic trap a "contains a T" check passes.
        let mut bad = write_args(&fx, json!(["claude"]), false);
        bad["installed_at"] = json!("1717000000000");
        assert_eq!(cmd_install(&bad).unwrap_err().code, "bridge_bad_request");
    }

    #[test]
    fn install_without_current_version_is_no_current_version() {
        // Published metadata but NO snapshot → no current.txt to install from.
        let lib = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(lib.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        let n = PrimitiveName::try_new("diagnose").unwrap();
        scaffold_skill(LibraryLayout::new(&root), &n, NOW).unwrap();
        update_primitive_metadata(
            LibraryLayout::new(&root),
            PrimitiveKind::Skill,
            &n,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        let data = TempDir::new().unwrap();
        let installs = Utf8PathBuf::from_path_buf(data.path().to_path_buf())
            .unwrap()
            .join("installs.json");
        let args = json!({
            "path": root.as_str(), "home": root.as_str(), "installs_path": installs.as_str(),
            "kind": "skill", "name": "diagnose", "targets": ["claude"], "force": false,
            "installed_at": NOW,
        });
        assert_eq!(cmd_install(&args).unwrap_err().code, "library_no_current_version");
    }

    #[test]
    fn uninstall_clean_removes_record_then_is_idempotent() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let removed = cmd_uninstall(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(removed["successes"][0]["outcome"]["kind"], json!("removed"));
        assert!(!claude_skill_file(&fx, "diagnose").exists());
        assert!(InstallsFile::load(&fx.installs).unwrap().records.is_empty());
        // A second uninstall is a no-op, not an error.
        let again = cmd_uninstall(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(again["successes"][0]["outcome"]["kind"], json!("not_installed"));
    }

    #[test]
    fn uninstall_drifted_without_force_is_drifted_then_force_removes() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        // uninstall_drift hashes directly (not mtime-gated) → no sleep needed.
        std::fs::write(claude_skill_file(&fx, "diagnose").as_std_path(), b"edited").unwrap();
        let drifted = cmd_uninstall(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(drifted["successes"][0]["outcome"]["kind"], json!("drifted"));
        assert!(claude_skill_file(&fx, "diagnose").exists()); // disk untouched
        let forced = cmd_uninstall(&write_args(&fx, json!(["claude"]), true)).unwrap();
        assert_eq!(forced["successes"][0]["outcome"]["kind"], json!("removed"));
        assert!(!claude_skill_file(&fx, "diagnose").exists());
    }

    // ---- drift (scan + acknowledge) -----------------------------------------

    #[test]
    fn scan_drift_modified_then_acknowledge_returns_clean() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        assert_eq!(
            cmd_scan_drift(&drift_args(&fx)).unwrap()[0]["status"]["kind"],
            json!("clean")
        );
        // Sleep so the OS records a different mtime than install wrote —
        // otherwise the scanner's mtime fast-path masks the hash change (core
        // does the same in its own drift tests).
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(claude_skill_file(&fx, "diagnose").as_std_path(), b"edited").unwrap();
        assert_eq!(
            cmd_scan_drift(&drift_args(&fx)).unwrap()[0]["status"]["kind"],
            json!("modified")
        );
        // Acknowledge adopts the current bytes as the new baseline → next scan
        // is clean.
        cmd_acknowledge_drift(&ack_args(&fx, "claude")).unwrap();
        assert_eq!(
            cmd_scan_drift(&drift_args(&fx)).unwrap()[0]["status"]["kind"],
            json!("clean")
        );
    }

    #[test]
    fn scan_drift_missing_when_install_deleted() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        std::fs::remove_dir_all(fx.home.join(".claude/skills/diagnose").as_std_path()).unwrap();
        assert_eq!(
            cmd_scan_drift(&drift_args(&fx)).unwrap()[0]["status"]["kind"],
            json!("missing")
        );
    }

    #[test]
    fn acknowledge_without_record_is_no_install_record() {
        let fx = install_fx(vec![Target::Claude]);
        // Nothing installed → no record for (skill, diagnose, claude).
        let err = cmd_acknowledge_drift(&ack_args(&fx, "claude")).unwrap_err();
        assert_eq!(err.code, "drift_no_install_record");
    }

    #[test]
    fn scan_drift_batch_returns_every_recorded_target() {
        let fx = install_fx(vec![Target::Claude, Target::Pi]);
        cmd_install(&write_args(&fx, json!(["claude", "pi"]), false)).unwrap();
        let batch = cmd_scan_drift_batch(&drift_args(&fx)).unwrap();
        let arr = batch.as_array().unwrap();
        assert_eq!(arr.len(), 2, "one report per recorded (kind,name,target)");
        assert!(arr.iter().all(|r| r["status"]["kind"] == json!("clean")));
    }

    // ---- list_installs ------------------------------------------------------

    #[test]
    fn list_installs_reflects_records_and_is_empty_for_unknown() {
        let fx = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&fx, json!(["claude"]), false)).unwrap();
        let listed = cmd_list_installs_for_primitive(&drift_args(&fx)).unwrap();
        let arr = listed.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["target"], json!("claude"));
        assert_eq!(arr[0]["installed_version"], json!("v1"));
        assert_eq!(arr[0]["installed_at"], json!(NOW));
        // A different (existing-shape) name → empty vec, never an error.
        let mut other = drift_args(&fx);
        other["name"] = json!("not-installed-name");
        assert!(cmd_list_installs_for_primitive(&other)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }

    // ---- import (migration) -------------------------------------------------

    #[test]
    fn import_copies_records_and_leaves_source_untouched() {
        // Build a real source `installs.json` by installing into a scratch fx.
        let src = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&src, json!(["claude"]), false)).unwrap();
        let source_before = std::fs::read(src.installs.as_std_path()).unwrap();

        let dest_dir = TempDir::new().unwrap();
        let dest = Utf8PathBuf::from_path_buf(dest_dir.path().to_path_buf())
            .unwrap()
            .join("installs.json");
        let data = cmd_import_installs(&json!({
            "source_path": src.installs.as_str(),
            "installs_path": dest.as_str(),
        }))
        .unwrap();
        assert_eq!(data["imported"], json!(1));
        assert_eq!(InstallsFile::load(&dest).unwrap().records.len(), 1);
        assert_eq!(std::fs::read(src.installs.as_std_path()).unwrap(), source_before);
    }

    #[test]
    fn import_refuses_when_dest_already_has_records() {
        let src = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&src, json!(["claude"]), false)).unwrap();
        // Point dest at the populated file itself → ≥1 record → refuse.
        let err = cmd_import_installs(&json!({
            "source_path": src.installs.as_str(),
            "installs_path": src.installs.as_str(),
        }))
        .unwrap_err();
        assert_eq!(err.code, "installs_already_present");
    }

    #[test]
    fn import_proceeds_over_empty_default_dest() {
        let src = install_fx(vec![Target::Claude]);
        cmd_install(&write_args(&src, json!(["claude"]), false)).unwrap();
        // An empty/default installs.json at the dest is nothing to protect (D6).
        let dest_dir = TempDir::new().unwrap();
        let dest = Utf8PathBuf::from_path_buf(dest_dir.path().to_path_buf())
            .unwrap()
            .join("installs.json");
        InstallsFile::default().save(&dest).unwrap();
        let data = cmd_import_installs(&json!({
            "source_path": src.installs.as_str(),
            "installs_path": dest.as_str(),
        }))
        .unwrap();
        assert_eq!(data["imported"], json!(1));
    }

    #[test]
    fn import_rejects_format_version_mismatch() {
        let (source, dest) = import_paths();
        std::fs::write(
            source.as_std_path(),
            br#"{"format_version": 999, "records": []}"#,
        )
        .unwrap();
        let err = cmd_import_installs(&json!({
            "source_path": source.as_str(), "installs_path": dest.as_str(),
        }))
        .unwrap_err();
        assert_eq!(err.code, "installs_format_mismatch");
    }

    #[test]
    fn import_rejects_corrupt_source() {
        let (source, dest) = import_paths();
        std::fs::write(source.as_std_path(), b"not json at all").unwrap();
        let err = cmd_import_installs(&json!({
            "source_path": source.as_str(), "installs_path": dest.as_str(),
        }))
        .unwrap_err();
        assert_eq!(err.code, "installs_source_corrupt");
    }

    /// A throwaway (source, dest) pair under separate temp dirs. Leaks the
    /// `TempDir`s deliberately (`keep`) so the paths stay live for the length of
    /// the test without binding the guards.
    fn import_paths() -> (Utf8PathBuf, Utf8PathBuf) {
        let src = Utf8PathBuf::from_path_buf(TempDir::new().unwrap().keep()).unwrap();
        let dst = Utf8PathBuf::from_path_buf(TempDir::new().unwrap().keep()).unwrap();
        (src.join("installs.json"), dst.join("installs.json"))
    }

    // ---- path resolution + dispatch wiring ----------------------------------

    #[test]
    fn missing_installs_path_is_unconfigured() {
        let err = cmd_scan_drift_batch(&json!({ "home": "/tmp" })).unwrap_err();
        assert_eq!(err.code, "installs_unconfigured");
    }

    #[test]
    fn missing_home_is_unconfigured() {
        let err =
            cmd_scan_drift_batch(&json!({ "installs_path": "/tmp/installs.json" })).unwrap_err();
        assert_eq!(err.code, "installs_unconfigured");
    }

    #[tokio::test]
    async fn install_dispatches_through_the_envelope() {
        let fx = install_fx(vec![Target::Claude]);
        let req = json!({
            "v": 1, "command": "install", "args": write_args(&fx, json!(["claude"]), false),
        });
        let env = handle(&req.to_string()).await;
        assert_eq!(env["ok"], json!(true));
        assert_eq!(
            env["data"]["successes"][0]["outcome"]["kind"],
            json!("installed")
        );
    }
}
