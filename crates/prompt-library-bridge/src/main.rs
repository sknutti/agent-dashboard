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
//! `list_primitives`, `primitive_detail`. Drift / install-records are
//! deferred (Option A / C2 in the plan — no installs source in the read slice).
//!
//! Invariants:
//! - **stdout carries protocol bytes only.** All diagnostics go to stderr. A
//!   stray stdout write corrupts the stream (the classic stdio-bridge bug).
//! - **main is infallible at the envelope level.** Expected application errors
//!   serialize as `{ok:false,...}` and STILL exit 0; non-zero exit + stderr is
//!   reserved for genuine panics/crashes, so "not found" stays distinguishable
//!   from "the binary crashed."
//! - **no network, no secrets on the read path.** The crate does not depend on
//!   prompt-library-secrets at all (a SecretStore is unconstructible), and the
//!   read commands never touch core's reqwest-backed url_import.
//! - **current_thread runtime only** — the read fns touch std::fs; only the
//!   git status calls are async. No multi-thread worker pool per one-shot call.

use std::io::{Read, Write};

use camino::Utf8PathBuf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use prompt_library_core::{
    detail::read_primitive_detail, listing::list_primitives, Error as CoreError, KindInfoTable,
    LibraryLayout, PrimitiveKind, PrimitiveName, Target,
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
    // M3: bind the untrusted `:name` through the validating constructor —
    // `try_new` rejects `..`, `/`, `\`, leading dots (≤64, [A-Za-z0-9._-]),
    // so traversal payloads become `library_invalid_name`, never a path join.
    let name_str = args.get("name").and_then(Value::as_str).unwrap_or("");
    let name = PrimitiveName::try_new(name_str).map_err(map_core_error)?;
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
        // Write-side variants can't arise on the read path; anything else is a
        // genuine bridge bug, not a known application state.
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
    use prompt_library_core::{library_init::init_library, scaffold::scaffold_primitive};
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

    #[tokio::test]
    async fn error_message_carries_no_filesystem_path() {
        // m4: `message` is path-free; only `detail` may carry the path.
        let env = handle(r#"{"v":1,"command":"list_primitives","args":{"path":"/no/such/lib"}}"#).await;
        let message = env["error"]["message"].as_str().unwrap();
        assert!(!message.contains('/'), "message leaked a path: {message}");
    }
}
