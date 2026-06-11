# Dashboard replaces the standalone Prompt Library app; install-state ownership and location

The Library consolidation track ([ADR-0007](0007-prompt-library-rust-command-bridge.md)) brings the Prompt Library Rust crates into the dashboard behind a command bridge. This ADR settles two questions ADR-0007 left implicit: whether the standalone Prompt Library desktop app keeps running alongside the dashboard, and where the dashboard's install state (`installs.json`) lives. The answers shape the read-only first slice, so they are decided before Phase 1 of the [read-only slice plan](../plans/2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md).

The short version: the dashboard **replaces** the standalone app rather than coexisting with it, the dashboard becomes the **sole installer** and owns `installs.json` at a dashboard-controlled path, and because a read-only dashboard installs nothing, **Drift** and **Install records** are deferred out of the first slice rather than rendered against empty or borrowed state.

## Status

accepted

## Context

In the reference Prompt Library, install state lives in `installs.json` — an `InstallsFile { format_version, records }` where each `InstallRecord` is keyed by `(Kind, name, Target)` and carries the installed **Version**, per-file content hashes, mtimes, and an install timestamp (`crates/core/src/install_state.rs`). The standalone app persists it under the Tauri `app_data_dir` and scans for **Drift** against `InstallPaths`, rooted at the real user home and resolving to `~/.claude/...`, `~/.pi/agent/...`, `~/.codex/...` (`crates/core/src/install_paths.rs`). Drift is a live comparison of those records against the bytes currently on disk: Clean, Modified, or Missing. `installs.json` is therefore **per-machine deployment state, not Library content** — it is versioned, atomically written, and `fd-lock`'d precisely because it is authoritative mutable state about one machine.

ADR-0007 said the standalone app "remains a reference implementation until dashboard parity, not a required dependency," and listed Install records and Drift among the first read-only slice's read models. Two gaps follow. First, "reference until parity" did not say what happens *at* parity — coexist or replace — and that determines whether the dashboard may ever read the standalone app's `installs.json`. Second, `scan_library_drift` requires an `&InstallsFile` whose location is a Tauri `app_data_dir` concept with no dashboard equivalent, so the dashboard has no defined home for install state. A read-only dashboard installs nothing, so any dashboard-owned `installs.json` is empty and Drift computed from it is vacuous; the only populated `installs.json` today belongs to the standalone app.

## Decision

The dashboard **replaces** the standalone Prompt Library app. The standalone Tauri app remains a reference implementation through consolidation and is **retired at parity**, not run alongside the dashboard long-term. There is one installer and one source of install truth.

In the consolidated end-state the **dashboard is the sole installer** and **owns `installs.json`**. It lives at `DATA_DIR/installs.json` (next to the dashboard's SQLite database, per the `scripts/paths.ts` convention), overridable for development via `CC_LIBRARY_INSTALLS_PATH`. The `InstallPaths` root (`home`) defaults to the real user home and is overridable via `CC_LIBRARY_HOME` so tests can inject a temporary root. Install state stays file-backed and is read and written exclusively through the Rust core, consistent with ADR-0007's rule that all Library writes go through Rust; the dashboard does not reimplement install logic or move install state into SQLite.

The standalone app's existing `installs.json` is treated as a **one-time migration source** when the dashboard gains write/install flows — read once, migrated into `DATA_DIR/installs.json`, after which the standalone app is retired. It is never an ongoing runtime source for the dashboard, consistent with ADR-0007's rejection of depending on the sibling checkout at runtime.

Because of the above, the **read-only first slice cuts Drift and Install records**. The v1 bridge command set is `library_status`, `list_primitives`, and `primitive_detail`; `scan_drift` is not wired. **Primitive** detail still surfaces **Working copy**, **Versions**, and metadata-declared allowed **Targets** (all Library content), plus lightweight git status — but not per-target Install records or Drift, which require the per-machine deploy state the read-only dashboard does not own. Drift and Install records return with the write-flow slice, against real dashboard-owned install state.

This **amends ADR-0007's first-slice read list**, which named Install records and Drift. ADR-0007 otherwise stands; this ADR narrows that one sentence and records the replacement and ownership decisions it did not make.

## Considered and rejected

- Coexist with the standalone app long-term. Rejected because two installers would write two `installs.json` files that diverge, and Drift would depend on which app last installed a **Primitive**; consolidation should converge on one source of install truth, not maintain two.
- Store install state Library-relative (inside the Library directory or `.prompt-library`). Rejected because `installs.json` is per-machine deployment state, not Library content; a git-synced Library would carry one machine's records, hashes, and mtimes to another, where they are meaningless and would report false Drift.
- Read the standalone app's `app_data_dir/installs.json` as an ongoing source for the dashboard. Rejected because it couples the dashboard to a being-retired app's private, platform-specific state across the boundary ADR-0007 kept clean; reading it is acceptable only as a one-time migration, not a live dependency.
- Keep Drift and Install records in the read-only slice by pointing at an empty dashboard-owned `installs.json`. Rejected because a read-only dashboard installs nothing, so every Primitive would read "not installed" and Drift would be vacuous; building that UI against empty data is misleading and wasted until write flows exist.
- Move install state into dashboard SQLite. Rejected because install state is file-backed state the Rust core owns with atomic writes and an `fd-lock` advisory lock; SQLite would mean reimplementing install and Drift semantics outside Rust and contradicts ADR-0007's decision that Library/install writes go through the Rust core.
- Hardcode the `InstallPaths` home to the user's home directory. Rejected because tests need to inject a temporary root; `CC_LIBRARY_HOME` provides the override while the user home remains the default.
- Hardcode `installs.json` to a single path. Rejected for the same reason ADR-0007 made the bridge binary path configurable: dev and packaged environments differ, so `CC_LIBRARY_INSTALLS_PATH` overrides while `DATA_DIR/installs.json` stays the default.
- Keep ADR-0007's read list unchanged and force Drift into v1. Rejected because that read list predated the realization that install state has no read-only home; amending one sentence is cleaner than shipping vacuous Drift to honor a stale gate.

## Consequences

- The v1 Library route shows Library content — status, list, and Primitive detail (Working copy, Versions, allowed Targets, git status) — but no Drift or per-target Install records. The Variant B layout keeps those slots for later or drops them from the v1 markup.
- The v1 bridge exposes `library_status`, `list_primitives`, and `primitive_detail` only; `scan_drift` and any installs config (`CC_LIBRARY_INSTALLS_PATH`, `CC_LIBRARY_HOME`) arrive with the write-flow slice.
- A future write-flow slice makes the dashboard the sole installer, introduces `DATA_DIR/installs.json` and the install root, performs a one-time migration of the standalone app's `installs.json`, and retires the standalone app.
- Colorblind-safe status cues still apply to the cues that remain in v1 (the `dirty` flag and git status) and to Drift states when they return.
- ADR-0007's first read-only slice is complete on list/detail read models; Drift is no longer part of that gate.
