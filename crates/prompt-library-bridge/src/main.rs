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
//! - **secrets + network are reachable ONLY from the git-sync commands.**
//!   Through Slice 7 + bootstrap this was "no network, no secrets on ANY path."
//!   Slice 8 (git remote sync) breaks that invariant exactly once, on purpose
//!   (ADR-noted): the PAT lives in the macOS Keychain, so the bridge now links
//!   prompt-library-secrets. The break is contained — a `SecretStore` is
//!   constructed ONLY by `configure_remote`/`set_pat`/`delete_pat`/
//!   `get_remote_status` (and the Phase-2 push/pull family) via
//!   `secret_store(args)`; every other command constructs none. Likewise only
//!   push/pull egress to the network; no other command touches core's
//!   reqwest-backed url_import. The raw PAT never reaches a log or a response
//!   body — the only wire form is `redact_pat` (D6 tripwire).
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

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use prompt_library_core::{
    acknowledge_drift, bootstrap_execute, bootstrap_scan,
    detail::{
        list_overlays, read_primitive_detail, read_primitive_for_target,
        read_primitive_version_view, revert_primitive_to_version,
    },
    delete_primitive, derive_plan, duplicate_primitive, find_in_library, forget_primitive,
    import_primitive_from_path, install, listing::list_primitives, reimport_install_as_version,
    rename_primitive, scaffold_primitive, scan_drift_for_primitive, scan_record, uninstall,
    update_primitive_metadata, working_files, BootstrapExecuteRequest, BootstrapPlan,
    BootstrapSession, DeletePrimitiveRequest, DriftReport, DuplicatePrimitiveRequest,
    Error as CoreError, FindOptions, ImportFromPathResult, InstallPaths, InstallRequest,
    InstallsFile, KindInfoTable, LibraryLayout, MetadataUpdate, PrimitiveKind, PrimitiveName,
    ReimportRequest, ReimportResult, RenamePrimitiveRequest, Target, UninstallRequest,
    VersionLabel, VersionMetadata, VersionStore, WorkingCopy, INSTALLS_FORMAT_VERSION,
};
use std::time::Duration;

use prompt_library_core::remote_url::{validate_remote_url, RemoteUrlError};
use prompt_library_git::{
    askpass::{init_askpass_script, AskpassError},
    conflict::{
        is_rebase_in_progress, list_unmerged_paths, read_conflict_side, rebase_abort,
        rebase_continue, resolve_with_side, Side,
    },
    file_scan::FileFinding,
    git_ops::{
        current_branch, git_add_all, git_commit, git_diff_changed_files, git_pull, git_push,
        git_push_with_upstream, remote_branch_exists,
    },
    push_gate::scan_pending_push,
    runner::{GitRunner, RunnerError, TokioProcessRunner},
    secret_scan::FindingKind,
};
use prompt_library_secrets::{redact_pat, InMemoryStore, SecretError, SecretStore};
#[cfg(target_os = "macos")]
use prompt_library_secrets::KeychainStore;

const PROTOCOL_VERSION: u32 = 1;

/// Empty-tree blob hash — the "from" side of a diff range for the first push of
/// a branch (`<empty-tree>..HEAD` enumerates every path so the secret-scan gate
/// sees the whole initial import, not just commits since a non-existent
/// upstream). Ported verbatim from the reference (`commands.rs:1646`).
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Wall-clock cap on an interactive `git pull --rebase`. Longer than the
/// reference's 2 s launch-hook cap (an interactive user-initiated pull should
/// tolerate a slow-but-healthy network) but bounded so a hung network can't
/// wedge the route's write chain forever. The TS NETWORK_TIMEOUT (Phase 3) is
/// the outer SIGKILL bound — set larger than this so this inner timeout fires
/// first with a clean `git_timed_out`, never a torn SIGKILL (D5).
const PULL_TIMEOUT: Duration = Duration::from_secs(60);

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
        // Search slice. Read-only, sync — `find_in_library` walks each
        // primitive's working-copy PRIMARY file with std::fs only (no ref files,
        // no commit, no mutex, no secrets). An empty query short-circuits in-core
        // to `[]`, so there is no special-casing here.
        "find_in_library" => cmd_find_in_library(args),
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
        // Working-copy / editor slice. All sync — std::fs only, like the
        // install commands. `save_working` edits the PRIMARY file (parse-
        // validated); the `*_working_file` commands edit ref files (which
        // refuse the primary filename in-core). Reads (`list`/`read`) and
        // writes share the same library-root resolution via `require_library`.
        "save_working" => cmd_save_working(args),
        "list_working_files" => cmd_list_working_files(args),
        "read_working_file" => cmd_read_working_file(args),
        "create_working_file" => cmd_create_working_file(args),
        "save_working_file" => cmd_save_working_file(args),
        "rename_working_file" => cmd_rename_working_file(args),
        "delete_working_file" => cmd_delete_working_file(args),
        // Versioning / publishing slice. `publish`/`set_current_version` are
        // snapshot-then-commit (the commit is async git, so `.await`);
        // `read_primitive_version`/`revert_to_version` are sync version/working
        // fs ops with NO commit (the runtime is only needed by the git calls).
        "publish" => cmd_publish(args).await,
        "set_current_version" => cmd_set_current_version(args).await,
        "read_primitive_version" => cmd_read_primitive_version(args),
        "revert_to_version" => cmd_revert_to_version(args),
        // Target-overlays slice. All sync — std::fs only, like the working-file
        // arms. Overlays write under gitignored `working/targets/<target>/`, so
        // there is NO commit step (a commit would no-op). `write_overlay`/
        // `remove_overlay` edit the PRIMARY overlay file only (the reference
        // surface); `read_primitive_target` returns the merged primary +
        // `has_overlay`; `list_overlays` enumerates every target's overlay files.
        "read_primitive_target" => cmd_read_primitive_target(args),
        "write_overlay" => cmd_write_overlay(args),
        "remove_overlay" => cmd_remove_overlay(args),
        "list_overlays" => cmd_list_overlays(args),
        // Metadata-editing slice. `metadata.yaml` is git-TRACKED (NOT under the
        // gitignored `working/`), so unlike the overlay writes above this one
        // COMMITS (`.await`) — the same non-fatal commit-on-write posture as
        // publish/set-current (Slice 4), not the no-commit overlay posture.
        "update_metadata" => cmd_update_metadata(args).await,
        // Reimport-from-drift slice. Pulls an installed copy's on-disk (drifted)
        // bytes back into the library as a NEW published version, then
        // re-baselines `installs.json` so the next drift scan reads Clean. The
        // new `versions/<label>/` tree is git-TRACKED, so this COMMITS on the
        // `Reimported` outcome (`.await`) — the same commit-on-write posture as
        // publish (Slice 4). NOTE: this DIVERGES from the reference, which never
        // commits reimport; the dashboard commits so the reimported version is
        // not left as an uncommitted tree a later publish would sweep up under
        // the wrong message. The non-success outcomes (dirty/broken/missing)
        // wrote nothing git-tracked, so they do NOT commit.
        "reimport_install" => cmd_reimport(args).await,
        // Primitive-lifecycle slice. Structural CRUD over the library:
        // create/delete/rename/duplicate/import edit the git-TRACKED library
        // tree, so they COMMIT on the same non-fatal commit-on-write posture as
        // publish (Slice 4) — `.await`. `forget` touches only the
        // dashboard-owned `installs.json` (gitignored / outside the library
        // repo), so it does NOT commit — the uninstall posture (sync). delete/
        // rename/import/forget mutate `installs.json`, so the route serializes
        // them under the write mutex.
        "create_primitive" => cmd_create_primitive(args).await,
        "delete_primitive" => cmd_delete_primitive(args).await,
        "rename_primitive" => cmd_rename_primitive(args).await,
        "duplicate_primitive" => cmd_duplicate_primitive(args).await,
        "import_primitive_from_path" => cmd_import_primitive_from_path(args).await,
        "forget_primitive" => cmd_forget_primitive(args),
        // Bootstrap discovery slice. The first-run "scan your machine for
        // existing primitives and import them" wizard. `bootstrap_scan` is SYNC
        // + read-only (std::fs walk of the home install roots + library
        // cross-reference; no commit, no ledger mutation — like
        // find_in_library) and folds the pure `derive_plan` in, returning
        // `{cross_referenced, plan}` in one envelope. The Tauri
        // `Channel<ScanProgress>` is DROPPED (no web event channel; the 3 fixed
        // coarse stages render client-side) — a no-op `on_progress`, as core's
        // own tests use. `bootstrap_execute` is ASYNC — it writes new
        // version trees + reimports drifted ones and COMMITS, but ONLY when
        // `created + reimported > 0` (the reimport commit-gating posture; the
        // reference always commits — we diverge to avoid an empty
        // "created 0, reimported 0" commit). It mutates `installs.json`, so the
        // route serializes it under the write mutex (the reimport divergence
        // from publish). `read`/`clear` session are SYNC, no commit — they touch
        // only the dashboard-owned bootstrap session file.
        "bootstrap_scan" => cmd_bootstrap_scan(args),
        "bootstrap_execute" => cmd_bootstrap_execute(args).await,
        "read_bootstrap_session" => cmd_read_bootstrap_session(args),
        "clear_bootstrap_session" => cmd_clear_bootstrap_session(args),
        // Git-remote-sync slice (Slice 8) — the ONE secrets + network break.
        // Phase 1 (here) is the secrets break with NO network: `configure_remote`
        // validates the URL only (the TS route persists it to config/library.yaml
        // — the bridge owns no config file); `set_pat`/`delete_pat`/
        // `get_remote_status` construct a `SecretStore` via `secret_store(args)`
        // (real KeychainStore by default, InMemoryStore under `secret_store:
        // "memory"` / `CC_LIBRARY_SECRET_STORE=memory` so `cargo test` is
        // headless). These four are the ONLY arms that construct a secret store;
        // the raw PAT never leaves the store except as `redact_pat` (D6). Sync —
        // no network, no `.await`. The push/pull/conflict family (egress) lands
        // in Phase 2.
        "configure_remote" => cmd_configure_remote(args),
        "set_pat" => cmd_set_pat(args, secret_store(args)?.as_ref()),
        "delete_pat" => cmd_delete_pat(secret_store(args)?.as_ref()),
        "get_remote_status" => cmd_get_remote_status(args, secret_store(args)?.as_ref()),
        // Git-remote-sync Phase 2 — the network EGRESS break + the stateful
        // rebase-conflict family. `push_now`/`pull_now` get the PAT from a DI'd
        // `SecretStore` and deliver it env→askpass→git child (never argv/log/
        // return — D6); they re-write the askpass script into the TS-injected
        // `askpass_dir` per-invocation (idempotent, no launch hook — D3). The
        // conflict family (`is_pull_paused`…`abort_pull`) is secrets-free +
        // network-free: it reads the mid-rebase state that lives in `.git`, not
        // in this one-shot process (the saving grace that lets a later
        // invocation continue a rebase a prior one paused — D4). The TS route
        // serializes the whole family under the write mutex (D5). `pull_now`'s
        // conflict outcome rides the OK envelope as data (D7), not an error.
        "scan_before_push" => cmd_scan_before_push(args).await,
        "count_unpushed_commits" => cmd_count_unpushed_commits(args).await,
        "push_now" => {
            let store = secret_store(args)?;
            cmd_push_now(args, store.as_ref()).await
        }
        "pull_now" => {
            let store = secret_store(args)?;
            cmd_pull_now(args, store.as_ref()).await
        }
        "is_pull_paused" => cmd_is_pull_paused(args),
        "list_pull_conflicts" => cmd_list_pull_conflicts(args).await,
        "read_conflict_blob" => cmd_read_conflict_blob(args).await,
        "resolve_conflict" => cmd_resolve_conflict(args).await,
        "continue_pull" => cmd_continue_pull(args).await,
        "abort_pull" => cmd_abort_pull(args).await,
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

/// Library-wide content search across every primitive's working-copy PRIMARY
/// file (ref files are excluded in-core). Read-only: one `std::fs::read` per
/// primitive, capped at 500 hits. An empty `query` returns `[]` (core
/// short-circuits without walking). `case_sensitive` is an optional, forward-
/// compatible toggle defaulting to `false` (the interactive default) so a future
/// UI toggle needs no bridge change. The only failure mode is a read fault
/// (`CoreError::Io` → `library_unreadable`), already mapped.
fn cmd_find_in_library(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let query = args.get("query").and_then(Value::as_str).unwrap_or("");
    let case_sensitive = args
        .get("case_sensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let hits = find_in_library(LibraryLayout::new(&root), query, FindOptions { case_sensitive })
        .map_err(map_core_error)?;
    serde_json::to_value(hits).map_err(serialize_err)
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
// Working-copy / editor commands (working-copy slice)
// ---------------------------------------------------------------------------

/// Save the PRIMARY working file (`SKILL.md`/`agent.md`/`<name>.md`/
/// `<name>.toml`) through `WorkingCopy::save_primary_base`, which PARSE-
/// VALIDATES the bytes (MD frontmatter+body, or TOML for CodexAgent) BEFORE the
/// atomic write — malformed bytes never reach disk (they surface as
/// `library_parse_error`, the file unchanged). This is a DIFFERENT path from
/// `save_working_file`, which edits ref files and refuses the primary filename
/// in-core (W1). The UI assembles the whole `---\nfm---\nbody` blob and sends it
/// as `content`; core re-validates.
fn cmd_save_working(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let content = parse_required_str(args, "content")?;
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_base(kind, &name, content.as_bytes())
        .map_err(map_core_error)?;
    Ok(json!({}))
}

/// List every file under the primitive's `working/base/` — primary pinned
/// first, refs alphabetical (core sorts; the UI renders verbatim). `[]` when
/// `working/base/` is absent; symlinks + ignored files are skipped in-core.
fn cmd_list_working_files(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let entries = working_files::list_working_files(LibraryLayout::new(&root), kind, &name)
        .map_err(map_core_error)?;
    serde_json::to_value(entries).map_err(serialize_err)
}

/// Read one ref file's bytes as the tagged `WorkingFileBytes` union: text files
/// carry `{kind:"text", text, ext?}`; binary files (NUL in the first 8 KiB)
/// carry `{kind:"binary", size}` and NEVER stream bytes. The ref path rides
/// `args.rel` (NOT `args.path` — that is the library root, owned by
/// `require_library`) and flows straight to core, which validates it via
/// `validate_path_shape` (the containment boundary is core's — the bridge must
/// not duplicate it).
fn cmd_read_working_file(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let rel = parse_required_str(args, "rel")?;
    let bytes = working_files::read_working_file(
        LibraryLayout::new(&root),
        kind,
        &name,
        Utf8Path::new(&rel),
    )
    .map_err(map_core_error)?;
    serde_json::to_value(bytes).map_err(serialize_err)
}

/// Create a new ref file at `args.rel`. Errors `working_file_exists` if the dest
/// is occupied; `library_invalid_working_path` for the primary filename or a
/// traversal path.
fn cmd_create_working_file(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let rel = parse_required_str(args, "rel")?;
    let content = parse_required_str(args, "content")?;
    working_files::create_working_file(
        LibraryLayout::new(&root),
        kind,
        &name,
        Utf8Path::new(&rel),
        &content,
    )
    .map_err(map_core_error)?;
    Ok(json!({}))
}

/// Update the existing ref file at `args.rel`. Errors `working_file_not_found`
/// if absent (callers must `create` first).
fn cmd_save_working_file(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let rel = parse_required_str(args, "rel")?;
    let content = parse_required_str(args, "content")?;
    working_files::save_working_file(
        LibraryLayout::new(&root),
        kind,
        &name,
        Utf8Path::new(&rel),
        &content,
    )
    .map_err(map_core_error)?;
    Ok(json!({}))
}

/// Rename/move the ref file `args.old_rel` → `args.new_rel`. Refuses the primary
/// as source (`working_file_refuse_primary`); errors on missing source /
/// existing dest; creates intermediate dirs for the destination.
fn cmd_rename_working_file(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let old_rel = parse_required_str(args, "old_rel")?;
    let new_rel = parse_required_str(args, "new_rel")?;
    working_files::rename_working_file(
        LibraryLayout::new(&root),
        kind,
        &name,
        Utf8Path::new(&old_rel),
        Utf8Path::new(&new_rel),
    )
    .map_err(map_core_error)?;
    Ok(json!({}))
}

/// Delete the ref file at `args.rel`. Idempotent on a missing file; refuses the
/// primary (`working_file_refuse_primary`).
fn cmd_delete_working_file(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let rel = parse_required_str(args, "rel")?;
    working_files::delete_working_file(
        LibraryLayout::new(&root),
        kind,
        &name,
        Utf8Path::new(&rel),
    )
    .map_err(map_core_error)?;
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Versioning / publishing commands (versioning slice)
// ---------------------------------------------------------------------------

/// Snapshot the working copy into `versions/<label>/`, advance `current.txt`,
/// then `git add -A && git commit`. Publish is TWO phases and NOT atomic across
/// them (D1): the snapshot lands first (immutable; atomic per-file via core's
/// `atomic_write`) and only then does the commit run, so a kill mid-publish
/// leaves a usable, current version — never a torn library. A commit failure
/// (e.g. no git identity) is therefore NON-fatal — the version exists and is
/// current — and rides back as `{committed:false, commit_error}` at the
/// envelope `ok` level (D3), never an error envelope. `created_at` is supplied
/// by the TS layer (the install-slice seam — the bridge stays clock- and
/// date-crate-free), shape-validated here.
async fn cmd_publish(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let label = parse_version_label(args)?;
    let created_at = parse_created_at(args)?;
    let notes = parse_optional_notes(args);

    let meta = VersionMetadata { created_at, notes: notes.clone() };
    VersionStore::new(LibraryLayout::new(&root))
        .snapshot(kind, &name, &label, &meta)
        .map_err(map_core_error)?;

    let message = format_publish_commit_message(kind, &name, &label, notes.as_deref());
    let (committed, commit_error) = commit_change(&root, &message).await;
    Ok(json!({ "committed": committed, "commit_error": commit_error }))
}

/// Move `current.txt` to `label` — the pointer a FUTURE install reads — and
/// commit. `working/` is untouched (this is NOT a revert). Same non-fatal
/// commit posture as publish (D3): a commit failure rides back in the result.
async fn cmd_set_current_version(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let label = parse_version_label(args)?;

    VersionStore::new(LibraryLayout::new(&root))
        .set_current(kind, &name, &label)
        .map_err(map_core_error)?;

    let message = format!("current({}/{}): {}", kind.dir_name(), name.as_str(), label.as_str());
    let (committed, commit_error) = commit_change(&root, &message).await;
    Ok(json!({ "committed": committed, "commit_error": commit_error }))
}

/// Read a frozen version's primary file + `version.yaml` for the inspector.
/// Read-only — no commit, no working-copy mutation.
fn cmd_read_primitive_version(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let label = parse_version_label(args)?;
    let view = read_primitive_version_view(LibraryLayout::new(&root), kind, &name, &label)
        .map_err(map_core_error)?;
    serde_json::to_value(view).map_err(serialize_err)
}

/// Rewind `working/` to a frozen version (overwrite + delete orphans). A
/// LIBRARY-CONTENT op (D2), distinct from install-time version pinning: it does
/// NOT commit (`working/` is gitignored, so a commit would no-op) and touches
/// no install record. After a revert the working copy is dirty against
/// `current.txt` until the author re-publishes.
fn cmd_revert_to_version(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let label = parse_version_label(args)?;
    revert_primitive_to_version(LibraryLayout::new(&root), kind, &name, &label)
        .map_err(map_core_error)?;
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Target-overlay commands (target-overlays slice)
// ---------------------------------------------------------------------------

/// Read the MERGED primary file for a `(primitive, target)` pair — base ∪ the
/// target overlay (target shadows base per relative path) — plus `has_overlay`
/// (true iff a `working/targets/<target>/<primary>` file exists). Read-only.
/// REJECTS a target outside the primitive's `metadata.allowed_targets` in-core
/// (`library_target_not_allowed`, 422) — the UI must drive its overlay tabs
/// from `allowed_targets`, never the full `Target::ALL` enum, so it never asks
/// for a disallowed target.
fn cmd_read_primitive_target(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let target = parse_target(args)?;
    let view = read_primitive_for_target(LibraryLayout::new(&root), kind, &name, target)
        .map_err(map_core_error)?;
    serde_json::to_value(view).map_err(serialize_err)
}

/// Write the PRIMARY overlay file for `(kind, name, target)` — core parse-
/// validates the bytes for the kind BEFORE the atomic write, so malformed
/// content (`library_parse_error`) never reaches disk. The UI sends the whole
/// `---\nfm---\nbody` blob as `content`, exactly like `save_working`. Writes
/// only `working/targets/<target>/<primary>` — never base, never a commit.
fn cmd_write_overlay(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let target = parse_target(args)?;
    let content = parse_required_str(args, "content")?;
    WorkingCopy::new(LibraryLayout::new(&root))
        .save_primary_target(kind, &name, target, content.as_bytes())
        .map_err(map_core_error)?;
    Ok(json!({}))
}

/// Remove the PRIMARY overlay file for `(kind, name, target)`. Idempotent (core
/// no-ops on an absent file). After removal the target's merged view reverts to
/// the base passthrough (`has_overlay: false`).
fn cmd_remove_overlay(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let target = parse_target(args)?;
    WorkingCopy::new(LibraryLayout::new(&root))
        .remove_primary_target(kind, &name, target)
        .map_err(map_core_error)?;
    Ok(json!({}))
}

/// Enumerate every target overlay's files (one `{target, paths}` per target
/// that carries ≥1 overlay file; empty targets omitted, paths sorted). Lists
/// primary + any ref overlays that landed via publish/revert/import, but the
/// write/remove affordances are primary-only (the reference surface).
/// Read-only.
fn cmd_list_overlays(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let lists = list_overlays(LibraryLayout::new(&root), kind, &name).map_err(map_core_error)?;
    serde_json::to_value(lists).map_err(serialize_err)
}

// ---------------------------------------------------------------------------
// Metadata-editing command (metadata-editing slice)
// ---------------------------------------------------------------------------

/// Replace a primitive's editable metadata fields (`allowed_targets` /
/// `display_name` / `author`) and COMMIT. Core atomic-writes `metadata.yaml`
/// (preserving comments + `created_at` verbatim), then `commit_change` runs:
/// unlike the overlay writes (gitignored `working/`), `metadata.yaml` is git-
/// tracked, so this is commit-on-write like publish/set-current (Slice 4). The
/// commit is NON-fatal — the write already landed — and rides back as
/// `{committed, commit_error}` at the `ok` envelope level, never an error
/// envelope.
///
/// Dropping an `allowed_target` that still has overlay files is the one
/// destructive-adjacent path: with `discard_orphan_overlays` false (the safe
/// two-phase-confirm default, mirror of `force`) core refuses with
/// `library_target_removed_with_overlays` (mapped to 409) and disk is untouched;
/// the UI confirms, then re-issues with the flag set to delete the orphans.
async fn cmd_update_metadata(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let update = parse_metadata_update(args)?;

    let metadata = update_primitive_metadata(LibraryLayout::new(&root), kind, &name, update)
        .map_err(map_core_error)?;

    let message = format!("metadata({}/{})", kind.dir_name(), name.as_str());
    let (committed, commit_error) = commit_change(&root, &message).await;
    Ok(json!({ "metadata": metadata, "committed": committed, "commit_error": commit_error }))
}

// ---------------------------------------------------------------------------
// Reimport-from-drift command (reimport-from-drift slice)
// ---------------------------------------------------------------------------

/// Capture an installed copy's on-disk (drifted) bytes back into the library as
/// a new published version and re-baseline `installs.json` so the next drift
/// scan reads Clean. Reimport is the INVERSE of install: install deploys the
/// library to disk; reimport pulls disk back into the library.
///
/// The `ReimportResult` tagged union rides the `ok` envelope as DATA the UI
/// routes on (like `InstallSummary`), NOT as an error:
/// - `reimported` — snapshot wrote, `current.txt` advanced, the record
///   re-baselined. The new `versions/<label>/` tree is git-tracked, so this
///   arm — and ONLY this arm — COMMITS (non-fatal `{committed, commit_error}`,
///   publish posture). Reference DIVERGENCE: the standalone app never commits
///   reimport; the dashboard does so the version is not orphaned uncommitted.
/// - `working_copy_dirty` — `working/` has unpublished edits; the UI confirms,
///   then retries with `discard_working: true`.
/// - `broken_source` — the on-disk primary file won't parse; the UI offers a
///   fix sheet, then retries with `fixed_primary_text`.
/// - `not_installed` / `install_missing` — no record / the install path is gone.
///
/// `created_at` is the TS-supplied publish timestamp (the bridge owns no clock),
/// shape-validated like publish. `fixed_primary_text` is UTF-8 on the wire;
/// core wants `Vec<u8>`, so `.into_bytes()` is the bridge's job (a non-UTF-8
/// payload can't arrive via JSON, and core re-validates the fixed bytes).
async fn cmd_reimport(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let source_target = parse_target(args)?;
    let new_version = parse_version_label(args)?;
    let created_at = parse_created_at(args)?;
    let notes = parse_optional_notes(args);
    let discard_working = parse_discard_working(args);
    let fixed_primary_bytes = parse_fixed_primary_text(args).map(String::into_bytes);

    let result = reimport_install_as_version(ReimportRequest {
        layout: LibraryLayout::new(&root),
        install_paths: &install_paths,
        installs_file_path: &installs_file_path,
        kind,
        name: &name,
        source_target,
        new_version,
        created_at: &created_at,
        notes: notes.clone(),
        discard_working,
        fixed_primary_bytes,
    })
    .map_err(map_core_error)?;

    let mut value = serde_json::to_value(&result).map_err(serialize_err)?;
    // Commit ONLY on the `reimported` outcome: the other results wrote nothing
    // git-tracked, so committing them would be a no-op at best and misleading at
    // worst. The new version tree is what we commit (working/ is gitignored, so
    // `git add -A` only ever sweeps `versions/<label>/` + `current.txt`).
    if let ReimportResult::Reimported { new_version } = &result {
        let message = format_reimport_commit_message(kind, &name, new_version, notes.as_deref());
        let (committed, commit_error) = commit_change(&root, &message).await;
        if let Value::Object(map) = &mut value {
            map.insert("committed".into(), json!(committed));
            map.insert("commit_error".into(), json!(commit_error));
        }
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Primitive-lifecycle commands (lifecycle slice)
// ---------------------------------------------------------------------------

/// Scaffold a brand-new primitive — `metadata.yaml` + an empty primary file
/// under `working/base/` — then commit. `source: None`: a blank create; the
/// URL-seeded import flavor (`ScaffoldSource`) is Slice 10b (network-gated),
/// not here. `created_at` is the TS-supplied timestamp (the bridge owns no
/// clock; core writes it verbatim into `metadata.created_at`), shape-validated
/// like publish. A name collision surfaces as `library_primitive_exists` (409)
/// from `map_core_error`, NOT a torn write — `scaffold_primitive` checks the
/// dir up front. Same non-fatal commit-on-write posture as publish (D1/D3): a
/// commit failure rides back as `{committed, commit_error}` at the `ok` level,
/// never an error envelope — the scaffold already landed.
async fn cmd_create_primitive(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let created_at = parse_created_at(args)?;

    scaffold_primitive(LibraryLayout::new(&root), kind, &name, &created_at, None)
        .map_err(map_core_error)?;

    let message = format!("create({}/{})", kind.dir_name(), name.as_str());
    let (committed, commit_error) = commit_change(&root, &message).await;
    Ok(json!({ "committed": committed, "commit_error": commit_error }))
}

/// Wipe `(kind, name)` from the library: force-uninstall every recorded target,
/// `rm -rf` the library dir, then drop install records. The
/// `DeletePrimitiveSummary` (`{uninstall, library_dir_removed}`) rides the `ok`
/// envelope as DATA the UI inspects (per-target uninstall outcomes), NOT an
/// error. If any per-target uninstall FAILED, core bails BEFORE the `rm -rf`
/// (the library tree is untouched) and returns `library_dir_removed: false` —
/// so the bridge must NOT commit (nothing changed). It commits ONLY when the
/// directory was actually removed; `committed/commit_error` are always present
/// so the TS parser need not branch. `force` is implicit (delete always forces;
/// the user consented to drift loss by confirming the destructive action).
async fn cmd_delete_primitive(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;

    let summary = delete_primitive(DeletePrimitiveRequest {
        layout: LibraryLayout::new(&root),
        install_paths: &install_paths,
        installs_file_path: &installs_file_path,
        kind,
        name: &name,
    })
    .map_err(map_core_error)?;

    let (committed, commit_error) = if summary.library_dir_removed {
        let message = format!("delete({}/{})", kind.dir_name(), name.as_str());
        commit_change(&root, &message).await
    } else {
        (false, None)
    };
    let mut value = serde_json::to_value(&summary).map_err(serialize_err)?;
    insert_commit_fields(&mut value, committed, commit_error);
    Ok(value)
}

/// `fs::rename` the library dir to `new_name`, then rewrite every
/// `installs.json` record's `name`, and commit. The `RenamePrimitiveSummary`'s
/// `install_records_updated` count rides back so the UI can render the
/// "N installed copies keep the old name until reinstalled" caveat. A missing
/// source → `primitive_not_found` (404); a `new_name` collision →
/// `library_primitive_exists` (409). Both `name`s are validated at the wire
/// (`parse_name`/`parse_new_name`) so a traversal payload is rejected before
/// any path join. `home` is required-but-unused (the route injects it
/// uniformly via `install_context`; only `installs_path` is consumed).
async fn cmd_rename_primitive(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (_install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let old_name = parse_name(args)?;
    let new_name = parse_new_name(args)?;

    let summary = rename_primitive(RenamePrimitiveRequest {
        layout: LibraryLayout::new(&root),
        installs_file_path: &installs_file_path,
        kind,
        old_name: &old_name,
        new_name: &new_name,
    })
    .map_err(map_core_error)?;

    let message = format!(
        "rename({}/{} -> {})",
        kind.dir_name(),
        old_name.as_str(),
        new_name.as_str()
    );
    let (committed, commit_error) = commit_change(&root, &message).await;
    let mut value = serde_json::to_value(&summary).map_err(serialize_err)?;
    insert_commit_fields(&mut value, committed, commit_error);
    Ok(value)
}

/// Copy `working/` + a freshly-stamped `metadata.yaml` to `new_name`, then
/// commit. Versions and install records are NOT carried (the duplicate starts
/// at "no published version, not installed"). `created_at` stamps the new
/// `metadata.created_at` (TS-supplied, shape-validated). No `install_context`:
/// duplicate touches no `installs.json`. A missing source → 404; a `new_name`
/// collision → 409.
async fn cmd_duplicate_primitive(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let kind = parse_kind(args)?;
    let source_name = parse_name(args)?;
    let new_name = parse_new_name(args)?;
    let created_at = parse_created_at(args)?;

    let summary = duplicate_primitive(DuplicatePrimitiveRequest {
        layout: LibraryLayout::new(&root),
        kind,
        source_name: &source_name,
        new_name: &new_name,
        now_rfc3339: &created_at,
    })
    .map_err(map_core_error)?;

    let message = format!(
        "duplicate({}/{} -> {})",
        kind.dir_name(),
        source_name.as_str(),
        new_name.as_str()
    );
    let (committed, commit_error) = commit_change(&root, &message).await;
    let mut value = serde_json::to_value(&summary).map_err(serialize_err)?;
    insert_commit_fields(&mut value, committed, commit_error);
    Ok(value)
}

/// Import a primitive from a `source_path` that already lives under a
/// recognized install root (`SCAN_MATRIX`) — the reference's drag-drop fast
/// path, NOT URL import (Slice 10b). `home` comes from `install_context` (the
/// route injects it from config, never the body — the containment boundary);
/// `classify_path` only matches paths under `home`'s install roots, so a path
/// outside returns `NotClassifiable` and traversal cannot redirect a write (the
/// scaffold dest is `(kind, name)`-derived in-core). The tagged
/// `ImportFromPathResult` rides the `ok` envelope as DATA the UI routes on
/// (`Imported`/`AlreadyExists`/`NotClassifiable`), like `InstallSummary`. Only
/// `Imported` wrote a git-tracked tree, so ONLY that arm commits (publish
/// posture); the commit subject is `import(<filename>)`, ported from the
/// reference.
async fn cmd_import_primitive_from_path(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (install_paths, installs_file_path) = install_context(args)?;
    let source_path = parse_required_str(args, "source_path")?;
    let created_at = parse_created_at(args)?;

    let source = Utf8Path::new(&source_path);
    let result = import_primitive_from_path(
        LibraryLayout::new(&root),
        install_paths.home(),
        &installs_file_path,
        source,
        &created_at,
    )
    .map_err(map_core_error)?;

    let mut value = serde_json::to_value(&result).map_err(serialize_err)?;
    if let ImportFromPathResult::Imported { .. } = &result {
        let message = format!("import({})", source.file_name().unwrap_or(""));
        let (committed, commit_error) = commit_change(&root, &message).await;
        insert_commit_fields(&mut value, committed, commit_error);
    }
    Ok(value)
}

/// Drop every `installs.json` record for `(kind, name)` — the Reconcile
/// dialog's "mark removed" action for a primitive whose library dir is already
/// gone. Touches ONLY the dashboard-owned `installs.json` (gitignored / outside
/// the library repo), so there is NO commit and NO library-root resolution —
/// exactly the uninstall posture. Idempotent: `{removed: false}` when no record
/// matched. `home` is required-but-unused (uniform `install_context` injection).
fn cmd_forget_primitive(args: &Value) -> Result<Value, LibraryError> {
    let (_install_paths, installs_file_path) = install_context(args)?;
    let kind = parse_kind(args)?;
    let name = parse_name(args)?;
    let removed = forget_primitive(&installs_file_path, kind, &name).map_err(map_core_error)?;
    Ok(json!({ "removed": removed }))
}

// ---------------------------------------------------------------------------
// Bootstrap-discovery commands (bootstrap slice)
// ---------------------------------------------------------------------------

/// Scan the user's install roots (`~/.claude`, `~/.pi`, `~/.codex`), dedupe,
/// and cross-reference each candidate against the library — then run the pure
/// `derive_plan` and return BOTH the full `CrossReferenced` (for the review
/// UI's already-imported / needs-review / symlinked / unclassified rows) and
/// the executable `BootstrapPlan` (the New→create + Drifted→reimport subset) in
/// one envelope. Read-only: std::fs only, no commit, no ledger mutation. The
/// Tauri progress `Channel` is dropped — `bootstrap_scan` emits 3 fixed coarse
/// stages + Done over a sub-second walk with no web event channel and no payoff,
/// so a no-op `on_progress` (exactly as core's own tests pass) is correct; the
/// UI renders the known stage labels client-side.
fn cmd_bootstrap_scan(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let home = parse_home(args)?;
    let cr = bootstrap_scan(&home, LibraryLayout::new(&root), |_| {}).map_err(map_core_error)?;
    // Serialize the full classification BEFORE `derive_plan` consumes `cr`.
    let cross_referenced = serde_json::to_value(&cr).map_err(serialize_err)?;
    let plan = serde_json::to_value(derive_plan(cr)).map_err(serialize_err)?;
    Ok(json!({ "cross_referenced": cross_referenced, "plan": plan }))
}

/// Execute a bootstrap plan: write each New primitive at v1, reimport each
/// Drifted one as vN+1, after a one-time source-dir tarball backup, with a
/// per-item resumable session checkpoint. The `plan` is the (frontend-filtered)
/// executable subset; `resume` re-drives a prior partial run's session (skipping
/// already-completed items and the backup); `excluded_ids` are persisted into
/// the session for the wizard's resume-display (core does NOT filter execution
/// by them — exclusion is the frontend pre-filtering `plan`). The bridge owns no
/// clock: `created_at` is the TS-supplied RFC3339 timestamp (shape-validated).
/// core uses ONE `timestamp` for BOTH the backup-tarball filename AND the
/// `created_at` it writes into new metadata/version trees, so — like the
/// reference's `now_rfc3339_filesafe` — we sanitize `:`→`-` for filename safety;
/// that single string is what core records. Partial outcomes (`skipped_items`)
/// ride the `ok` envelope as DATA, never an error. Commits ONLY when
/// `created + reimported > 0` (gating divergence from the always-committing
/// reference), folding `{committed, commit_error}` on per the publish posture.
async fn cmd_bootstrap_execute(args: &Value) -> Result<Value, LibraryError> {
    let root = require_library(args)?;
    let (install_paths, installs_file_path) = install_context(args)?;
    let session_path = parse_session_path(args)?;
    let backup_dir = parse_backup_dir(args)?;
    let plan = parse_bootstrap_plan(args)?;
    let resume = parse_bootstrap_resume(args)?;
    let excluded_ids = parse_excluded_ids(args)?;
    let created_at = parse_created_at(args)?;
    let timestamp = created_at.replace(':', "-");

    let summary = bootstrap_execute(BootstrapExecuteRequest {
        plan: &plan,
        layout: LibraryLayout::new(&root),
        install_paths: &install_paths,
        installs_file: &installs_file_path,
        session_path: &session_path,
        backup_dir: &backup_dir,
        home: install_paths.home(),
        timestamp: &timestamp,
        resume,
        excluded_ids,
    })
    .map_err(map_core_error)?;

    let mut value = serde_json::to_value(&summary).map_err(serialize_err)?;
    if summary.created + summary.reimported > 0 {
        let message = format!(
            "bootstrap: created {}, reimported {}",
            summary.created, summary.reimported
        );
        let (committed, commit_error) = commit_change(&root, &message).await;
        insert_commit_fields(&mut value, committed, commit_error);
    }
    Ok(value)
}

/// Load the dashboard-owned bootstrap session (the resume checkpoint). Returns
/// `{session: null}` when absent (a 200 `null`, never a 404 — an absent session
/// is the normal first-run state). Read-only, no commit.
fn cmd_read_bootstrap_session(args: &Value) -> Result<Value, LibraryError> {
    let session_path = parse_session_path(args)?;
    let session = BootstrapSession::load(&session_path).map_err(map_core_error)?;
    Ok(json!({ "session": session }))
}

/// Remove the bootstrap session file — the wizard's "Discard / start over"
/// action. Idempotent (no-op when absent). Touches only the dashboard-owned
/// session file, so no commit and no library-root resolution.
fn cmd_clear_bootstrap_session(args: &Value) -> Result<Value, LibraryError> {
    let session_path = parse_session_path(args)?;
    BootstrapSession::clear(&session_path).map_err(map_core_error)?;
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Insert the non-fatal `(committed, commit_error)` pair into a serialized
/// result object as siblings (the reimport/publish commit-on-write shape). A
/// no-op if `value` is not a JSON object (it always is for these commands).
fn insert_commit_fields(value: &mut Value, committed: bool, commit_error: Option<String>) {
    if let Value::Object(map) = value {
        map.insert("committed".into(), json!(committed));
        map.insert("commit_error".into(), json!(commit_error));
    }
}

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

/// Bind the SECOND untrusted name a lifecycle verb carries — rename's and
/// duplicate's `new_name` — through the same validating constructor as
/// `parse_name`. `try_new` rejects traversal payloads (`..`, `/`, `\`, leading
/// dots), so a bad target name becomes `library_invalid_name` (422), never a
/// path join. It reads its own `new_name` key so rename/duplicate can carry the
/// source `name` and the target `new_name` without overloading one key.
fn parse_new_name(args: &Value) -> Result<PrimitiveName, LibraryError> {
    let raw = args.get("new_name").and_then(Value::as_str).unwrap_or("");
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

/// Resolve the install-destination `home` alone (bootstrap_scan needs it but no
/// `installs.json`). Route-injected from server config like `install_context`'s
/// `home` — missing/empty is a config fault (`installs_unconfigured`), not a
/// user error, and never read from an HTTP body (D7).
fn parse_home(args: &Value) -> Result<Utf8PathBuf, LibraryError> {
    let home = args.get("home").and_then(Value::as_str).unwrap_or("");
    if home.is_empty() {
        return Err(LibraryError::new(
            "installs_unconfigured",
            "no install home configured",
            "request args.home was missing or empty",
        ));
    }
    Ok(Utf8PathBuf::from(home))
}

/// Resolve the dashboard-owned bootstrap session path. Route-injected from
/// server config (`CC_LIBRARY_BOOTSTRAP_SESSION_PATH`, default
/// `DATA_DIR/bootstrap-session.json`); NEVER from an HTTP body (D7). Missing/
/// empty is a config fault, not a user error.
fn parse_session_path(args: &Value) -> Result<Utf8PathBuf, LibraryError> {
    let raw = args.get("session_path").and_then(Value::as_str).unwrap_or("");
    if raw.is_empty() {
        return Err(LibraryError::new(
            "bootstrap_unconfigured",
            "no bootstrap session path configured",
            "request args.session_path was missing or empty",
        ));
    }
    Ok(Utf8PathBuf::from(raw))
}

/// Resolve the dashboard-owned bootstrap backup directory. Route-injected from
/// server config (`CC_LIBRARY_BACKUP_DIR`, default `DATA_DIR/backups`); NEVER
/// from an HTTP body (D7). Missing/empty is a config fault, not a user error.
fn parse_backup_dir(args: &Value) -> Result<Utf8PathBuf, LibraryError> {
    let raw = args.get("backup_dir").and_then(Value::as_str).unwrap_or("");
    if raw.is_empty() {
        return Err(LibraryError::new(
            "bootstrap_unconfigured",
            "no bootstrap backup dir configured",
            "request args.backup_dir was missing or empty",
        ));
    }
    Ok(Utf8PathBuf::from(raw))
}

/// Deserialize the executable `BootstrapPlan` the wizard sends back from the
/// scan (round-tripped untouched, then pre-filtered to the user's checked
/// actions). A missing/malformed plan is a `bridge_bad_request` (the caller's
/// bug), never a torn write — core only ever sees a well-formed plan.
fn parse_bootstrap_plan(args: &Value) -> Result<BootstrapPlan, LibraryError> {
    let raw = args.get("plan").cloned().unwrap_or(Value::Null);
    serde_json::from_value(raw).map_err(|e| {
        LibraryError::new(
            "bridge_bad_request",
            "missing or malformed bootstrap plan",
            format!("args.plan did not deserialize into a BootstrapPlan: {e}"),
        )
    })
}

/// Deserialize an optional resume `BootstrapSession` (the prior partial run's
/// checkpoint, round-tripped untouched). Absent/null → `None` (a fresh run).
fn parse_bootstrap_resume(args: &Value) -> Result<Option<BootstrapSession>, LibraryError> {
    match args.get("resume") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| {
            LibraryError::new(
                "bridge_bad_request",
                "malformed bootstrap resume session",
                format!("args.resume did not deserialize into a BootstrapSession: {e}"),
            )
        }),
    }
}

/// The action ids the user unchecked in review. Persisted into the session for
/// resume-display only — core does NOT filter execution by them (the executable
/// exclusion is the frontend pre-filtering `plan`). Absent/null → empty.
fn parse_excluded_ids(args: &Value) -> Result<Vec<String>, LibraryError> {
    match args.get("excluded_ids") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| {
            LibraryError::new(
                "bridge_bad_request",
                "malformed excluded_ids",
                format!("args.excluded_ids must be an array of strings: {e}"),
            )
        }),
    }
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

/// Assemble a `MetadataUpdate` from request args (the metadata-editing slice).
/// `allowed_targets` reads its OWN wire key (not the install verb's `targets`),
/// keeping the two verbs' contracts from overloading one key. `display_name`
/// and `author` are optional free-text where absent/`null`/empty-string all
/// mean "clear" (→ `None`) so the field drops from the YAML. The kind-vs-target
/// legality check stays in core (`TargetNotAllowedForKind`); this only shapes
/// the wire input.
fn parse_metadata_update(args: &Value) -> Result<MetadataUpdate, LibraryError> {
    Ok(MetadataUpdate {
        allowed_targets: parse_allowed_targets(args)?,
        display_name: parse_optional_nonempty(args, "display_name"),
        author: parse_optional_nonempty(args, "author"),
        discard_orphan_overlays: args
            .get("discard_orphan_overlays")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Parse the `allowed_targets` enum array — the metadata-editing analogue of
/// `parse_targets`, reading its own `allowed_targets` key (O2). A malformed or
/// unknown target is a typed error, never a silent drop.
fn parse_allowed_targets(args: &Value) -> Result<Vec<Target>, LibraryError> {
    let raw = args.get("allowed_targets").cloned().unwrap_or(Value::Null);
    serde_json::from_value::<Vec<Target>>(raw).map_err(|e| {
        LibraryError::new(
            "library_invalid_target",
            "unknown or malformed allowed target",
            format!("allowed_targets must be an array of claude|pi|codex: {e}"),
        )
    })
}

/// An optional free-text metadata field (`display_name`/`author`): an absent
/// key, an explicit JSON `null`, an empty string, and a whitespace-only string
/// ALL mean "clear" (→ `None`); only a present non-blank string becomes `Some`
/// (stored verbatim, untrimmed). The bridge collapses `""`/`null` here so core
/// never stores `Some("")`, which would render as a blank field instead of the
/// read view's `—` default.
fn parse_optional_nonempty(args: &Value, key: &str) -> Option<String> {
    match args.get(key).and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => Some(s.to_string()),
        _ => None,
    }
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

/// Pull a REQUIRED string argument (`path`/`old_path`/`new_path`/`content`) for
/// the working-file commands. A missing or non-string value is a caller bug →
/// `bridge_bad_request`. An empty string IS allowed through (e.g. saving an
/// empty ref file) — the working-file *path* arguments are then validated by
/// core's `validate_path_shape`/`validate_ref_path`, never here: the bridge must
/// not duplicate or weaken core's single-source-of-truth containment boundary.
fn parse_required_str(args: &Value, key: &'static str) -> Result<String, LibraryError> {
    match args.get(key).and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => Err(LibraryError::new(
            "bridge_bad_request",
            "missing or malformed string argument",
            format!("request args.{key} was missing or not a string"),
        )),
    }
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

/// Bind the untrusted `version_label` through `VersionLabel::try_new`, which
/// enforces the `v<digits>[-suffix]` shape — a bad label becomes
/// `library_invalid_version` (422) before any version dir is touched. Shared by
/// publish/set-current/inspect/revert.
fn parse_version_label(args: &Value) -> Result<VersionLabel, LibraryError> {
    let raw = args.get("version_label").and_then(Value::as_str).unwrap_or("");
    VersionLabel::try_new(raw).map_err(map_core_error)
}

/// Validate the caller-supplied `created_at` publish timestamp. Same posture and
/// shape check as `parse_installed_at`: the TS layer sends
/// `new Date().toISOString()`; the bridge owns no clock and pulls in no date
/// crate (core stores `created_at` verbatim, doing ZERO validation itself).
fn parse_created_at(args: &Value) -> Result<String, LibraryError> {
    let raw = args.get("created_at").and_then(Value::as_str).unwrap_or("");
    if !looks_like_rfc3339(raw) {
        return Err(LibraryError::new(
            "bridge_bad_request",
            "missing or malformed publish timestamp",
            format!("created_at `{raw}` is not an RFC3339 UTC timestamp"),
        ));
    }
    Ok(raw.to_string())
}

/// `notes` is optional release-note text. Absent/null/non-string → `None`
/// (notes are advisory). It travels in the JSON body, never argv, so newlines
/// and special chars round-trip cleanly into the commit message body.
fn parse_optional_notes(args: &Value) -> Option<String> {
    args.get("notes").and_then(Value::as_str).map(str::to_string)
}

/// Reimport's `discard_working` flag. Defaults to `false` — the two-phase-confirm
/// safe default (mirror of `parse_force`): with it false, reimport HARD-BLOCKS
/// (`working_copy_dirty`) when `working/` has unpublished edits, and the UI
/// re-issues with `true` only after the user confirms the discard.
fn parse_discard_working(args: &Value) -> bool {
    args.get("discard_working").and_then(Value::as_bool).unwrap_or(false)
}

/// Reimport's broken-source retry payload: the bytes the user manually fixed in
/// the UI's temp buffer when the on-disk primary file's frontmatter/TOML didn't
/// parse. Absent/null/non-string → `None` (the normal first-attempt path). Like
/// `notes` it rides the JSON body, never argv, so a multi-line corrected file
/// round-trips intact; the caller `.into_bytes()`es it for core (which
/// re-validates the fixed bytes itself).
fn parse_fixed_primary_text(args: &Value) -> Option<String> {
    args.get("fixed_primary_text").and_then(Value::as_str).map(str::to_string)
}

/// Stage and commit every tracked change with `message`, returning a non-fatal
/// `(committed, commit_error)` rather than erroring (D1/D3). The library
/// `.gitignore` excludes `*/working/`, so `git add -A` only ever commits the
/// new `versions/<label>/` tree + `current.txt`, never working-copy autosave.
///
/// - `.git/` absent → `(false, None)`: a non-git library; the snapshot still
///   succeeded (matches the reference's silent skip).
/// - commit succeeds → `(true, None)`.
/// - nothing staged (`git_commit` → `Ok(false)`) → `(false, None)`: e.g.
///   re-publishing identical bytes. Not an error.
/// - `git add`/`git commit` fails (e.g. no `user.email`) → `(false, Some(msg))`
///   with git's stderr as the legible remediation. That stderr is git's own
///   identity message, not a library path, so forwarding it preserves the m4
///   path-discipline (the bridge never interpolates a fs path into a client
///   message).
async fn commit_change(repo: &Utf8Path, message: &str) -> (bool, Option<String>) {
    if !repo.join(".git").exists() {
        return (false, None);
    }
    let runner = TokioProcessRunner::new();
    let repo_std = repo.as_std_path();
    if let Err(e) = git_add_all(&runner, repo_std).await {
        return (false, Some(runner_error_message(&e)));
    }
    match git_commit(&runner, repo_std, message).await {
        Ok(true) => (true, None),
        Ok(false) => (false, None),
        Err(e) => (false, Some(runner_error_message(&e))),
    }
}

/// The user-facing message for a git `RunnerError`: the `Failed` variant's
/// stderr (git's own remediation text — path-free for the identity case), else
/// the Display. This is the only git output a client ever sees.
fn runner_error_message(e: &RunnerError) -> String {
    match e {
        RunnerError::Failed { stderr, .. } if !stderr.trim().is_empty() => {
            stderr.trim().to_string()
        }
        other => other.to_string(),
    }
}

/// `publish(<dir>/<name>): <label>` subject + an optional notes body (verbatim,
/// stdin-delivered so newlines round-trip). Ported from the reference's
/// `format_publish_commit_message`.
fn format_publish_commit_message(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    label: &VersionLabel,
    notes: Option<&str>,
) -> String {
    let subject = format!("publish({}/{}): {}", kind.dir_name(), name.as_str(), label.as_str());
    match notes.map(str::trim).filter(|s| !s.is_empty()) {
        Some(body) => format!("{subject}\n\n{body}\n"),
        None => format!("{subject}\n"),
    }
}

/// `reimport(<dir>/<name>): <label>` subject + an optional notes body — the
/// reimport analogue of `format_publish_commit_message`. The `reimport(...)`
/// subject (vs. `publish(...)`) keeps the git log honest about how the version
/// was cut: from drifted on-disk bytes, not the editor.
fn format_reimport_commit_message(
    kind: PrimitiveKind,
    name: &PrimitiveName,
    label: &VersionLabel,
    notes: Option<&str>,
) -> String {
    let subject = format!("reimport({}/{}): {}", kind.dir_name(), name.as_str(), label.as_str());
    match notes.map(str::trim).filter(|s| !s.is_empty()) {
        Some(body) => format!("{subject}\n\n{body}\n"),
        None => format!("{subject}\n"),
    }
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

// ---------------------------------------------------------------------------
// Git remote sync (Slice 8, Phase 1) — configure / PAT / status
// ---------------------------------------------------------------------------

/// Validate the remote URL and RETURN its normalized form. Persistence is the
/// TS route's job (`config/library.yaml`), not the bridge's — the bridge owns no
/// config file (it stays config-file-free the same way it stays clock-free).
/// A deliberate divergence from the reference's `state.set_remote_url` (D1).
/// No secrets, no network.
fn cmd_configure_remote(args: &Value) -> Result<Value, LibraryError> {
    let raw = args.get("url").and_then(Value::as_str).unwrap_or("");
    let normalized = validate_remote_url(raw).map_err(map_remote_url_error)?;
    Ok(json!({ "remote_url": normalized }))
}

/// Store the PAT in the injected `SecretStore`. Rejects an empty token
/// (`empty_pat`); otherwise the token is opaque (never parsed, never logged).
fn cmd_set_pat(args: &Value, store: &dyn SecretStore) -> Result<Value, LibraryError> {
    let pat = args.get("pat").and_then(Value::as_str).unwrap_or("");
    if pat.is_empty() {
        return Err(LibraryError::new(
            "empty_pat",
            "personal access token must not be empty",
            "request args.pat was missing or empty",
        ));
    }
    store.set_pat(pat).map_err(map_secret_error)?;
    Ok(json!({}))
}

/// Remove the stored PAT, if any. Idempotent (deleting an absent token is ok).
fn cmd_delete_pat(store: &dyn SecretStore) -> Result<Value, LibraryError> {
    store.delete_pat().map_err(map_secret_error)?;
    Ok(json!({}))
}

/// Snapshot of the remote URL + REDACTED PAT for the settings UI. `remote_url`
/// is a passthrough of the TS-injected arg (the bridge never persists/reads it);
/// the PAT is read from the store and immediately redacted — `redact_pat` is the
/// ONLY form that ever crosses the wire (D6). A null PAT reports null.
fn cmd_get_remote_status(args: &Value, store: &dyn SecretStore) -> Result<Value, LibraryError> {
    let remote_url = args.get("remote_url").cloned().unwrap_or(Value::Null);
    let pat_redacted = store
        .get_pat()
        .map_err(map_secret_error)?
        .as_deref()
        .map(redact_pat);
    Ok(json!({ "remote_url": remote_url, "pat_redacted": pat_redacted }))
}

/// Construct the PAT secret store for a git-sync command. Real `KeychainStore`
/// by default (verified headless across one-shot processes in Phase 0); an
/// `InMemoryStore` for tests (see `use_memory_store`). This is the ONLY
/// constructor of a `SecretStore` in the bridge — called only by the four arms
/// above (and the Phase-2 push/pull family), keeping every other command path
/// secrets-free.
fn secret_store(args: &Value) -> Result<Box<dyn SecretStore>, LibraryError> {
    if use_memory_store(args) {
        return Ok(Box::new(InMemoryStore::new()));
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(KeychainStore::new()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(LibraryError::new(
            "secret_store_unavailable",
            "no secret store available on this platform",
            "KeychainStore is macOS-only; set CC_LIBRARY_SECRET_STORE=memory for tests",
        ))
    }
}

/// Whether to use the test-only in-memory secret store instead of the keychain.
///
/// Two switches, deliberately asymmetric (security review, Slice 8 Phase 2):
/// - **`CC_LIBRARY_SECRET_STORE=memory` (env):** honored in ANY build. Flipping
///   it requires control of the server process environment, which is already
///   out of the threat model.
/// - **`secret_store: "memory"` (arg):** honored ONLY in `#[cfg(test)]` builds.
///   A production bridge can therefore NEVER be downgraded off the keychain by
///   request data — defense-in-depth even if a future route mistakenly forwarded
///   `secret_store` from an HTTP body (it MUST NOT; like `home`/`installs_path`/
///   `askpass_dir` this is route-controlled-only, D7).
fn use_memory_store(args: &Value) -> bool {
    if std::env::var("CC_LIBRARY_SECRET_STORE").as_deref() == Ok("memory") {
        return true;
    }
    #[cfg(test)]
    if args.get("secret_store").and_then(Value::as_str) == Some("memory") {
        return true;
    }
    #[cfg(not(test))]
    let _ = args; // arg switch is test-only; silence unused in production builds
    false
}

/// `RemoteUrlError` → the one route-mappable code (D7: `invalid_remote_url`→422).
/// The specific reason (non-https, embedded creds, bad host, …) rides `detail`,
/// which the route logs but never forwards (m4). The Display is URL-shaped, never
/// secret-bearing (the PAT travels via askpass, never in the URL).
fn map_remote_url_error(e: RemoteUrlError) -> LibraryError {
    LibraryError::new("invalid_remote_url", "invalid remote URL", e.to_string())
}

/// `SecretError` → `secret_store_error` (D7: 502). The keychain message is an OS
/// diagnostic (and PAT-free — `SecretError::Keychain` carries an OS status or a
/// UTF-8 error, never the token bytes), but it still rides `detail` only.
fn map_secret_error(e: SecretError) -> LibraryError {
    LibraryError::new(
        "secret_store_error",
        "secret store operation failed",
        e.to_string(),
    )
}

// ---------------------------------------------------------------------------
// Git remote sync (Slice 8, Phase 2) — scan / push / pull / conflict family
// ---------------------------------------------------------------------------

/// Run the secret-scan gate against the changes the next push would publish.
/// Returns every finding; the UI decides whether to proceed (D4 — the gate
/// BLOCKS, never auto-bypasses; `push_now` does NOT re-run it). Range mirrors
/// the reference: `origin/<branch>..HEAD` if the upstream exists, else
/// `<empty-tree>..HEAD` so nothing slips through unexamined on a first push.
/// Reads refs only — no secrets, no egress.
async fn cmd_scan_before_push(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let repo_std = repo.as_std_path();
    let runner = TokioProcessRunner::new();
    let range = push_range(&runner, repo_std).await?;
    let findings = scan_pending_push(&runner, repo_std, &range)
        .await
        .map_err(map_runner_error)?;
    let dtos: Vec<Value> = findings.into_iter().map(file_finding_json).collect();
    Ok(json!({ "findings": dtos }))
}

/// Count commits on the current branch not yet pushed to `origin/<branch>` —
/// the "Push N" badge. `0` when the library isn't a git repo yet (the only safe
/// answer with nothing to compare against). No secrets, no egress.
async fn cmd_count_unpushed_commits(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let repo_std = repo.as_std_path();
    if !repo.join(".git").exists() {
        return Ok(json!({ "count": 0 }));
    }
    let runner = TokioProcessRunner::new();
    let range = push_range(&runner, repo_std).await?;
    let output = runner
        .run(&["rev-list", "--count", &range], repo_std, &[])
        .await
        .map_err(map_runner_error)?;
    if output.status != 0 {
        return Err(LibraryError::new(
            "git_failed",
            "git command failed",
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout.trim().parse::<u32>().map_err(|e| {
        LibraryError::new(
            "git_failed",
            "git command failed",
            format!("rev-list --count returned non-integer {stdout:?}: {e}"),
        )
    })?;
    Ok(json!({ "count": count }))
}

/// Push the current branch to `origin`. First push uses `-u origin <branch>`;
/// subsequent pushes plain `git push`. The secret-scan gate is intentionally NOT
/// folded in (the UI runs `scan_before_push` first — D4). The PAT flows
/// store→env→askpass→git child, NEVER argv/log/return (D6). NETWORK EGRESS.
async fn cmd_push_now(args: &Value, store: &dyn SecretStore) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let repo_std = repo.as_std_path();
    let pat = require_pat(store)?;
    let askpass = init_askpass_script(parse_askpass_dir(args)?.as_std_path())
        .map_err(map_askpass_error)?;
    let runner = TokioProcessRunner::new();
    let branch = current_branch(&runner, repo_std)
        .await
        .map_err(map_runner_error)?;
    let exists = remote_branch_exists(&runner, repo_std, &branch)
        .await
        .map_err(map_runner_error)?;
    if exists {
        git_push(&runner, repo_std, askpass.as_path(), &pat)
            .await
            .map_err(map_runner_error)?;
    } else {
        git_push_with_upstream(&runner, repo_std, askpass.as_path(), &pat, &branch)
            .await
            .map_err(map_runner_error)?;
    }
    Ok(json!({}))
}

/// `git pull --rebase` (PAT via askpass, NETWORK EGRESS). On a rebase conflict
/// the failure is reshaped into a routable `{outcome:"conflict", conflict_count}`
/// that rides the OK envelope as data (D7) — the UI renders the resolve banner.
/// A timeout → `git_timed_out`; any other failure → `git_failed`.
async fn cmd_pull_now(args: &Value, store: &dyn SecretStore) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let repo_std = repo.as_std_path();
    let pat = require_pat(store)?;
    let askpass = init_askpass_script(parse_askpass_dir(args)?.as_std_path())
        .map_err(map_askpass_error)?;
    let runner = TokioProcessRunner::new();
    let result = git_pull(&runner, repo_std, askpass.as_path(), &pat, PULL_TIMEOUT).await;
    match result {
        Ok(()) => Ok(json!({ "outcome": "ok" })),
        // Conflict detection is only meaningful on `Failed` — `TimedOut`/`Spawn`
        // never leave a rebase mid-flight.
        Err(err) if matches!(err, RunnerError::Failed { .. }) && is_rebase_in_progress(repo_std) => {
            let paths = list_unmerged_paths(&runner, repo_std)
                .await
                .map_err(map_runner_error)?;
            Ok(json!({ "outcome": "conflict", "conflict_count": paths.len() as u32 }))
        }
        Err(err) => Err(map_runner_error(err)),
    }
}

/// Whether the library has a rebase in progress — a cheap `.git/rebase-*` check
/// (the conflict banner gate). Sync, no git child, no secrets.
fn cmd_is_pull_paused(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    Ok(json!({ "paused": is_rebase_in_progress(repo.as_std_path()) }))
}

/// List every unmerged path from the in-progress rebase, classified for the
/// resolver UI. Empty when no rebase is active. No secrets, no egress.
async fn cmd_list_pull_conflicts(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let runner = TokioProcessRunner::new();
    let paths = list_unmerged_paths(&runner, repo.as_std_path())
        .await
        .map_err(map_runner_error)?;
    let conflicts: Vec<Value> = paths
        .into_iter()
        .map(|p| {
            let path = p.to_string_lossy().into_owned();
            let kind = classify_conflict_path(&path);
            json!({ "path": path, "kind": kind })
        })
        .collect();
    Ok(json!({ "conflicts": conflicts }))
}

/// Read the bytes of `conflict_path` at the requested side, decoded as UTF-8.
/// `content` is null if the side has no index entry (e.g. one side deleted the
/// file); a non-UTF-8 blob → `conflict_blob_not_utf8` (the resolver renders text
/// only). `Side::Local` reads the user's change (stage 3 during a rebase),
/// `Side::Remote` the incoming change (stage 2) — the `--ours`/`--theirs` swap
/// is hidden in-crate, so the UI only ever sees Local/Remote. No egress.
async fn cmd_read_conflict_blob(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let path = parse_conflict_path(args)?;
    let side = parse_conflict_side(args)?;
    let runner = TokioProcessRunner::new();
    let bytes = read_conflict_side(&runner, repo.as_std_path(), std::path::Path::new(&path), side)
        .await
        .map_err(map_runner_error)?;
    let content = match bytes {
        None => Value::Null,
        Some(b) => Value::String(String::from_utf8(b).map_err(|e| {
            LibraryError::new(
                "conflict_blob_not_utf8",
                "conflict blob is not valid UTF-8",
                e.to_string(),
            )
        })?),
    };
    Ok(json!({ "content": content }))
}

/// Resolve a conflict by writing the chosen side to the working tree + staging
/// it (`git checkout <side> -- <path>` then `git add`). git scopes the path to
/// the index/worktree, so a `../` path can't escape the repo. No egress.
async fn cmd_resolve_conflict(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let path = parse_conflict_path(args)?;
    let side = parse_conflict_side(args)?;
    let runner = TokioProcessRunner::new();
    resolve_with_side(&runner, repo.as_std_path(), std::path::Path::new(&path), side)
        .await
        .map_err(map_runner_error)?;
    Ok(json!({}))
}

/// `git rebase --continue` (editor suppressed). `{outcome:"done"}` when the
/// rebase finishes, or `{outcome:"still_conflicted", conflict_count}` when the
/// next replayed commit collides afresh (the resolver loops). No egress.
async fn cmd_continue_pull(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let repo_std = repo.as_std_path();
    let runner = TokioProcessRunner::new();
    let done = rebase_continue(&runner, repo_std)
        .await
        .map_err(map_runner_error)?;
    if done {
        return Ok(json!({ "outcome": "done" }));
    }
    let remaining = list_unmerged_paths(&runner, repo_std)
        .await
        .map_err(map_runner_error)?;
    Ok(json!({ "outcome": "still_conflicted", "conflict_count": remaining.len() as u32 }))
}

/// `git rebase --abort` — unwind the in-progress rebase back to the pre-pull
/// branch state (the resolver's "Cancel" escape hatch). No egress.
async fn cmd_abort_pull(args: &Value) -> Result<Value, LibraryError> {
    let repo = require_library(args)?;
    let runner = TokioProcessRunner::new();
    rebase_abort(&runner, repo.as_std_path())
        .await
        .map_err(map_runner_error)?;
    Ok(json!({}))
}

/// Shared push/scan range: `origin/<branch>..HEAD` when the upstream exists,
/// else `<empty-tree>..HEAD` (first push). Used by `scan_before_push` and
/// `count_unpushed_commits` so the gate and the badge agree on what "pending"
/// means.
async fn push_range(runner: &TokioProcessRunner, repo: &std::path::Path) -> Result<String, LibraryError> {
    let branch = current_branch(runner, repo).await.map_err(map_runner_error)?;
    let exists = remote_branch_exists(runner, repo, &branch)
        .await
        .map_err(map_runner_error)?;
    Ok(if exists {
        format!("origin/{branch}..HEAD")
    } else {
        format!("{EMPTY_TREE_HASH}..HEAD")
    })
}

/// Get the PAT from the injected store or fail with `no_pat_stored` (a
/// precondition the UI resolves by configuring a PAT first). The returned
/// `String` is held only for the duration of the push/pull, passed to the git
/// crate which puts it in env (never argv/log) and drops it.
fn require_pat(store: &dyn SecretStore) -> Result<String, LibraryError> {
    store
        .get_pat()
        .map_err(map_secret_error)?
        .ok_or_else(|| {
            LibraryError::new(
                "no_pat_stored",
                "no personal access token configured",
                "set a PAT before pushing or pulling",
            )
        })
}

/// Resolve the askpass state-dir the bridge writes `git-askpass.sh` into.
/// TS-injected from server config (`askpass_dir`, default `DATA_DIR/askpass`),
/// NEVER from an HTTP body (D3/D7). Missing/empty is a config fault.
fn parse_askpass_dir(args: &Value) -> Result<Utf8PathBuf, LibraryError> {
    let dir = args.get("askpass_dir").and_then(Value::as_str).unwrap_or("");
    if dir.is_empty() {
        return Err(LibraryError::new(
            "askpass_unconfigured",
            "no askpass dir configured",
            "request args.askpass_dir was missing or empty",
        ));
    }
    Ok(Utf8PathBuf::from(dir))
}

/// The conflict path the resolver operates on. Read from `conflict_path` (NOT
/// `path`, which `require_library` owns as the library root). git bounds it to
/// the index/worktree, so traversal can't escape the repo.
fn parse_conflict_path(args: &Value) -> Result<String, LibraryError> {
    let p = args.get("conflict_path").and_then(Value::as_str).unwrap_or("");
    if p.is_empty() {
        return Err(LibraryError::new(
            "conflict_path_missing",
            "no conflict path given",
            "request args.conflict_path was missing or empty",
        ));
    }
    Ok(p.to_string())
}

/// Parse the user-facing conflict side (`local`/`remote`) into the git crate's
/// `Side`. The `--ours`/`--theirs` rebase swap stays hidden in-crate.
fn parse_conflict_side(args: &Value) -> Result<Side, LibraryError> {
    match args.get("side").and_then(Value::as_str) {
        Some("local") => Ok(Side::Local),
        Some("remote") => Ok(Side::Remote),
        other => Err(LibraryError::new(
            "invalid_conflict_side",
            "invalid conflict side",
            format!("expected `local` or `remote`, got {other:?}"),
        )),
    }
}

/// Per-conflict classification the resolver uses to pick a renderer (ported from
/// the reference `classify_conflict_path`). `current.txt`/`metadata.yaml` get
/// value-pickers; `versions/` files + everything else fall back to the
/// copy-absolute-path escape hatch (Slice 10c — no native Finder reveal).
fn classify_conflict_path(path: &str) -> &'static str {
    let last = path.rsplit('/').next().unwrap_or(path);
    if last == "current.txt" {
        return "current_txt";
    }
    if last == "metadata.yaml" {
        return "metadata_yaml";
    }
    if path.contains("/versions/") || path.starts_with("versions/") {
        return "version_file";
    }
    "other"
}

/// IPC view of a `FileFinding` — carries the matched bytes VERBATIM so the UI
/// can show the user exactly what tripped the gate (D4). The matched string is
/// scanned-repo content, not the stored PAT.
fn file_finding_json(f: FileFinding) -> Value {
    json!({
        "path": f.path.to_string_lossy(),
        "line": f.line,
        "kind": finding_kind_str(f.finding.kind),
        "matched": f.finding.matched,
    })
}

/// `FindingKind` → its snake_case wire string (ported from the reference's
/// `FileFindingDto::from`).
fn finding_kind_str(kind: FindingKind) -> &'static str {
    match kind {
        FindingKind::GithubClassicPat => "github_classic_pat",
        FindingKind::GithubFineGrainedPat => "github_fine_grained_pat",
        FindingKind::GithubOauth => "github_oauth",
        FindingKind::OpenAiKey => "openai_key",
        FindingKind::AwsAccessKey => "aws_access_key",
        FindingKind::SlackToken => "slack_token",
        FindingKind::PrivateKeyBlock => "private_key_block",
        FindingKind::JsonApiKeyField => "json_api_key_field",
        FindingKind::HighEntropyString => "high_entropy_string",
    }
}

/// `AskpassError` → `askpass_init_failed` (502). The detail names the state-dir
/// path (server-side only, m4), never a secret.
fn map_askpass_error(e: AskpassError) -> LibraryError {
    LibraryError::new(
        "askpass_init_failed",
        "could not initialize the git askpass helper",
        e.to_string(),
    )
}

/// `RunnerError` → a dashboard-stable code. `TimedOut` → `git_timed_out`;
/// everything else → `git_failed` with git's own stderr as `detail`
/// (server-side only, m4). git stderr is PAT-free — the token travels via env,
/// never echoed by git — so even the server-side detail can't leak it.
fn map_runner_error(e: RunnerError) -> LibraryError {
    match e {
        RunnerError::TimedOut => LibraryError::new(
            "git_timed_out",
            "git operation timed out",
            "git pull exceeded the network timeout",
        ),
        other => LibraryError::new("git_failed", "git command failed", runner_error_message(&other)),
    }
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
        // Lifecycle variant: create/rename/duplicate onto a name that already
        // exists. Promoted out of the catch-all so a name collision is a clean
        // 409 ("that name is taken — pick another"), never an opaque 502. The
        // most common lifecycle error; the difference between a legible conflict
        // and a confusing bridge fault.
        CoreError::PrimitiveAlreadyExists { .. } => {
            ("library_primitive_exists", "a primitive with that name already exists")
        }
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
        // Metadata-editing variant: dropping an allowed_target that still has
        // overlay files. Promoted out of the catch-all so the route maps it to
        // 409 and the UI offers a confirm-then-discard (re-issue with
        // `discard_orphan_overlays: true`) rather than an opaque 502. The
        // payload's dropped-target paths stay server-side (m4 / never-forward-
        // detail); the UI names them from its already-loaded `list_overlays`.
        CoreError::TargetRemovedWithOverlays { .. } => {
            ("library_target_removed_with_overlays", "dropping a target would orphan its overlay files")
        }
        CoreError::InstallNotSupported { .. } => {
            ("library_install_not_supported", "install is not supported for this kind/target")
        }
        // Working-copy / editor variants — promoted out of the catch-all so the
        // route layer maps them to actionable HTTP statuses (422/409/404) and
        // the editor offers the right next step. `InvalidWorkingPath` is the
        // path-traversal tripwire code; the primary-save parse failures
        // (Metadata/CodexAgent/Md/NotUtf8) already map to `library_parse_error`
        // above — the file was never written.
        CoreError::InvalidWorkingPath(_) => {
            ("library_invalid_working_path", "invalid working-file path")
        }
        CoreError::WorkingFileAlreadyExists { .. } => {
            ("working_file_exists", "a working file with that name already exists")
        }
        CoreError::WorkingFileNotFound { .. } => {
            ("working_file_not_found", "no such working file")
        }
        CoreError::RefuseRenamePrimary { .. } | CoreError::RefuseDeletePrimary { .. } => {
            ("working_file_refuse_primary", "cannot rename or delete the primary file")
        }
        CoreError::TooManyWorkingFiles { .. } => {
            ("working_file_too_many", "primitive working-file bundle is at its cap")
        }
        // Versioning / publishing variants — promoted out of the catch-all so
        // re-publishing an existing label is a 409 ("use a new label") and a
        // set-current / inspect / revert against a missing label is a 404, each
        // with an actionable UI next step instead of a generic 502.
        CoreError::VersionExists(_) => {
            ("library_version_exists", "a version with that label already exists")
        }
        CoreError::VersionNotFound(_) => ("library_version_not_found", "no such version"),
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
    async fn find_in_library_returns_matching_hits() {
        let (_tmp, root) = fixture_library();
        // Seed the diagnose skill's primary file with a needle on a known line.
        let n = PrimitiveName::try_new("diagnose").unwrap();
        WorkingCopy::new(LibraryLayout::new(&root))
            .save_base_file(
                PrimitiveKind::Skill,
                &n,
                camino::Utf8Path::new("SKILL.md"),
                b"---\n---\nfirst\nneedle here\n",
            )
            .unwrap();
        let mut args = args_path(&root);
        args["query"] = json!("needle");
        let data = cmd_find_in_library(&args).unwrap();
        let arr = data.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["kind"], json!("skill"));
        assert_eq!(arr[0]["name"], json!("diagnose"));
        assert_eq!(arr[0]["line_number"], json!(4));
        assert_eq!(arr[0]["line_text"], json!("needle here"));
    }

    #[tokio::test]
    async fn find_in_library_empty_query_returns_empty() {
        let (_tmp, root) = fixture_library();
        let mut args = args_path(&root);
        args["query"] = json!("");
        let data = cmd_find_in_library(&args).unwrap();
        assert_eq!(data, json!([]));
    }

    #[tokio::test]
    async fn find_in_library_unconfigured_path_is_unconfigured() {
        // No `path` arg at all → require_library refuses before any fs walk.
        let err = cmd_find_in_library(&json!({ "query": "needle" })).unwrap_err();
        assert_eq!(err.code, "library_unconfigured");
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

    // ---- working-copy / editor (working-copy slice) -------------------------
    //
    // Every test runs against a temp library (`fixture_library` scaffolds a
    // `diagnose` skill whose primary `SKILL.md` already exists in
    // `working/base/`). Ref files are seeded with core's own
    // `WorkingCopy::save_base_file`, so the bridge contract is exercised against
    // real on-disk bundles, never hand-authored bytes. No test writes outside
    // its temp dir; the crate stays network-free + secrets-free (structural —
    // it does not depend on prompt-library-secrets).

    /// Base args for a working-file command on the scaffolded `diagnose` skill.
    fn wf_args(root: &Utf8PathBuf) -> Value {
        json!({ "path": root.as_str(), "kind": "skill", "name": "diagnose" })
    }

    /// Seed a ref file under the primitive's `working/base/` via core.
    fn seed_ref(root: &Utf8PathBuf, rel: &str, bytes: &[u8]) {
        let n = PrimitiveName::try_new("diagnose").unwrap();
        WorkingCopy::new(LibraryLayout::new(root))
            .save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new(rel), bytes)
            .unwrap();
    }

    fn working_base(root: &Utf8PathBuf) -> Utf8PathBuf {
        let n = PrimitiveName::try_new("diagnose").unwrap();
        LibraryLayout::new(root).working_base(PrimitiveKind::Skill, &n)
    }

    #[test]
    fn list_working_files_pins_primary_then_refs() {
        let (_tmp, root) = fixture_library();
        // Scaffold-only: the primary SKILL.md is the sole entry.
        let only = cmd_list_working_files(&wf_args(&root)).unwrap();
        let arr = only.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["path"], json!("SKILL.md"));
        assert_eq!(arr[0]["role"], json!("primary"));
        assert_eq!(arr[0]["is_text"], json!(true));
        // Seed two refs → primary first, refs alphabetical.
        seed_ref(&root, "zebra.md", b"z");
        seed_ref(&root, "notes.md", b"n");
        let listed = cmd_list_working_files(&wf_args(&root)).unwrap();
        let paths: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["SKILL.md", "notes.md", "zebra.md"]);
        assert_eq!(listed[0]["role"], json!("primary"));
        assert_eq!(listed[1]["role"], json!("ref"));
    }

    #[test]
    fn read_working_file_text_carries_extension() {
        let (_tmp, root) = fixture_library();
        seed_ref(&root, "notes.md", b"hello\n");
        let mut args = wf_args(&root);
        args["rel"] = json!("notes.md");
        let bytes = cmd_read_working_file(&args).unwrap();
        assert_eq!(bytes["kind"], json!("text"));
        assert_eq!(bytes["text"], json!("hello\n"));
        assert_eq!(bytes["ext"], json!("md"));
    }

    #[test]
    fn read_working_file_binary_returns_size_only() {
        let (_tmp, root) = fixture_library();
        // NUL in the first 8 KiB → binary; bytes are never returned.
        seed_ref(&root, "logo.bin", &[0xFFu8, 0x00, 0x01, 0x02]);
        let mut args = wf_args(&root);
        args["rel"] = json!("logo.bin");
        let bytes = cmd_read_working_file(&args).unwrap();
        assert_eq!(bytes["kind"], json!("binary"));
        assert_eq!(bytes["size"], json!(4));
        assert!(bytes.get("text").is_none(), "binary must not carry bytes");
    }

    /// The traversal tripwire (risk-a, bridge half): a `../` ref path is
    /// rejected IN-CORE by `validate_path_shape`, surfacing as the stable
    /// `library_invalid_working_path` code — it never reaches the fs. (The
    /// library root is `args.path`; the ref path is `args.rel` — distinct keys.)
    #[test]
    fn read_working_file_rejects_traversal_path() {
        let (_tmp, root) = fixture_library();
        for payload in ["../escape.md", "notes/../escape.md", "/etc/passwd"] {
            let mut args = wf_args(&root);
            args["rel"] = json!(payload);
            let err = cmd_read_working_file(&args).unwrap_err();
            assert_eq!(
                err.code, "library_invalid_working_path",
                "payload `{payload}` should be rejected in-core"
            );
        }
    }

    #[test]
    fn create_working_file_writes_then_rejects_duplicate_and_primary() {
        let (_tmp, root) = fixture_library();
        let mut args = wf_args(&root);
        args["rel"] = json!("notes/intro.md");
        args["content"] = json!("hello\n");
        cmd_create_working_file(&args).unwrap();
        assert!(working_base(&root).join("notes/intro.md").exists());
        // Same path again → exists.
        assert_eq!(
            cmd_create_working_file(&args).unwrap_err().code,
            "working_file_exists"
        );
        // Primary filename via the ref path → rejected in-core (must route
        // through save_working).
        let mut primary = wf_args(&root);
        primary["rel"] = json!("SKILL.md");
        primary["content"] = json!("x");
        assert_eq!(
            cmd_create_working_file(&primary).unwrap_err().code,
            "library_invalid_working_path"
        );
    }

    #[test]
    fn save_working_file_updates_existing_and_errors_on_missing() {
        let (_tmp, root) = fixture_library();
        seed_ref(&root, "notes.md", b"v1");
        let mut args = wf_args(&root);
        args["rel"] = json!("notes.md");
        args["content"] = json!("v2");
        cmd_save_working_file(&args).unwrap();
        let mut read = wf_args(&root);
        read["rel"] = json!("notes.md");
        assert_eq!(cmd_read_working_file(&read).unwrap()["text"], json!("v2"));
        // Missing file → not_found (callers must create first).
        let mut missing = wf_args(&root);
        missing["rel"] = json!("absent.md");
        missing["content"] = json!("x");
        assert_eq!(
            cmd_save_working_file(&missing).unwrap_err().code,
            "working_file_not_found"
        );
    }

    #[test]
    fn rename_working_file_moves_and_enforces_invariants() {
        let (_tmp, root) = fixture_library();
        seed_ref(&root, "a.md", b"a");
        // a.md → docs/a.md: moved, intermediate dir created.
        let mut mv = wf_args(&root);
        mv["old_rel"] = json!("a.md");
        mv["new_rel"] = json!("docs/a.md");
        cmd_rename_working_file(&mv).unwrap();
        assert!(working_base(&root).join("docs/a.md").exists());
        assert!(!working_base(&root).join("a.md").exists());
        // Primary as source → refuse.
        let mut prim = wf_args(&root);
        prim["old_rel"] = json!("SKILL.md");
        prim["new_rel"] = json!("renamed.md");
        assert_eq!(
            cmd_rename_working_file(&prim).unwrap_err().code,
            "working_file_refuse_primary"
        );
        // Dest exists → exists.
        seed_ref(&root, "b.md", b"b");
        seed_ref(&root, "c.md", b"c");
        let mut clash = wf_args(&root);
        clash["old_rel"] = json!("b.md");
        clash["new_rel"] = json!("c.md");
        assert_eq!(
            cmd_rename_working_file(&clash).unwrap_err().code,
            "working_file_exists"
        );
        // Source missing → not_found.
        let mut gone = wf_args(&root);
        gone["old_rel"] = json!("nope.md");
        gone["new_rel"] = json!("x.md");
        assert_eq!(
            cmd_rename_working_file(&gone).unwrap_err().code,
            "working_file_not_found"
        );
    }

    #[test]
    fn delete_working_file_is_idempotent_and_refuses_primary() {
        let (_tmp, root) = fixture_library();
        seed_ref(&root, "notes.md", b"x");
        let mut args = wf_args(&root);
        args["rel"] = json!("notes.md");
        cmd_delete_working_file(&args).unwrap();
        assert!(!working_base(&root).join("notes.md").exists());
        // Second delete on a missing file → still Ok (idempotent).
        cmd_delete_working_file(&args).unwrap();
        // Primary → refuse, and the primary stays on disk.
        let mut prim = wf_args(&root);
        prim["rel"] = json!("SKILL.md");
        assert_eq!(
            cmd_delete_working_file(&prim).unwrap_err().code,
            "working_file_refuse_primary"
        );
        assert!(working_base(&root).join("SKILL.md").exists());
    }

    #[test]
    fn save_working_validates_primary_before_writing() {
        let (_tmp, root) = fixture_library();
        let primary = working_base(&root).join("SKILL.md");
        let before = std::fs::read(primary.as_std_path()).unwrap();
        // Valid MD blob → primary updated, list still reflects it.
        let mut ok = wf_args(&root);
        ok["content"] = json!("---\n---\nbody-v2\n");
        cmd_save_working(&ok).unwrap();
        assert_eq!(
            std::fs::read(primary.as_std_path()).unwrap(),
            b"---\n---\nbody-v2\n"
        );
        // Malformed MD (no opening fence) → parse error, the file is UNCHANGED:
        // save_primary_base validates BEFORE the atomic write.
        let mut bad = wf_args(&root);
        bad["content"] = json!("no fences here");
        assert_eq!(
            cmd_save_working(&bad).unwrap_err().code,
            "library_parse_error"
        );
        assert_eq!(
            std::fs::read(primary.as_std_path()).unwrap(),
            b"---\n---\nbody-v2\n",
            "a rejected primary save must not touch disk"
        );
        let _ = before;
    }

    #[test]
    fn working_file_commands_require_present_string_args() {
        let (_tmp, root) = fixture_library();
        // Missing `content` on a save → caller bug, bridge_bad_request.
        let mut args = wf_args(&root);
        args["rel"] = json!("notes.md");
        assert_eq!(
            cmd_save_working_file(&args).unwrap_err().code,
            "bridge_bad_request"
        );
    }

    #[tokio::test]
    async fn working_file_read_dispatches_through_the_envelope() {
        let (_tmp, root) = fixture_library();
        seed_ref(&root, "notes.md", b"hi");
        // The library root is `args.path`; the ref path is `args.rel` — distinct
        // keys, so a read carries both without collision.
        let req = json!({
            "v": 1,
            "command": "read_working_file",
            "args": { "path": root.as_str(), "kind": "skill", "name": "diagnose", "rel": "notes.md" },
        });
        let env = handle(&req.to_string()).await;
        assert_eq!(env["ok"], json!(true));
        assert_eq!(env["data"]["kind"], json!("text"));
        assert_eq!(env["data"]["text"], json!("hi"));
    }

    // ---- working-file golden fixtures ---------------------------------------
    //
    // These tie the committed `list_working_files`/`read_working_file_{text,
    // binary}` bytes (which the TS validators parse) to LIVE core output, so a
    // serde rename on `WorkingFileEntry`/`WorkingFileBytes` fails `cargo test`
    // instead of silently desyncing the frozen fixtures. The bundle's bytes are
    // byte-identical to `seed_fixture_library --working` (the `capture.ts`
    // generator), so the JSON is asserted from both directions.

    /// `fixture_library` (scaffolds `diagnose`) + the deterministic working
    /// bundle: a fixed primary, one text ref, one binary ref. Mirrors the
    /// example's `seed_working_bundle` byte-for-byte.
    fn working_fixture() -> (TempDir, Utf8PathBuf) {
        let (tmp, root) = fixture_library();
        seed_ref(&root, "SKILL.md", b"---\n---\nbody\n");
        seed_ref(&root, "notes.md", b"hello\n");
        seed_ref(&root, "logo.bin", &[0xFFu8, 0x00, 0x01, 0x02]);
        (tmp, root)
    }

    #[test]
    fn list_working_files_matches_committed_fixture() {
        let (_tmp, root) = working_fixture();
        let data = cmd_list_working_files(&wf_args(&root)).unwrap();
        let expected =
            golden_data(include_str!("../../../scripts/fixtures/bridge/list_working_files.json"));
        assert_eq!(
            data, expected,
            "list_working_files drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[test]
    fn read_working_file_text_matches_committed_fixture() {
        let (_tmp, root) = working_fixture();
        let mut args = wf_args(&root);
        args["rel"] = json!("notes.md");
        let data = cmd_read_working_file(&args).unwrap();
        let expected =
            golden_data(include_str!("../../../scripts/fixtures/bridge/read_working_file_text.json"));
        assert_eq!(
            data, expected,
            "read_working_file_text drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    #[test]
    fn read_working_file_binary_matches_committed_fixture() {
        let (_tmp, root) = working_fixture();
        let mut args = wf_args(&root);
        args["rel"] = json!("logo.bin");
        let data = cmd_read_working_file(&args).unwrap();
        let expected = golden_data(include_str!(
            "../../../scripts/fixtures/bridge/read_working_file_binary.json"
        ));
        assert_eq!(
            data, expected,
            "read_working_file_binary drifted from the committed fixture — regenerate with \
             `bun run scripts/fixtures/bridge/capture.ts`"
        );
    }

    // ---- versioning / publishing (versioning slice) -------------------------
    //
    // Publish is the dashboard's FIRST commit-on-write and FIRST multi-step
    // mutation (snapshot + commit). These tests pin the four invariants the
    // slice settled: immutability (re-publish → 409), the non-fatal commit
    // posture (a commit failure rides back in the result, never an error
    // envelope — Decision 1+3), revert-as-working-copy-rewind that does NOT
    // commit (Decision 2), and label validation at the wire boundary.
    //
    // The git-backed tests shell out to the real `git` (the bridge does too via
    // TokioProcessRunner). Each uses its own TempDir, so they never collide; a
    // pre-commit hook gives a DETERMINISTIC commit failure independent of the
    // dev's global git identity.

    /// Versioning args for the scaffolded `diagnose` skill. `created_at` is the
    /// TS-supplied publish timestamp (the install-slice seam — the bridge owns
    /// no clock); it is harmlessly ignored by the read/set/revert commands.
    fn ver_args(root: &Utf8PathBuf, label: &str) -> Value {
        json!({
            "path": root.as_str(), "kind": "skill", "name": "diagnose",
            "version_label": label, "created_at": NOW,
        })
    }

    /// Overwrite the primary `SKILL.md` working body (valid MD so the version
    /// inspector can parse it back).
    fn set_working_body(root: &Utf8PathBuf, body: &[u8]) {
        let n = PrimitiveName::try_new("diagnose").unwrap();
        WorkingCopy::new(LibraryLayout::new(root))
            .save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new("SKILL.md"), body)
            .unwrap();
    }

    /// The current pinned label, read straight from core (`current.txt`).
    fn current_label(root: &Utf8PathBuf) -> Option<String> {
        let n = PrimitiveName::try_new("diagnose").unwrap();
        VersionStore::new(LibraryLayout::new(root))
            .read_current(PrimitiveKind::Skill, &n)
            .unwrap()
            .map(|l| l.as_str().to_string())
    }

    fn run_git(root: &Utf8PathBuf, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root.as_std_path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// `git init` + a LOCAL identity (overrides any global config, so commit
    /// success is deterministic regardless of the dev machine).
    fn git_init_repo(root: &Utf8PathBuf) {
        run_git(root, &["init", "-q"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "Library Test"]);
    }

    fn git_capture(root: &Utf8PathBuf, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root.as_std_path())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn publish_without_git_snapshots_but_reports_no_commit() {
        let (_tmp, root) = fixture_library();
        set_working_body(&root, b"---\n---\nbody-v1\n");
        // No `.git/` → snapshot succeeds, commit is silently skipped (not a
        // failure): committed:false, commit_error:null.
        let res = cmd_publish(&ver_args(&root, "v1")).await.unwrap();
        assert_eq!(res["committed"], json!(false));
        assert_eq!(res["commit_error"], json!(null), "a non-git library is not a commit failure");
        // The version landed and current advanced.
        assert_eq!(current_label(&root).as_deref(), Some("v1"));
        let view = cmd_read_primitive_version(&ver_args(&root, "v1")).unwrap();
        assert_eq!(view["working"]["kind"], json!("md"));
        assert_eq!(view["working"]["body"], json!("body-v1\n"));
        // Immutability: re-publishing the same label is a 409-mapped conflict.
        assert_eq!(
            cmd_publish(&ver_args(&root, "v1")).await.unwrap_err().code,
            "library_version_exists"
        );
    }

    #[tokio::test]
    async fn publish_commits_when_git_configured() {
        let (_tmp, root) = fixture_library();
        git_init_repo(&root);
        set_working_body(&root, b"---\n---\nbody-v1\n");
        let res = cmd_publish(&ver_args(&root, "v1")).await.unwrap();
        assert_eq!(res["committed"], json!(true));
        assert_eq!(res["commit_error"], json!(null));
        assert_eq!(git_capture(&root, &["log", "-1", "--pretty=%s"]), "publish(skills/diagnose): v1");
        assert_eq!(current_label(&root).as_deref(), Some("v1"));
    }

    #[tokio::test]
    async fn publish_commit_failure_is_nonfatal_and_recoverable() {
        let (_tmp, root) = fixture_library();
        git_init_repo(&root);
        // Force a DETERMINISTIC commit failure: a pre-commit hook that always
        // exits non-zero. `git add` succeeds, `git commit` fails — AFTER the
        // snapshot has already landed (Decision 1+3: the commit is advisory).
        run_git(&root, &["config", "core.hooksPath", ".git/hooks"]);
        let hooks = root.join(".git/hooks");
        std::fs::create_dir_all(hooks.as_std_path()).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(hook.as_std_path(), b"#!/bin/sh\necho 'blocked by test hook' 1>&2\nexit 1\n")
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hook.as_std_path(), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        set_working_body(&root, b"---\n---\nbody-v1\n");
        // Dispatch through the FULL envelope: the publish still succeeds (ok),
        // the commit failure is data, not an error.
        let env = handle(
            &json!({ "v": 1, "command": "publish", "args": ver_args(&root, "v1") }).to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "a commit failure must NOT fail the publish envelope");
        assert_eq!(env["data"]["committed"], json!(false));
        assert!(
            env["data"]["commit_error"].as_str().is_some_and(|s| !s.is_empty()),
            "a commit failure must surface a legible message, got {:?}",
            env["data"]["commit_error"]
        );
        // Recovery is a no-op: the version is on disk and current.
        assert_eq!(current_label(&root).as_deref(), Some("v1"));
        cmd_read_primitive_version(&ver_args(&root, "v1")).unwrap();
    }

    #[tokio::test]
    async fn set_current_moves_pointer_and_errors_on_unknown() {
        let (_tmp, root) = fixture_library();
        set_working_body(&root, b"---\n---\nbody-v1\n");
        cmd_publish(&ver_args(&root, "v1")).await.unwrap();
        set_working_body(&root, b"---\n---\nbody-v2\n");
        cmd_publish(&ver_args(&root, "v2")).await.unwrap();
        assert_eq!(current_label(&root).as_deref(), Some("v2"));
        // Pin back to v1 (no git → committed:false, commit_error:null).
        let res = cmd_set_current_version(&ver_args(&root, "v1")).await.unwrap();
        assert_eq!(res["committed"], json!(false));
        assert_eq!(current_label(&root).as_deref(), Some("v1"));
        // Unknown label → 404-mapped code.
        assert_eq!(
            cmd_set_current_version(&ver_args(&root, "v9")).await.unwrap_err().code,
            "library_version_not_found"
        );
    }

    #[tokio::test]
    async fn read_primitive_version_returns_frozen_bytes() {
        let (_tmp, root) = fixture_library();
        set_working_body(&root, b"---\n---\nbody-v1\n");
        cmd_publish(&ver_args(&root, "v1")).await.unwrap();
        set_working_body(&root, b"---\n---\nbody-v2\n");
        cmd_publish(&ver_args(&root, "v2")).await.unwrap();
        // v1 stays frozen even after v2 is the working/current content.
        let v1 = cmd_read_primitive_version(&ver_args(&root, "v1")).unwrap();
        let v2 = cmd_read_primitive_version(&ver_args(&root, "v2")).unwrap();
        assert_eq!(v1["working"]["body"], json!("body-v1\n"));
        assert_eq!(v2["working"]["body"], json!("body-v2\n"));
        assert_eq!(v1["metadata"]["created_at"], json!(NOW));
        // Unknown label → 404-mapped code.
        assert_eq!(
            cmd_read_primitive_version(&ver_args(&root, "v9")).unwrap_err().code,
            "library_version_not_found"
        );
    }

    #[tokio::test]
    async fn revert_rewinds_working_and_does_not_commit() {
        let (_tmp, root) = fixture_library();
        git_init_repo(&root);
        set_working_body(&root, b"---\n---\nbody-v1\n");
        cmd_publish(&ver_args(&root, "v1")).await.unwrap();
        let head_after_publish = git_capture(&root, &["rev-parse", "HEAD"]);
        // Mutate working: change the primary + add an orphan ref absent from v1.
        set_working_body(&root, b"---\n---\nbody-v2\n");
        seed_ref(&root, "orphan.md", b"orphan\n");
        // Revert rewinds working/ exactly and creates NO commit (Decision 2).
        let res = cmd_revert_to_version(&ver_args(&root, "v1")).unwrap();
        assert_eq!(res, json!({}));
        let primary = working_base(&root).join("SKILL.md");
        assert_eq!(std::fs::read(primary.as_std_path()).unwrap(), b"---\n---\nbody-v1\n");
        assert!(
            !working_base(&root).join("orphan.md").exists(),
            "revert is a true rewind — orphans are deleted"
        );
        assert_eq!(
            git_capture(&root, &["rev-parse", "HEAD"]),
            head_after_publish,
            "revert touches only gitignored working/ — it must not commit"
        );
    }

    #[tokio::test]
    async fn publish_rejects_invalid_version_label() {
        let (_tmp, root) = fixture_library();
        set_working_body(&root, b"---\n---\nbody\n");
        // `1.0` is not `v<digits>` — rejected at the wire boundary, no dir touched.
        assert_eq!(
            cmd_publish(&ver_args(&root, "1.0")).await.unwrap_err().code,
            "library_invalid_version"
        );
    }

    // ---- target overlays ----------------------------------------------------

    /// A `diagnose` skill with a seeded base `SKILL.md` and `allowed_targets:
    /// [Claude, Pi]` (Codex deliberately disallowed, to exercise the
    /// TargetNotAllowed boundary). The base body is valid MD so the merged read
    /// parses back.
    fn overlay_fx() -> (TempDir, Utf8PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        let n = PrimitiveName::try_new("diagnose").unwrap();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &n, NOW).unwrap();
        WorkingCopy::new(layout)
            .save_base_file(PrimitiveKind::Skill, &n, Utf8Path::new("SKILL.md"), b"---\n---\nbase\n")
            .unwrap();
        update_primitive_metadata(
            layout,
            PrimitiveKind::Skill,
            &n,
            MetadataUpdate {
                allowed_targets: vec![Target::Claude, Target::Pi],
                display_name: None,
                author: None,
                discard_orphan_overlays: false,
            },
        )
        .unwrap();
        (tmp, root)
    }

    /// Overlay args for the `diagnose` skill at `target`.
    fn ov_args(root: &Utf8PathBuf, target: &str) -> Value {
        json!({ "path": root.as_str(), "kind": "skill", "name": "diagnose", "target": target })
    }

    #[test]
    fn write_overlay_then_read_merges_and_lists() {
        let (_tmp, root) = overlay_fx();
        // No overlay yet: Pi reads the base passthrough.
        let pi = cmd_read_primitive_target(&ov_args(&root, "pi")).unwrap();
        assert_eq!(pi["has_overlay"], json!(false));
        assert_eq!(pi["working"]["body"], json!("base\n"));
        assert_eq!(cmd_list_overlays(&ov_args(&root, "claude")).unwrap(), json!([]));

        // Write a Claude overlay (the merge is exercised end-to-end through the
        // bridge → read_primitive_for_target → overlay_merge::merge).
        let mut write = ov_args(&root, "claude");
        write["content"] = json!("---\n---\nclaude-only\n");
        assert_eq!(cmd_write_overlay(&write).unwrap(), json!({}));

        // read_primitive_target(Claude) now reflects the overlay; Pi still base.
        let claude = cmd_read_primitive_target(&ov_args(&root, "claude")).unwrap();
        assert_eq!(claude["has_overlay"], json!(true));
        assert_eq!(claude["working"]["body"], json!("claude-only\n"));
        let pi = cmd_read_primitive_target(&ov_args(&root, "pi")).unwrap();
        assert_eq!(pi["has_overlay"], json!(false));
        assert_eq!(pi["working"]["body"], json!("base\n"));

        // list_overlays surfaces only Claude, with the primary filename.
        assert_eq!(
            cmd_list_overlays(&ov_args(&root, "claude")).unwrap(),
            json!([{ "target": "claude", "paths": ["SKILL.md"] }])
        );
    }

    #[test]
    fn read_primitive_target_rejects_disallowed_target() {
        let (_tmp, root) = overlay_fx();
        // Codex ∉ allowed_targets → in-core rejection, 422-mapped code.
        assert_eq!(
            cmd_read_primitive_target(&ov_args(&root, "codex")).unwrap_err().code,
            "library_target_not_allowed"
        );
    }

    #[test]
    fn write_overlay_rejects_malformed_and_leaves_disk_unchanged() {
        let (_tmp, root) = overlay_fx();
        // Missing frontmatter fence → parse failure BEFORE the atomic write.
        let mut write = ov_args(&root, "claude");
        write["content"] = json!("no frontmatter fence here");
        assert_eq!(cmd_write_overlay(&write).unwrap_err().code, "library_parse_error");
        // The overlay file was never created — disk is untouched.
        assert_eq!(cmd_list_overlays(&ov_args(&root, "claude")).unwrap(), json!([]));
        assert_eq!(
            cmd_read_primitive_target(&ov_args(&root, "claude")).unwrap()["has_overlay"],
            json!(false)
        );
    }

    #[test]
    fn remove_overlay_reverts_to_base_and_is_idempotent() {
        let (_tmp, root) = overlay_fx();
        let mut write = ov_args(&root, "claude");
        write["content"] = json!("---\n---\nclaude-only\n");
        cmd_write_overlay(&write).unwrap();
        assert_eq!(
            cmd_read_primitive_target(&ov_args(&root, "claude")).unwrap()["has_overlay"],
            json!(true)
        );

        // Remove → list drops Claude, read reverts to the base passthrough.
        assert_eq!(cmd_remove_overlay(&ov_args(&root, "claude")).unwrap(), json!({}));
        assert_eq!(cmd_list_overlays(&ov_args(&root, "claude")).unwrap(), json!([]));
        let claude = cmd_read_primitive_target(&ov_args(&root, "claude")).unwrap();
        assert_eq!(claude["has_overlay"], json!(false));
        assert_eq!(claude["working"]["body"], json!("base\n"));

        // Re-remove is a no-op success (core idempotency).
        assert_eq!(cmd_remove_overlay(&ov_args(&root, "claude")).unwrap(), json!({}));
    }

    #[test]
    fn overlay_commands_reject_bad_target_value() {
        let (_tmp, root) = overlay_fx();
        // A target value outside the closed enum is a wire-boundary error.
        assert_eq!(
            cmd_read_primitive_target(&ov_args(&root, "nonsense")).unwrap_err().code,
            "library_invalid_target"
        );
    }

    // ---- metadata editing ---------------------------------------------------

    /// Args for `update_metadata` on the `diagnose` skill. `display`/`author`
    /// accept a string, `""`, or `null` (the last two both clear the field).
    fn meta_args(
        root: &Utf8PathBuf,
        targets: Value,
        display: Value,
        author: Value,
        discard: bool,
    ) -> Value {
        json!({
            "path": root.as_str(),
            "kind": "skill",
            "name": "diagnose",
            "allowed_targets": targets,
            "display_name": display,
            "author": author,
            "discard_orphan_overlays": discard,
        })
    }

    /// Raw on-disk `metadata.yaml` for the `diagnose` skill.
    fn read_metadata_yaml(root: &Utf8PathBuf) -> String {
        let n = PrimitiveName::try_new("diagnose").unwrap();
        let path = LibraryLayout::new(root).primitive_metadata(PrimitiveKind::Skill, &n);
        std::fs::read_to_string(path.as_std_path()).unwrap()
    }

    #[tokio::test]
    async fn update_metadata_replaces_fields_preserves_created_at_and_commits() {
        let (_tmp, root) = overlay_fx(); // diagnose skill, allowed [Claude, Pi], created_at NOW
        git_init_repo(&root);
        let res = cmd_update_metadata(&meta_args(
            &root,
            json!(["claude", "pi"]),
            json!("Diag"),
            json!("Alice"),
            false,
        ))
        .await
        .unwrap();
        assert_eq!(res["metadata"]["display_name"], json!("Diag"));
        assert_eq!(res["metadata"]["author"], json!("Alice"));
        assert_eq!(res["metadata"]["allowed_targets"], json!(["claude", "pi"]));
        assert_eq!(res["metadata"]["created_at"], json!(NOW), "created_at is preserved verbatim");
        // metadata.yaml is git-tracked (not under gitignored working/), so it COMMITS.
        assert_eq!(res["committed"], json!(true));
        assert_eq!(res["commit_error"], json!(null));
        assert_eq!(
            git_capture(&root, &["log", "-1", "--pretty=%s"]),
            "metadata(skills/diagnose)"
        );
    }

    #[tokio::test]
    async fn update_metadata_clears_optional_fields_dropping_them_from_yaml() {
        let (_tmp, root) = overlay_fx();
        cmd_update_metadata(&meta_args(&root, json!(["claude", "pi"]), json!("Diag"), json!("Alice"), false))
            .await
            .unwrap();
        // Clear via empty string + null — both map to None (drop the field).
        let res = cmd_update_metadata(&meta_args(&root, json!(["claude", "pi"]), json!(""), json!(null), false))
            .await
            .unwrap();
        assert_eq!(res["metadata"]["display_name"], json!(null));
        assert_eq!(res["metadata"]["author"], json!(null));
        let raw = read_metadata_yaml(&root);
        assert!(!raw.contains("display_name"), "cleared display_name must drop from YAML:\n{raw}");
        assert!(!raw.contains("author"), "cleared author must drop from YAML:\n{raw}");
    }

    #[tokio::test]
    async fn update_metadata_dropping_target_with_overlay_requires_confirm() {
        let (_tmp, root) = overlay_fx(); // [Claude, Pi]
        // Give Claude an overlay so dropping Claude would orphan it.
        let mut write = ov_args(&root, "claude");
        write["content"] = json!("---\n---\nclaude-only\n");
        cmd_write_overlay(&write).unwrap();

        // Drop Claude WITHOUT the confirm flag → refused; disk untouched.
        let err = cmd_update_metadata(&meta_args(&root, json!(["pi"]), json!(null), json!(null), false))
            .await
            .unwrap_err();
        assert_eq!(err.code, "library_target_removed_with_overlays");
        // Claude is still allowed (read_primitive_target would 422 if it weren't)
        // AND its overlay file survives — proving the metadata write never ran.
        assert_eq!(
            cmd_read_primitive_target(&ov_args(&root, "claude")).unwrap()["has_overlay"],
            json!(true)
        );

        // Confirm: re-issue the identical update with the discard flag → succeeds,
        // Claude dropped, the orphaned overlay deleted.
        let res = cmd_update_metadata(&meta_args(&root, json!(["pi"]), json!(null), json!(null), true))
            .await
            .unwrap();
        assert_eq!(res["metadata"]["allowed_targets"], json!(["pi"]));
        assert_eq!(cmd_list_overlays(&ov_args(&root, "claude")).unwrap(), json!([]));
    }

    #[tokio::test]
    async fn update_metadata_dropping_target_without_overlay_just_works() {
        let (_tmp, root) = overlay_fx(); // [Claude, Pi], no overlays
        // Drop Claude (no overlay) → no confirm needed.
        let res = cmd_update_metadata(&meta_args(&root, json!(["pi"]), json!(null), json!(null), false))
            .await
            .unwrap();
        assert_eq!(res["metadata"]["allowed_targets"], json!(["pi"]));
    }

    #[tokio::test]
    async fn update_metadata_rejects_target_not_in_kind_matrix() {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        let n = PrimitiveName::try_new("router").unwrap();
        // Agent disallows Codex (kind matrix: Claude, Pi only).
        scaffold_primitive(LibraryLayout::new(&root), PrimitiveKind::Agent, &n, NOW, None).unwrap();
        let args = json!({
            "path": root.as_str(),
            "kind": "agent",
            "name": "router",
            "allowed_targets": ["codex"],
            "display_name": null,
            "author": null,
            "discard_orphan_overlays": false,
        });
        // Rejected before any read; the 422-mapped code, distinct from the
        // allowed_targets (`library_target_not_allowed`) check.
        assert_eq!(
            cmd_update_metadata(&args).await.unwrap_err().code,
            "library_target_not_allowed_for_kind"
        );
    }

    #[tokio::test]
    async fn update_metadata_without_git_writes_but_reports_no_commit() {
        let (_tmp, root) = overlay_fx(); // no .git/
        let res = cmd_update_metadata(&meta_args(&root, json!(["claude", "pi"]), json!("Diag"), json!(null), false))
            .await
            .unwrap();
        assert_eq!(res["committed"], json!(false));
        assert_eq!(res["commit_error"], json!(null), "a non-git library is not a commit failure");
        assert_eq!(res["metadata"]["display_name"], json!("Diag"), "the write still landed");
    }

    #[tokio::test]
    async fn update_metadata_commit_failure_is_nonfatal() {
        let (_tmp, root) = overlay_fx();
        git_init_repo(&root);
        // A pre-commit hook that always fails: `git add` succeeds, `git commit`
        // fails AFTER the atomic metadata write already landed (the commit is
        // advisory — Slice 4's posture).
        run_git(&root, &["config", "core.hooksPath", ".git/hooks"]);
        let hooks = root.join(".git/hooks");
        std::fs::create_dir_all(hooks.as_std_path()).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(hook.as_std_path(), b"#!/bin/sh\necho 'blocked by test hook' 1>&2\nexit 1\n")
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hook.as_std_path(), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let env = handle(
            &json!({
                "v": 1,
                "command": "update_metadata",
                "args": meta_args(&root, json!(["claude", "pi"]), json!("Diag"), json!(null), false),
            })
            .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "a commit failure must NOT fail the envelope");
        assert_eq!(env["data"]["committed"], json!(false));
        assert!(
            env["data"]["commit_error"].as_str().is_some_and(|s| !s.is_empty()),
            "a commit failure must surface a legible message, got {:?}",
            env["data"]["commit_error"]
        );
        // The write landed regardless of the commit failure.
        assert_eq!(env["data"]["metadata"]["display_name"], json!("Diag"));
    }

    #[tokio::test]
    async fn update_metadata_rejects_malformed_allowed_targets() {
        let (_tmp, root) = overlay_fx();
        let args = json!({
            "path": root.as_str(),
            "kind": "skill",
            "name": "diagnose",
            "allowed_targets": ["nonsense"],
        });
        assert_eq!(
            cmd_update_metadata(&args).await.unwrap_err().code,
            "library_invalid_target"
        );
    }

    // ---- reimport-from-drift (reimport slice) -------------------------------
    //
    // Every test builds on `install_fx` (published `diagnose` skill + temp
    // install home + temp installs.json), installs it to Claude, then drives the
    // five `ReimportResult` variants. The fixtures stay network-free +
    // secrets-free (the crate structurally cannot depend on prompt-library-
    // secrets). A Skill→Claude install is a DIRECTORY layout: `<home>/.claude/
    // skills/<name>/SKILL.md`, so the primary install key is `SKILL.md`.

    /// Install the published `diagnose` skill to Claude (the precondition for
    /// every reimport — reimport reads the installed bytes back).
    fn install_diagnose_claude(fx: &InstallFx) {
        let summary = cmd_install(&write_args(fx, json!(["claude"]), false)).unwrap();
        assert_eq!(
            summary["successes"][0]["outcome"]["kind"],
            json!("installed"),
            "fixture precondition: diagnose must install cleanly"
        );
    }

    /// Reimport args for `diagnose` from its Claude install as `label`. Mutate
    /// the returned object for `discard_working` / `fixed_primary_text` / `notes`.
    fn reimport_args(fx: &InstallFx, label: &str) -> Value {
        json!({
            "path": fx.root.as_str(),
            "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "kind": "skill",
            "name": "diagnose",
            "target": "claude",
            "version_label": label,
            "created_at": NOW,
        })
    }

    /// Overwrite the on-disk installed SKILL.md (induce `Modified` drift).
    fn write_installed_skill(fx: &InstallFx, bytes: &[u8]) {
        std::fs::write(claude_skill_file(fx, "diagnose").as_std_path(), bytes).unwrap();
    }

    /// Args for `read_primitive_version` against `diagnose` (reads the frozen
    /// version body the reimport snapshotted).
    fn ver_read_args(fx: &InstallFx, label: &str) -> Value {
        json!({
            "path": fx.root.as_str(), "kind": "skill", "name": "diagnose",
            "version_label": label, "created_at": NOW,
        })
    }

    #[tokio::test]
    async fn reimport_captures_drifted_disk_as_new_version() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        // Drift: edit the installed copy out-of-band to NEW valid bytes.
        write_installed_skill(&fx, b"---\n---\nbody-DRIFTED\n");

        let data = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(data["kind"], json!("reimported"));
        // VersionLabel serializes as a bare string (serde `into = "String"`).
        assert_eq!(data["new_version"], json!("v2"));

        // current.txt advanced and the new frozen version carries the disk bytes.
        assert_eq!(current_label(&fx.root).as_deref(), Some("v2"));
        let view = cmd_read_primitive_version(&ver_read_args(&fx, "v2")).unwrap();
        assert_eq!(view["working"]["body"], json!("body-DRIFTED\n"));

        // The install record was re-baselined → the next drift scan reads Clean.
        let drift = cmd_scan_drift(&drift_args(&fx)).unwrap();
        assert_eq!(drift[0]["status"]["kind"], json!("clean"));
    }

    #[tokio::test]
    async fn reimport_commits_when_git_configured() {
        let fx = install_fx(vec![Target::Claude]);
        git_init_repo(&fx.root);
        install_diagnose_claude(&fx);
        write_installed_skill(&fx, b"---\n---\nbody-DRIFTED\n");

        // Dispatch through the FULL envelope.
        let env = handle(
            &json!({ "v": 1, "command": "reimport_install", "args": reimport_args(&fx, "v2") })
                .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true));
        assert_eq!(env["data"]["kind"], json!("reimported"));
        assert_eq!(env["data"]["committed"], json!(true));
        assert_eq!(env["data"]["commit_error"], json!(null));
        // The subject names reimport (not publish) so the log stays honest.
        assert_eq!(
            git_capture(&fx.root, &["log", "-1", "--pretty=%s"]),
            "reimport(skills/diagnose): v2"
        );
    }

    #[tokio::test]
    async fn reimport_without_git_snapshots_but_reports_no_commit() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        write_installed_skill(&fx, b"---\n---\nbody-DRIFTED\n");
        // No `.git/` → snapshot succeeds, commit silently skipped (not a failure).
        let data = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(data["kind"], json!("reimported"));
        assert_eq!(data["committed"], json!(false));
        assert_eq!(data["commit_error"], json!(null));
    }

    #[tokio::test]
    async fn reimport_working_dirty_blocks_uncommitted_then_discard_succeeds() {
        let fx = install_fx(vec![Target::Claude]);
        git_init_repo(&fx.root);
        install_diagnose_claude(&fx);
        write_installed_skill(&fx, b"---\n---\nbody-DRIFTED\n");
        // Unpublished working-copy edit → working/ diverges from current v1.
        set_working_body(&fx.root, b"---\n---\nbody-UNPUBLISHED\n");

        // Without discard: a hard block, NOT an error, and NOTHING committed.
        let blocked = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(blocked["kind"], json!("working_copy_dirty"));
        assert!(blocked.get("committed").is_none(), "a block must not commit");
        assert_eq!(current_label(&fx.root).as_deref(), Some("v1"), "no new version on a block");
        assert_eq!(
            git_capture(&fx.root, &["rev-list", "--count", "HEAD"]).parse::<u32>().unwrap_or(0),
            0,
            "a working_copy_dirty result must leave the git log untouched"
        );

        // With discard: working/ is reverted to current, disk bytes captured.
        let mut args = reimport_args(&fx, "v2");
        args["discard_working"] = json!(true);
        let ok = cmd_reimport(&args).await.unwrap();
        assert_eq!(ok["kind"], json!("reimported"));
        assert_eq!(ok["committed"], json!(true));
        let view = cmd_read_primitive_version(&ver_read_args(&fx, "v2")).unwrap();
        assert_eq!(view["working"]["body"], json!("body-DRIFTED\n"));
    }

    #[tokio::test]
    async fn reimport_broken_source_then_fixed_retry_succeeds() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        // Corrupt the installed primary so its frontmatter won't parse.
        write_installed_skill(&fx, b"this is not valid frontmatter at all");

        let broken = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(broken["kind"], json!("broken_source"));
        assert_eq!(broken["primary_path"], json!("SKILL.md"));
        assert!(broken["parse_error"].as_str().is_some_and(|s| !s.is_empty()));
        // raw_bytes rides the wire as a byte array for the UI's fix buffer.
        assert!(broken["raw_bytes"].is_array());
        assert_eq!(broken.get("committed"), None, "a broken source must not commit");

        // Retry with the user's fixed primary bytes → reimported.
        let mut args = reimport_args(&fx, "v2");
        args["fixed_primary_text"] = json!("---\n---\nbody-FIXED\n");
        let fixed = cmd_reimport(&args).await.unwrap();
        assert_eq!(fixed["kind"], json!("reimported"));
        let view = cmd_read_primitive_version(&ver_read_args(&fx, "v2")).unwrap();
        assert_eq!(view["working"]["body"], json!("body-FIXED\n"));
    }

    #[tokio::test]
    async fn reimport_not_installed_when_no_record() {
        let fx = install_fx(vec![Target::Claude]);
        // No install performed for claude → no record for (skill, diagnose, claude).
        let data = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(data["kind"], json!("not_installed"));
    }

    #[tokio::test]
    async fn reimport_install_missing_when_path_gone() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        // Remove the installed directory after recording it.
        std::fs::remove_dir_all(
            claude_skill_file(&fx, "diagnose").parent().unwrap().as_std_path(),
        )
        .unwrap();
        let data = cmd_reimport(&reimport_args(&fx, "v2")).await.unwrap();
        assert_eq!(data["kind"], json!("install_missing"));
    }

    #[tokio::test]
    async fn reimport_rejects_invalid_version_label() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        let mut args = reimport_args(&fx, "not-a-version");
        args["version_label"] = json!("nope");
        assert_eq!(
            cmd_reimport(&args).await.unwrap_err().code,
            "library_invalid_version"
        );
    }

    // ---- primitive lifecycle (lifecycle slice) -----------------------------
    //
    // Six structural-CRUD commands wrapping already-tested core fns. These pin
    // the BRIDGE-layer contract the core tests don't: the per-op commit-on-write
    // posture (create/delete/rename/duplicate/import COMMIT a git-tracked tree;
    // `forget` does NOT — it only edits the dashboard-owned installs.json), the
    // `library_primitive_exists` 409 mapping (the one new error arm — a name
    // collision must read as a legible conflict, never bridge_command_failed),
    // delete's commit-ONLY-when-the-dir-was-removed gate, and rename's
    // install-record migration count riding back for the UI caveat.

    /// Create/duplicate-style args: `path` + `kind` + `name` + a TS-supplied
    /// `created_at` (the bridge owns no clock; core writes it into metadata).
    fn create_args(root: &Utf8PathBuf, kind: &str, name: &str) -> Value {
        json!({ "path": root.as_str(), "kind": kind, "name": name, "created_at": NOW })
    }

    /// Lifecycle args for the install-aware verbs (delete/rename/forget) against
    /// `diagnose`: `path` + the config-injected `home`/`installs_path` + ident.
    fn life_install_args(fx: &InstallFx) -> Value {
        json!({
            "path": fx.root.as_str(), "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(), "kind": "skill", "name": "diagnose",
        })
    }

    /// Stage every tracked file and make an initial commit so HEAD exists — used
    /// by the no-commit-on-bail assertions (HEAD must NOT move).
    fn git_commit_all(root: &Utf8PathBuf, message: &str) {
        run_git(root, &["add", "-A"]);
        run_git(root, &["commit", "-q", "-m", message]);
    }

    #[tokio::test]
    async fn create_scaffolds_without_git_and_reports_no_commit() {
        let (_tmp, root) = fixture_library();
        let res = cmd_create_primitive(&create_args(&root, "skill", "triage")).await.unwrap();
        assert_eq!(res["committed"], json!(false));
        assert_eq!(res["commit_error"], json!(null), "a non-git library is not a commit failure");
        // Scaffolded: metadata + an empty primary under working/base/.
        assert!(root.join("skills/triage/metadata.yaml").exists());
        assert!(root.join("skills/triage/working/base/SKILL.md").exists());
    }

    #[tokio::test]
    async fn create_commits_when_git_configured() {
        let (_tmp, root) = fixture_library();
        git_init_repo(&root);
        let res = cmd_create_primitive(&create_args(&root, "skill", "triage")).await.unwrap();
        assert_eq!(res["committed"], json!(true));
        assert_eq!(res["commit_error"], json!(null));
        assert_eq!(git_capture(&root, &["log", "-1", "--pretty=%s"]), "create(skills/triage)");
    }

    #[tokio::test]
    async fn create_over_existing_name_is_409_mapped() {
        let (_tmp, root) = fixture_library();
        // `diagnose` is already scaffolded in the fixture — a name collision.
        let err = cmd_create_primitive(&create_args(&root, "skill", "diagnose")).await.unwrap_err();
        assert_eq!(
            err.code, "library_primitive_exists",
            "a name collision must be the 409 code, never bridge_command_failed (the 502 catch-all)"
        );
        // Through the FULL envelope (the tripwire): ok:false carrying that code.
        let env = handle(
            &json!({ "v": 1, "command": "create_primitive", "args": create_args(&root, "skill", "diagnose") })
                .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(false));
        assert_eq!(env["error"]["code"], json!("library_primitive_exists"));
    }

    #[tokio::test]
    async fn create_rejects_a_traversal_name_at_the_boundary() {
        let (_tmp, root) = fixture_library();
        // A `..`-laden name is rejected by PrimitiveName::try_new BEFORE any
        // path join — library_invalid_name, never a write outside the library.
        let err = cmd_create_primitive(&create_args(&root, "skill", "../evil")).await.unwrap_err();
        assert_eq!(err.code, "library_invalid_name");
    }

    #[tokio::test]
    async fn delete_removes_dir_and_records_and_commits() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        git_init_repo(&fx.root);
        git_commit_all(&fx.root, "init");

        let res = cmd_delete_primitive(&life_install_args(&fx)).await.unwrap();
        assert_eq!(res["library_dir_removed"], json!(true));
        assert_eq!(res["uninstall"]["failures"], json!([]));
        assert_eq!(res["committed"], json!(true));
        assert_eq!(git_capture(&fx.root, &["log", "-1", "--pretty=%s"]), "delete(skills/diagnose)");
        // Library dir gone; the install record dropped; the on-disk copy removed.
        assert!(!fx.root.join("skills/diagnose").exists());
        assert!(!claude_skill_file(&fx, "diagnose").exists());
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert!(installs.records.is_empty(), "delete must drop the install record");
    }

    #[tokio::test]
    async fn delete_with_a_wedged_target_bails_without_committing() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        git_init_repo(&fx.root);
        git_commit_all(&fx.root, "init");
        let head_before = git_capture(&fx.root, &["rev-parse", "HEAD"]);

        // Wedge the uninstall deterministically (no perms tricks): replace the
        // Skill's install DIRECTORY with a plain file, so force-uninstall's
        // `remove_dir_all` fails with ENOTDIR — a real per-target I/O failure.
        let install_dir = claude_skill_file(&fx, "diagnose").parent().unwrap().to_path_buf();
        std::fs::remove_dir_all(install_dir.as_std_path()).unwrap();
        std::fs::write(install_dir.as_std_path(), b"not a directory").unwrap();

        let res = cmd_delete_primitive(&life_install_args(&fx)).await.unwrap();
        // Core bailed before rm -rf: the failure rides back as DATA, the library
        // tree is untouched, and the bridge must NOT commit a non-change.
        assert_eq!(res["library_dir_removed"], json!(false));
        assert!(
            res["uninstall"]["failures"].as_array().is_some_and(|f| !f.is_empty()),
            "a wedged target must surface in uninstall.failures, got {res}"
        );
        assert_eq!(res["committed"], json!(false), "a bailed delete commits nothing");
        assert_eq!(res["commit_error"], json!(null));
        assert!(fx.root.join("skills/diagnose").exists(), "library dir must survive a bail");
        assert_eq!(
            git_capture(&fx.root, &["rev-parse", "HEAD"]),
            head_before,
            "HEAD must not advance when delete bails"
        );
    }

    #[tokio::test]
    async fn delete_missing_primitive_does_not_commit() {
        // The gate's false branch reached the benign way: no installs, dir gone.
        let fx = install_fx(vec![Target::Claude]);
        std::fs::remove_dir_all(fx.root.join("skills/diagnose").as_std_path()).unwrap();
        let res = cmd_delete_primitive(&life_install_args(&fx)).await.unwrap();
        assert_eq!(res["library_dir_removed"], json!(false));
        assert_eq!(res["committed"], json!(false));
        assert_eq!(res["commit_error"], json!(null));
    }

    #[tokio::test]
    async fn rename_moves_dir_migrates_records_and_commits() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        git_init_repo(&fx.root);

        let mut args = life_install_args(&fx);
        args["new_name"] = json!("triage");
        let res = cmd_rename_primitive(&args).await.unwrap();
        assert_eq!(res["install_records_updated"], json!(1), "the one claude record must be rewritten");
        assert_eq!(res["committed"], json!(true));
        assert_eq!(
            git_capture(&fx.root, &["log", "-1", "--pretty=%s"]),
            "rename(skills/diagnose -> triage)"
        );
        // Dir moved; install record now points at the new name.
        assert!(!fx.root.join("skills/diagnose").exists());
        assert!(fx.root.join("skills/triage").exists());
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert_eq!(installs.records[0].name.as_str(), "triage");
    }

    #[tokio::test]
    async fn rename_onto_existing_name_is_409() {
        let fx = install_fx(vec![Target::Claude]);
        // Scaffold a second primitive to collide with.
        scaffold_primitive(
            LibraryLayout::new(&fx.root),
            PrimitiveKind::Skill,
            &PrimitiveName::try_new("triage").unwrap(),
            NOW,
            None,
        )
        .unwrap();
        let mut args = life_install_args(&fx);
        args["new_name"] = json!("triage");
        assert_eq!(
            cmd_rename_primitive(&args).await.unwrap_err().code,
            "library_primitive_exists"
        );
    }

    #[tokio::test]
    async fn rename_missing_source_is_404() {
        let fx = install_fx(vec![Target::Claude]);
        let mut args = life_install_args(&fx);
        args["name"] = json!("ghost");
        args["new_name"] = json!("triage");
        assert_eq!(
            cmd_rename_primitive(&args).await.unwrap_err().code,
            "primitive_not_found"
        );
    }

    #[tokio::test]
    async fn rename_rejects_a_traversal_new_name() {
        let fx = install_fx(vec![Target::Claude]);
        let mut args = life_install_args(&fx);
        args["new_name"] = json!("../evil");
        assert_eq!(
            cmd_rename_primitive(&args).await.unwrap_err().code,
            "library_invalid_name"
        );
    }

    #[tokio::test]
    async fn duplicate_copies_working_without_versions_or_installs_and_commits() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx); // diagnose has a v1 + a claude install record
        git_init_repo(&fx.root);

        let mut args = create_args(&fx.root, "skill", "diagnose");
        args["home"] = json!(fx.home.as_str());
        args["installs_path"] = json!(fx.installs.as_str());
        args["new_name"] = json!("diagnose-copy");
        let res = cmd_duplicate_primitive(&args).await.unwrap();
        assert_eq!(res["new_name"], json!("diagnose-copy"));
        assert_eq!(res["committed"], json!(true));
        assert_eq!(
            git_capture(&fx.root, &["log", "-1", "--pretty=%s"]),
            "duplicate(skills/diagnose -> diagnose-copy)"
        );
        // Working copy carried; versions + install records did NOT.
        assert!(fx.root.join("skills/diagnose-copy/working/base/SKILL.md").exists());
        assert!(!fx.root.join("skills/diagnose-copy/versions").exists());
        assert!(!fx.root.join("skills/diagnose-copy/current.txt").exists());
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert!(
            installs.records.iter().all(|r| r.name.as_str() != "diagnose-copy"),
            "a duplicate must not inherit install records"
        );
    }

    #[tokio::test]
    async fn duplicate_onto_existing_name_is_409() {
        let fx = install_fx(vec![Target::Claude]);
        scaffold_primitive(
            LibraryLayout::new(&fx.root),
            PrimitiveKind::Skill,
            &PrimitiveName::try_new("taken").unwrap(),
            NOW,
            None,
        )
        .unwrap();
        let mut args = create_args(&fx.root, "skill", "diagnose");
        args["new_name"] = json!("taken");
        assert_eq!(
            cmd_duplicate_primitive(&args).await.unwrap_err().code,
            "library_primitive_exists"
        );
    }

    #[tokio::test]
    async fn import_a_skill_dir_under_an_install_root_scaffolds_and_commits() {
        let fx = install_fx(vec![Target::Claude]);
        git_init_repo(&fx.root);
        // A fresh Claude-side Skill NOT already in the library.
        let skill_dir = fx.home.join(".claude/skills/imported");
        std::fs::create_dir_all(skill_dir.as_std_path()).unwrap();
        std::fs::write(skill_dir.join("SKILL.md").as_std_path(), b"---\n---\nbody\n").unwrap();

        let res = cmd_import_primitive_from_path(&json!({
            "path": fx.root.as_str(), "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "source_path": skill_dir.as_str(), "created_at": NOW,
        }))
        .await
        .unwrap();

        assert_eq!(res["kind"], json!("imported"));
        assert_eq!(res["name"], json!("imported"));
        assert_eq!(res["committed"], json!(true));
        assert_eq!(git_capture(&fx.root, &["log", "-1", "--pretty=%s"]), "import(imported)");
        assert!(fx.root.join("skills/imported/working/base/SKILL.md").exists());
        // execute_creates writes an install record for the imported copy.
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert!(installs.records.iter().any(|r| r.name.as_str() == "imported"));
    }

    #[tokio::test]
    async fn import_a_path_outside_any_install_root_is_not_classifiable_and_does_not_mutate() {
        let fx = install_fx(vec![Target::Claude]);
        git_init_repo(&fx.root);
        git_commit_all(&fx.root, "init");
        let head_before = git_capture(&fx.root, &["rev-parse", "HEAD"]);

        // A traversal-laden path that is NOT under any SCAN_MATRIX install root
        // → NotClassifiable; the scaffold dest is (kind,name)-derived in-core,
        // so a `../` source can't redirect a write — it just fails to classify.
        let res = cmd_import_primitive_from_path(&json!({
            "path": fx.root.as_str(), "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "source_path": "../../etc/passwd", "created_at": NOW,
        }))
        .await
        .unwrap();

        assert_eq!(res["kind"], json!("not_classifiable"));
        assert!(res.get("committed").is_none(), "a non-import wrote nothing, so no commit fields");
        assert_eq!(
            git_capture(&fx.root, &["rev-parse", "HEAD"]),
            head_before,
            "NotClassifiable must not commit"
        );
    }

    #[tokio::test]
    async fn forget_drops_records_idempotently_and_never_commits() {
        let fx = install_fx(vec![Target::Claude]);
        install_diagnose_claude(&fx);
        // A record exists → first forget removes it.
        let res = cmd_forget_primitive(&life_install_args(&fx)).unwrap();
        assert_eq!(res["removed"], json!(true));
        assert!(res.get("committed").is_none(), "forget touches only installs.json — no commit fields");
        let installs = InstallsFile::load(&fx.installs).unwrap();
        assert!(installs.records.is_empty());
        // Idempotent: second forget finds nothing.
        let again = cmd_forget_primitive(&life_install_args(&fx)).unwrap();
        assert_eq!(again["removed"], json!(false));
    }

    // ---- bootstrap-discovery slice -----------------------------------------

    /// A library (`.prompt-library` marker) + a temp install home to plant scan
    /// candidates under + the dashboard-owned session/installs/backup paths. The
    /// single `TempDir` holds the whole tree alive; everything is canonicalized
    /// so it matches what `require_library` resolves to (macOS /var symlink).
    struct BootstrapFx {
        _tmp: TempDir,
        root: Utf8PathBuf,
        home: Utf8PathBuf,
        installs: Utf8PathBuf,
        session: Utf8PathBuf,
        backup_dir: Utf8PathBuf,
    }

    fn bootstrap_fx() -> BootstrapFx {
        let tmp = TempDir::new().unwrap();
        let base = Utf8PathBuf::from_path_buf(tmp.path().canonicalize().unwrap()).unwrap();
        let root = base.join("lib");
        init_library(&root, NOW).unwrap(); // missing dir → created + marker written
        let home = base.join("home");
        std::fs::create_dir_all(home.as_std_path()).unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(data.as_std_path()).unwrap();
        BootstrapFx {
            _tmp: tmp,
            root,
            home,
            installs: data.join("installs.json"),
            session: data.join("bootstrap-session.json"),
            backup_dir: data.join("backups"),
        }
    }

    /// Plant a Claude-skill scan candidate at `~/.claude/skills/<name>/SKILL.md`.
    fn plant_claude_skill(home: &Utf8PathBuf, name: &str, body: &[u8]) {
        let dir = home.join(".claude/skills").join(name);
        std::fs::create_dir_all(dir.as_std_path()).unwrap();
        std::fs::write(dir.join("SKILL.md").as_std_path(), body).unwrap();
    }

    fn scan_args(fx: &BootstrapFx) -> Value {
        json!({ "path": fx.root.as_str(), "home": fx.home.as_str() })
    }

    fn execute_args(fx: &BootstrapFx, plan: Value, excluded: Value) -> Value {
        json!({
            "path": fx.root.as_str(),
            "home": fx.home.as_str(),
            "installs_path": fx.installs.as_str(),
            "session_path": fx.session.as_str(),
            "backup_dir": fx.backup_dir.as_str(),
            "plan": plan,
            "excluded_ids": excluded,
            "created_at": NOW,
        })
    }

    fn session_args(fx: &BootstrapFx) -> Value {
        json!({ "session_path": fx.session.as_str() })
    }

    /// Drive a scan through the full envelope and return its derived `plan`.
    async fn scan_plan(fx: &BootstrapFx) -> Value {
        let env = handle(
            &json!({ "v": 1, "command": "bootstrap_scan", "args": scan_args(fx) }).to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "scan failed: {env:?}");
        env["data"]["plan"].clone()
    }

    #[tokio::test]
    async fn bootstrap_scan_returns_cross_referenced_and_derived_plan() {
        let fx = bootstrap_fx();
        plant_claude_skill(&fx.home, "newskill", b"---\n---\nbody\n");
        let env = handle(
            &json!({ "v": 1, "command": "bootstrap_scan", "args": scan_args(&fx) }).to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "{env:?}");
        let data = &env["data"];
        // The full classification rides the envelope (one group, classified New).
        assert_eq!(data["cross_referenced"]["groups"].as_array().unwrap().len(), 1);
        // derive_plan ran server-side: the New candidate → a create, no reimports.
        assert_eq!(data["plan"]["creates"].as_array().unwrap().len(), 1);
        assert_eq!(data["plan"]["reimports"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn bootstrap_execute_creates_writes_backup_and_commits() {
        let fx = bootstrap_fx();
        git_init_repo(&fx.root);
        plant_claude_skill(&fx.home, "newskill", b"---\n---\nbody\n");
        let plan = scan_plan(&fx).await;
        let env = handle(
            &json!({ "v": 1, "command": "bootstrap_execute", "args": execute_args(&fx, plan, json!([])) })
                .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "{env:?}");
        let data = &env["data"];
        assert_eq!(data["created"], json!(1));
        assert_eq!(data["reimported"], json!(0));
        assert_eq!(data["skipped"], json!(0));
        assert!(data["backup_path"].is_string(), "the safety tarball path is surfaced: {data:?}");
        // created > 0 → the commit-gating fired; the new version tree committed.
        assert_eq!(data["committed"], json!(true));
        assert_eq!(data["commit_error"], json!(null));
        assert_eq!(
            git_capture(&fx.root, &["log", "-1", "--pretty=%s"]),
            "bootstrap: created 1, reimported 0"
        );
        // The primitive now exists in the library at v1.
        assert_eq!(
            std::fs::read_to_string(fx.root.join("skills/newskill/current.txt").as_std_path())
                .unwrap()
                .trim(),
            "v1"
        );
    }

    #[tokio::test]
    async fn bootstrap_execute_reimports_a_drifted_candidate_to_v2() {
        let fx = bootstrap_fx();
        git_init_repo(&fx.root);
        // Library already has `diagnose` published at v1; the on-disk copy under
        // the home differs → cross-reference classifies it Drifted, not New.
        publish_skill(&fx.root, "diagnose", vec![Target::Claude]);
        plant_claude_skill(&fx.home, "diagnose", b"---\n---\nDRIFTED\n");
        let plan = scan_plan(&fx).await;
        assert_eq!(plan["creates"].as_array().unwrap().len(), 0, "{plan:?}");
        assert_eq!(plan["reimports"].as_array().unwrap().len(), 1, "{plan:?}");
        let env = handle(
            &json!({ "v": 1, "command": "bootstrap_execute", "args": execute_args(&fx, plan, json!([])) })
                .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "{env:?}");
        assert_eq!(env["data"]["reimported"], json!(1), "{:?}", env["data"]);
        assert_eq!(env["data"]["created"], json!(0));
        // The library advanced to v2 (the drifted bytes became a new version).
        assert_eq!(
            std::fs::read_to_string(fx.root.join("skills/diagnose/current.txt").as_std_path())
                .unwrap()
                .trim(),
            "v2"
        );
    }

    #[tokio::test]
    async fn bootstrap_execute_empty_plan_commits_nothing() {
        let fx = bootstrap_fx();
        git_init_repo(&fx.root);
        // Everything excluded in review → an empty plan writes nothing.
        let plan = json!({ "creates": [], "reimports": [] });
        let env = handle(
            &json!({ "v": 1, "command": "bootstrap_execute", "args": execute_args(&fx, plan, json!([])) })
                .to_string(),
        )
        .await;
        assert_eq!(env["ok"], json!(true), "{env:?}");
        let data = &env["data"];
        assert_eq!(data["created"], json!(0));
        assert_eq!(data["reimported"], json!(0));
        // Gating divergence from the reference: with nothing written, NO commit
        // fields are folded on...
        assert!(
            data.as_object().unwrap().get("committed").is_none(),
            "an empty run must not carry commit fields: {data:?}"
        );
        // ...and the repo has no commit at all (no empty "created 0" entry).
        assert_eq!(git_capture(&fx.root, &["rev-list", "--all", "--count"]), "0");
    }

    #[tokio::test]
    async fn bootstrap_session_read_absent_is_null_and_clear_is_idempotent() {
        let fx = bootstrap_fx();
        // No session yet → read is a 200 `null`, never a 404.
        let read = handle(
            &json!({ "v": 1, "command": "read_bootstrap_session", "args": session_args(&fx) })
                .to_string(),
        )
        .await;
        assert_eq!(read["ok"], json!(true), "{read:?}");
        assert_eq!(read["data"]["session"], json!(null));
        // Clear is idempotent: removing an absent session is ok, not an error.
        let clear = handle(
            &json!({ "v": 1, "command": "clear_bootstrap_session", "args": session_args(&fx) })
                .to_string(),
        )
        .await;
        assert_eq!(clear["ok"], json!(true), "{clear:?}");
    }

    #[tokio::test]
    async fn bootstrap_missing_injected_paths_are_config_faults() {
        let fx = bootstrap_fx();
        // home is route-injected → absent is a config fault, not a user error.
        let scan_err = cmd_bootstrap_scan(&json!({ "path": fx.root.as_str() })).unwrap_err();
        assert_eq!(scan_err.code, "installs_unconfigured");
        // session_path is route-injected → absent is its own config fault.
        let read_err = cmd_read_bootstrap_session(&json!({})).unwrap_err();
        assert_eq!(read_err.code, "bootstrap_unconfigured");
    }

    // ---- git remote sync (Slice 8, Phase 1: configure/PAT/status) ----------
    //
    // Phase 1 is the secrets break with NO network: configure_remote (validate
    // only — persistence is the TS route's job), set_pat/delete_pat, and
    // get_remote_status. Command bodies take an injected `&dyn SecretStore` so a
    // single `InMemoryStore` round-trips set→get→delete within one test, without
    // a process-global the parallel test threads would race (D2). The real
    // KeychainStore is never touched by `cargo test`.

    /// A known FAKE PAT — never a real credential, never sent anywhere. Long
    /// enough that `redact_pat` keeps the prefix + last 4 (its `< 8` branch).
    const FIXTURE_PAT: &str = "ghp_TESTtoken0123456789abcdefghijklmnop";

    #[test]
    fn configure_remote_returns_normalized_url() {
        // Uppercase host is lowercased; surrounding whitespace trimmed.
        let data = cmd_configure_remote(&json!({ "url": "  https://GitHub.com/owner/Repo  " }))
            .unwrap();
        assert_eq!(data["remote_url"], json!("https://github.com/owner/Repo"));
    }

    #[test]
    fn configure_remote_rejects_each_url_error_as_invalid_remote_url() {
        // Every RemoteUrlError variant funnels to the one route-mappable code;
        // the specific reason rides `detail` (server-side only, m4).
        for bad in [
            "",                                   // Empty
            "http://github.com/o/r",              // NonHttps
            "https://x-access-token@github.com/o/r", // EmbeddedCredentials
            "https://github.com/o r",             // Whitespace
            "https://gitlab.com/o/r",             // HostNotAllowed
            "https://github.com",                 // MissingPath
        ] {
            let err = cmd_configure_remote(&json!({ "url": bad })).unwrap_err();
            assert_eq!(err.code, "invalid_remote_url", "url={bad:?}");
        }
    }

    #[test]
    fn set_pat_rejects_empty() {
        let store = InMemoryStore::new();
        let err = cmd_set_pat(&json!({ "pat": "" }), &store).unwrap_err();
        assert_eq!(err.code, "empty_pat");
        // missing key behaves like empty
        let err = cmd_set_pat(&json!({}), &store).unwrap_err();
        assert_eq!(err.code, "empty_pat");
        // and nothing was stored
        assert_eq!(store.get_pat().unwrap(), None);
    }

    #[test]
    fn set_then_get_status_round_trips_only_the_redacted_form() {
        let store = InMemoryStore::new();
        cmd_set_pat(&json!({ "pat": FIXTURE_PAT }), &store).unwrap();

        let data = cmd_get_remote_status(
            &json!({ "remote_url": "https://github.com/owner/repo" }),
            &store,
        )
        .unwrap();

        // remote_url is a passthrough of the TS-injected arg.
        assert_eq!(data["remote_url"], json!("https://github.com/owner/repo"));
        // the ONLY PAT form on the wire is the redacted one.
        assert_eq!(data["pat_redacted"], json!(redact_pat(FIXTURE_PAT)));
    }

    #[test]
    fn get_remote_status_never_serializes_the_raw_pat() {
        // D6 tripwire: plant a known PAT, serialize the whole response, assert
        // the raw token never appears anywhere in it.
        let store = InMemoryStore::new();
        cmd_set_pat(&json!({ "pat": FIXTURE_PAT }), &store).unwrap();
        let data =
            cmd_get_remote_status(&json!({ "remote_url": Value::Null }), &store).unwrap();
        let serialized = serde_json::to_string(&data).unwrap();
        assert!(
            !serialized.contains(FIXTURE_PAT),
            "raw PAT leaked into the response: {serialized}"
        );
        // remote_url null (not configured) round-trips as null.
        assert_eq!(data["remote_url"], json!(null));
        assert_eq!(data["pat_redacted"], json!(redact_pat(FIXTURE_PAT)));
    }

    #[test]
    fn get_remote_status_reports_no_pat_as_null() {
        let store = InMemoryStore::new();
        let data = cmd_get_remote_status(
            &json!({ "remote_url": "https://github.com/owner/repo" }),
            &store,
        )
        .unwrap();
        assert_eq!(data["pat_redacted"], json!(null));
    }

    #[test]
    fn delete_pat_is_idempotent_and_clears_stored_token() {
        let store = InMemoryStore::new();
        // delete with nothing stored is ok (idempotent).
        assert!(cmd_delete_pat(&store).is_ok());
        // set, then delete, then status reports null.
        cmd_set_pat(&json!({ "pat": FIXTURE_PAT }), &store).unwrap();
        cmd_delete_pat(&store).unwrap();
        let data =
            cmd_get_remote_status(&json!({ "remote_url": Value::Null }), &store).unwrap();
        assert_eq!(data["pat_redacted"], json!(null));
    }

    #[test]
    fn secret_store_selects_memory_via_arg() {
        // The `secret_store: "memory"` arg yields a store that set/get round-
        // trips without ever touching the keychain (so `cargo test` is headless).
        let store = secret_store(&json!({ "secret_store": "memory" })).unwrap();
        store.set_pat(FIXTURE_PAT).unwrap();
        assert_eq!(store.get_pat().unwrap().as_deref(), Some(FIXTURE_PAT));
    }

    #[test]
    fn secret_store_selects_memory_via_env() {
        // The env flag is the dev/test convenience; the route uses the arg.
        // SAFETY: set+remove synchronously; no test exercises the keychain
        // default, so a transient read by a parallel test is harmless.
        std::env::set_var("CC_LIBRARY_SECRET_STORE", "memory");
        let store = secret_store(&json!({}));
        std::env::remove_var("CC_LIBRARY_SECRET_STORE");
        assert!(store.is_ok());
    }

    #[tokio::test]
    async fn dispatch_wires_the_git_sync_arms() {
        // Arms are reachable through dispatch and select the memory store, so no
        // keychain prompt in `cargo test`. Cross-process persistence is the
        // keychain's job (verified in Phase 0), not InMemoryStore's, so this
        // asserts WIRING, not round-trip.
        let cfg = dispatch(
            "configure_remote",
            &json!({ "url": "https://github.com/owner/repo" }),
        )
        .await
        .unwrap();
        assert_eq!(cfg["remote_url"], json!("https://github.com/owner/repo"));

        let empty = dispatch("set_pat", &json!({ "pat": "", "secret_store": "memory" }))
            .await
            .unwrap_err();
        assert_eq!(empty.code, "empty_pat");

        let status = dispatch(
            "get_remote_status",
            &json!({ "remote_url": "https://github.com/owner/repo", "secret_store": "memory" }),
        )
        .await
        .unwrap();
        assert_eq!(status["pat_redacted"], json!(null));
    }

    // ---- git remote sync (Slice 8, Phase 2: scan/push/pull/conflict) -------
    //
    // Exercised against a temp BARE remote on a local path — `git push`/`pull`
    // to a `file://`-style local remote needs no auth, so these verify the
    // command MECHANICS (range selection, first-push -u, the stateful rebase
    // loop) without a real network or a real credential. The real-PAT egress is
    // Phase 4 browser QA. The PAT-never-leaks tripwire still runs here (a forced
    // push failure with a PAT in the store).

    // (`run_git(&Utf8PathBuf, …)` is the shared test git driver, defined above.)

    /// Give a repo a deterministic local identity so bridge-driven commits
    /// (rebase replays) have a committer regardless of the dev machine config.
    fn set_identity(dir: &Utf8PathBuf, who: &str) {
        run_git(dir, &["config", "user.email", &format!("{who}@example.test")]);
        run_git(dir, &["config", "user.name", who]);
    }

    /// A library repo wired to a temp bare remote on a local path, plus an
    /// askpass dir. Temps held so they outlive the test.
    struct GitSyncFx {
        _remote: TempDir,
        _work: TempDir,
        _askpass: TempDir,
        root: Utf8PathBuf,
        remote: Utf8PathBuf,
        askpass_dir: Utf8PathBuf,
    }

    impl GitSyncFx {
        /// Base args every git-sync command needs: the library path, the
        /// injected askpass dir, and the memory secret store (headless).
        fn args(&self) -> Value {
            json!({
                "path": self.root.as_str(),
                "askpass_dir": self.askpass_dir.as_str(),
                "secret_store": "memory",
            })
        }
        /// Args for a conflict-family command: library path + the conflict path
        /// (under its own key, not `path`) + the side.
        fn conflict_args(&self, conflict_path: &str, side: &str) -> Value {
            json!({ "path": self.root.as_str(), "conflict_path": conflict_path, "side": side })
        }
    }

    fn git_sync_fx() -> GitSyncFx {
        let remote_tmp = TempDir::new().unwrap();
        let remote = Utf8PathBuf::from_path_buf(remote_tmp.path().canonicalize().unwrap()).unwrap();
        run_git(&remote, &["-c", "init.defaultBranch=main", "init", "--bare"]);

        let work = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(work.path().canonicalize().unwrap()).unwrap();
        init_library(&root, NOW).unwrap();
        run_git(&root, &["-c", "init.defaultBranch=main", "init"]);
        set_identity(&root, "Worker");
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-m", "init library"]);
        run_git(&root, &["remote", "add", "origin", remote.as_str()]);

        let askpass = TempDir::new().unwrap();
        let askpass_dir =
            Utf8PathBuf::from_path_buf(askpass.path().canonicalize().unwrap()).unwrap();
        GitSyncFx {
            _remote: remote_tmp,
            _work: work,
            _askpass: askpass,
            root,
            remote,
            askpass_dir,
        }
    }

    fn pat_store() -> InMemoryStore {
        let store = InMemoryStore::new();
        store.set_pat(FIXTURE_PAT).unwrap();
        store
    }

    #[test]
    fn classify_conflict_path_maps_known_layout_paths() {
        assert_eq!(classify_conflict_path("skills/x/current.txt"), "current_txt");
        assert_eq!(classify_conflict_path("skills/x/metadata.yaml"), "metadata_yaml");
        assert_eq!(
            classify_conflict_path("skills/x/versions/v1/SKILL.md"),
            "version_file"
        );
        assert_eq!(classify_conflict_path("README.md"), "other");
    }

    #[tokio::test]
    async fn scan_before_push_flags_a_planted_secret() {
        let fx = git_sync_fx();
        // a classic PAT token committed to a tracked file — never pushed.
        let token = format!("ghp_{}", "a".repeat(36));
        std::fs::write(fx.root.join("CLAUDE.md"), &token).unwrap();
        run_git(&fx.root, &["add", "-A"]);
        run_git(&fx.root, &["commit", "-m", "oops secret"]);

        let data = cmd_scan_before_push(&fx.args()).await.unwrap();
        let findings = data["findings"].as_array().unwrap();
        assert!(!findings.is_empty(), "expected the gate to flag the token");
        assert!(findings
            .iter()
            .any(|f| f["kind"] == json!("github_classic_pat")));
    }

    #[tokio::test]
    async fn count_unpushed_counts_local_commits_then_zero_after_push() {
        let fx = git_sync_fx();
        // one commit ahead of a never-pushed branch (empty-tree range).
        let before = cmd_count_unpushed_commits(&fx.args()).await.unwrap();
        assert_eq!(before["count"], json!(1));

        cmd_push_now(&fx.args(), &pat_store()).await.unwrap();
        let after = cmd_count_unpushed_commits(&fx.args()).await.unwrap();
        assert_eq!(after["count"], json!(0), "everything pushed");
    }

    #[tokio::test]
    async fn count_unpushed_is_zero_when_not_a_git_repo() {
        // a library with the marker but no `.git`.
        let (_tmp, root) = fixture_library();
        let data = cmd_count_unpushed_commits(&json!({ "path": root.as_str() }))
            .await
            .unwrap();
        assert_eq!(data["count"], json!(0));
    }

    #[tokio::test]
    async fn push_now_first_push_sets_upstream_and_publishes() {
        let fx = git_sync_fx();
        // first push: no upstream → -u origin main. Succeeds against the local
        // bare remote (no auth needed); the stored PAT is set but unused.
        cmd_push_now(&fx.args(), &pat_store()).await.unwrap();
        // origin/main now exists locally → a second push takes the plain path.
        cmd_push_now(&fx.args(), &pat_store()).await.unwrap();
    }

    #[tokio::test]
    async fn push_now_without_pat_is_no_pat_stored() {
        let fx = git_sync_fx();
        let empty = InMemoryStore::new();
        let err = cmd_push_now(&fx.args(), &empty).await.unwrap_err();
        assert_eq!(err.code, "no_pat_stored");
    }

    #[tokio::test]
    async fn push_failure_never_leaks_the_pat() {
        // D6 tripwire on the egress path: force a push failure with a PAT in the
        // store, assert the token appears nowhere in the error envelope.
        let fx = git_sync_fx();
        run_git(
            &fx.root,
            &["remote", "set-url", "origin", "/nonexistent/repo.git"],
        );
        std::fs::write(fx.root.join("f.txt"), "x").unwrap();
        run_git(&fx.root, &["add", "-A"]);
        run_git(&fx.root, &["commit", "-m", "c"]);

        let err = cmd_push_now(&fx.args(), &pat_store()).await.unwrap_err();
        assert_eq!(err.code, "git_failed");
        let serialized = serde_json::to_string(&err_envelope(&err)).unwrap();
        assert!(
            !serialized.contains(FIXTURE_PAT),
            "PAT leaked into the error envelope: {serialized}"
        );
    }

    #[tokio::test]
    async fn pull_clean_fast_forward_returns_ok() {
        let fx = git_sync_fx();
        cmd_push_now(&fx.args(), &pat_store()).await.unwrap();
        // a clean pull (nothing new on the remote) is a no-op `ok`.
        let data = cmd_pull_now(&fx.args(), &pat_store()).await.unwrap();
        assert_eq!(data["outcome"], json!("ok"));
    }

    /// Drive two clones to a rebase conflict on `notes.txt` and leave fx mid-
    /// rebase (paused). Returns fx; the second clone is `.keep()`-leaked so its
    /// path stays valid for the test's duration.
    async fn pull_into_conflict() -> GitSyncFx {
        let fx = git_sync_fx();
        std::fs::write(fx.root.join("notes.txt"), "base\n").unwrap();
        run_git(&fx.root, &["add", "-A"]);
        run_git(&fx.root, &["commit", "-m", "base notes"]);
        cmd_push_now(&fx.args(), &pat_store()).await.unwrap();

        // clone B, change the same line, push first.
        let b = Utf8PathBuf::from_path_buf(TempDir::new().unwrap().keep()).unwrap();
        run_git(&fx.remote, &["clone", fx.remote.as_str(), b.as_str()]);
        set_identity(&b, "Other");
        std::fs::write(b.join("notes.txt"), "remote-change\n").unwrap();
        run_git(&b, &["add", "-A"]);
        run_git(&b, &["commit", "-m", "remote change"]);
        run_git(&b, &["push", "origin", "main"]);

        // A diverges on the same line, then pulls --rebase → conflict.
        std::fs::write(fx.root.join("notes.txt"), "local-change\n").unwrap();
        run_git(&fx.root, &["add", "-A"]);
        run_git(&fx.root, &["commit", "-m", "local change"]);

        let pull = cmd_pull_now(&fx.args(), &pat_store()).await.unwrap();
        assert_eq!(pull["outcome"], json!("conflict"), "{pull:?}");
        assert_eq!(pull["conflict_count"], json!(1));
        fx
    }

    #[tokio::test]
    async fn pull_conflict_resolves_local_and_continues_to_done() {
        let fx = pull_into_conflict().await;
        assert_eq!(cmd_is_pull_paused(&fx.args()).unwrap()["paused"], json!(true));

        let conflicts = cmd_list_pull_conflicts(&fx.args()).await.unwrap();
        let list = conflicts["conflicts"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["path"], json!("notes.txt"));
        assert_eq!(list[0]["kind"], json!("other"));

        // Local = the user's change (stage 3 during rebase); Remote = incoming.
        let local = cmd_read_conflict_blob(&fx.conflict_args("notes.txt", "local"))
            .await
            .unwrap();
        assert_eq!(local["content"], json!("local-change\n"));
        let remote = cmd_read_conflict_blob(&fx.conflict_args("notes.txt", "remote"))
            .await
            .unwrap();
        assert_eq!(remote["content"], json!("remote-change\n"));

        cmd_resolve_conflict(&fx.conflict_args("notes.txt", "local"))
            .await
            .unwrap();
        let cont = cmd_continue_pull(&fx.args()).await.unwrap();
        assert_eq!(cont["outcome"], json!("done"));
        assert_eq!(cmd_is_pull_paused(&fx.args()).unwrap()["paused"], json!(false));
        // the working tree carries the chosen (local) side.
        assert_eq!(
            std::fs::read_to_string(fx.root.join("notes.txt")).unwrap(),
            "local-change\n"
        );
    }

    #[tokio::test]
    async fn pull_conflict_abort_unwinds_to_pre_pull_state() {
        let fx = pull_into_conflict().await;
        cmd_abort_pull(&fx.args()).await.unwrap();
        assert_eq!(cmd_is_pull_paused(&fx.args()).unwrap()["paused"], json!(false));
        // back to A's pre-pull commit.
        assert_eq!(
            std::fs::read_to_string(fx.root.join("notes.txt")).unwrap(),
            "local-change\n"
        );
    }

    #[tokio::test]
    async fn read_conflict_blob_requires_a_conflict_path() {
        let fx = git_sync_fx();
        let err = cmd_read_conflict_blob(&json!({ "path": fx.root.as_str(), "side": "local" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, "conflict_path_missing");
    }

    #[tokio::test]
    async fn conflict_side_must_be_local_or_remote() {
        let fx = git_sync_fx();
        let err = cmd_resolve_conflict(&fx.conflict_args("notes.txt", "sideways"))
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid_conflict_side");
    }

    #[tokio::test]
    async fn push_without_askpass_dir_is_a_config_fault() {
        // askpass_dir is route-injected → absent is a config fault, not a user
        // error. (Checked after the PAT precondition.)
        let fx = git_sync_fx();
        let err = cmd_push_now(
            &json!({ "path": fx.root.as_str() }),
            &pat_store(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "askpass_unconfigured");
    }
}
