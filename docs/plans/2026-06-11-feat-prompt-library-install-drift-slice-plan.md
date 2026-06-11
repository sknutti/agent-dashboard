# Prompt Library Consolidation — Install/Drift Write-Flow Slice — Implementation Plan

- **Date:** 2026-06-11
- **Type:** feat
- **ADR:** [docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md) — **Amendment (2026-06-11): write-flow slice scope + drift delivery** (this plan implements that amendment)
- **Builds on:** [the read-only slice](2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md) (shipped — PR #4). All read seams it created are reused, not rebuilt.
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Install record · Drift · Target · Version · Working copy
- **Reference crates:** `~/side_projects/playground/prompt-library/crates/core` (install/drift source of truth) and `~/side_projects/playground/prompt-library/src-tauri/src/commands.rs:856-990` (the Tauri command bodies to port, minus `AppHandle`/`State`).

## Enhancement summary (deepened 2026-06-11)

Deepened with 8 parallel agents reading both repos at source (repo-research, security, data-integrity,
reliability, performance, correctness, frontend-races, external best-practices). **Verdict: the plan's
architecture is sound** — reusing core's atomic-write + fd-lock + pre-flight-abort, two-phase confirm,
format-guarded refuse-on-import, and global batch drift all match current best practice and were
independently validated. But the move from a **single-process desktop app** to a **process-per-request
localhost dashboard** newly exposes concurrency gaps that did not exist in the source, and several UI
write-path races and a handful of safety *claims stated more strongly than the code supports*. Nine items
below must change before/during implementation; per-phase corrections are inlined in **Critical findings**.

Headline (each independently found by ≥1 agent; the first by **three**):
1. **Concurrent-writer lost-update (must fix).** fd-lock guards `installs.json`'s `save()` only — **not** the
   `load→mutate→save` cycle. Two overlapping install POSTs to different primitives can clobber each other's
   records. Fix: a **route-level async write mutex** serializing all ledger writers in the Bun parent.
2. **Two-phase dialog can overwrite the WRONG primitive (must fix).** If selection changes across the
   confirm `await`, `force:true` fires against whatever is selected *now*, not what the dialog warned about.
   Fix: a **captured-intent snapshot** + a **pending-write lock**; together ~30 lines that also kill four
   other UI races.
3. **Install is non-atomic across targets.** Target bytes are written before the single end-of-loop
   `installs.json` save, so a killed/failed-save install orphans on-disk files with no record. Needs a
   distinct code + a reconcile/adopt recovery path (don't make the user "overwrite" the dashboard's own
   half-written files), not a claim that atomic-write covers it.
4. **Batch drift as written is O(N²)** — `scan_drift_for_primitive` reloads the whole file per primitive.
   `scan_record` over the once-loaded records is O(N) and already exported; promote it from fallback to
   default. (Core already mtime-gates hashing, so steady-state is stat-bound, not hash-bound.)

## Critical findings from deepening (resolve before / during implementation)

### D1 — Serialize ledger writers at the route layer (concurrency; found by reliability + data-integrity + best-practices)
`installer::install` does `InstallsFile::load` (no lock) → mutate in memory → `installs.save` (lock held only
*inside* `save`, `install_state.rs:130`). Two concurrent bridge processes both load the same snapshot and the
second `save` drops the first's record — a lost update, well-formed file, silent. fd-lock prevents *torn*
files, not *stale-overwrite* files. This was impossible in the single-process desktop app; process-per-request
makes it the expected case. **Fix:** add a process-wide async mutex / single-flight queue in
`scripts/library_routes.ts` that every **write** handler (`install`, `uninstall`, `acknowledge_drift`,
`import_installs`) acquires before spawning the bridge and releases after exit. Reads (`scan_drift_batch`,
`list_installs_for_primitive`) skip it (atomic rename gives them a consistent whole-file snapshot). **Correct
the plan's "no new mechanism needed" claim (Phase 3 line ~130 / risks line ~180): that is true for *security*,
false for *write correctness*.** Test: two concurrent installs of different primitives → both records survive.

### D2 — Capture-intent snapshot + pending-write lock for all UI writes (frontend races; CRITICAL)
The two-phase confirm lives outside `resource()` in bare handlers. Across the confirm `await` the user can
re-select a primitive (or the 30s poll re-paints) and `force:true` then overwrites a file they never saw
warned — "the dialog said `deploy-prod`, the write hit `format-csv`." `resource()`'s nonce gate correctly
protects the *read* path (verified) but does nothing for writes. **Two edits fix five races:**
- **Captured-intent snapshot:** at dialog-open store `{kind,name,target,conflicts}` in `$state`; confirm
  re-calls `installPrimitive(snapshot.kind, snapshot.name, {targets:[snapshot.target], force:true})` reading
  **only** the snapshot; render `snapshot.name`/`target` in the dialog header so what's read is what's written.
- **Pending-write lock** keyed `(kind,name,target)`, set on dispatch, cleared in **`.finally()`** (not
  `.then`, or a rejected write strands the row disabled): disable that row's actions while in flight, refuse a
  duplicate dispatch, and block primitive-switching while a write to the current primitive is in flight. This
  subsumes: double-fire same target, stacked/clobbered dialogs (make the dialog a singleton `$state<…|null>`),
  the Import double-click TOCTOU (disable while importing), and the stale-reload gap in D-fr below.

### D3 — Install is non-atomic across targets; surface + recover, don't hide (reliability + data-integrity)
`install` writes each target's bytes immediately (atomic per file) but calls `installs.save` **once** after the
target loop (`installer.rs:164`). A mid-loop process kill, or a `save` that fails *after* a successful
byte-write, leaves files on disk that the ledger has **no record of** → they read as drift-`Missing`/orphaned;
the next install sees them as `CollidingContent` (the user is asked to "overwrite" the dashboard's own
files). **Fix:** (a) state explicitly install is not atomic across targets; (b) map a post-write `save`
failure to a distinct `installs_save_failed` so the UI says "installed but not recorded — re-run to record"
(re-install yields `no_op_identical` **and** records the row — self-healing, document it); (c) treat an
unrecorded-but-present install as a recoverable "adopt/reinstall" state, not a raw conflict; (d) add a
kill-mid-batch Phase-1 test. This is pre-existing core behavior, newly user-visible — not a core fix this slice.

### D4 — Distinct write timeout + SIGKILL (reliability + best-practices)
Writes currently inherit the **10 s read watchdog**; killing a slow *read* was free, killing a *write* is
exactly D3. **Fix:** give write commands a larger `timeoutMs` (≥30 s, chosen so a healthy fs write never hits
it) and set **`killSignal:"SIGKILL"`** on write spawns (Bun's default is SIGTERM with no escalation, which a
child could trap mid-write; SIGKILL can't be trapped, and atomic-rename makes the dead write safe at the file
level). Confirmed: a SIGKILL'd process releases the OS fd-lock on exit (not leaked) and leaves at most a
harmless orphan `.tmp`. State in Phase 1 that **a killed bridge leaves the ledger + target files intact
*because the Rust child writes atomically*** — that is the safety argument for the whole slice. Check whether
the existing `runBridge` already `.end()`s stdin / tolerates EPIPE / sets killSignal (`library_bridge.ts:135`).

### D5 — Scope `force:true` to colliding targets only; render `failures` (correctness; HIGH)
`InstallSummary.successes` mixes outcomes across targets. The plan's "if the response contains a
`colliding_content`, re-call with `force:true`" is underspecified: re-forcing the **whole** target set
re-overwrites already-clean targets and retries genuine pre-flight `failures` that `force` does **not** resolve
(`OccupiedByUnexpectedKind` is a dir-vs-file mismatch, not colliding content). Also `summary.failures`
(`TargetFailure`/`InstallFailureKind`) is parsed but **never rendered** — a failed target silently vanishes.
**Fix:** force re-call targets **only** the subset whose `outcome.kind==="colliding_content"` (uninstall:
`"drifted"`); add a `failureCue` and render `failures` as a route-local per-target list; never offer
overwrite-confirm on `OccupiedByUnexpectedKind`/`Io`. Test a mixed summary (installed + colliding + Io
failure) drives exactly one scoped force re-call.

### D6 — Migration hardening (data-integrity + reliability)
- **"Refuse if exists" → "refuse if dest has ≥1 record."** Bare file-existence wedges the user when
  `DATA_DIR/installs.json` is empty or corrupt (nothing to protect, but import is blocked forever). Refuse only
  on a non-empty dest; empty/missing proceeds; a *corrupt* dest → distinct `installs_destination_corrupt`.
- **Probe `format_version` first, then full load.** A v2 source with an unknown field fails `InstallsFile::load`
  as a parse error *before* the version check, giving a confusing `bridge_command_failed`. Read a minimal
  `{format_version}` probe first → `installs_format_mismatch` (actionable); a parse failure on a v1 source →
  distinct retryable `installs_source_corrupt` (422), not the catch-all.
- **"Copy" is load→validate→re-serialize**, not a byte copy (no byte-equality test). Validate the source fully
  before touching the dest; rely on atomic rename so a crashed import leaves the dest *absent* (retry-able).
- **Do NOT re-hash/re-baseline disk during import** — copy the standalone's recorded hashes verbatim so a
  user's pre-migration external edit correctly shows as `Modified` on first scan (re-baselining would hide it).
  Add a test: edit an installed file (>1 s mtime bump) post-import → first batch scan reports `Modified`.

### D7 — Server-resolved paths are a tested invariant, not a convention (security; MEDIUM)
The bridge derives the write root from `args.home`/`args.installs_path`; `InstallPaths::new` does **zero**
validation, so containment rests entirely on the route layer never letting an HTTP-body value reach those args.
The destination is otherwise safe (config `home` + hardcoded install-matrix subpath + `PrimitiveName`-validated
name; `targets` a closed enum; `InstallsFile::load` re-validates `PrimitiveName` on deserialize, so a tampered
migrated record can't redirect a write). **Fix:** make it a tripwire — a route test feeding an
install/uninstall/import **body** containing `home`/`installs_path`/`installsPath` keys asserts the stubbed
`runBridge` receives the **config** values, not the body's. Also: the `server.ts` Origin guard allows
**absent**-Origin writes (for OTLP emitters) — that carve-out should **not** apply to `/api/library/*` writes
(only ever called by the same-origin Svelte UI, which always sends Origin); require Origin present+loopback on
the library write routes, or document the local-non-browser-process write as accepted residual.

### D8 — Detail drift authority + reframed safety claims (correctness + security)
- **Authority:** the detail pane uses **per-primitive `scan_drift`** (fresh, scoped) as authoritative for the
  open primitive's rows and post-write/post-ack reload; the **batch** `DriftReport[]` is authoritative only for
  explorer badges. Reloading the full batch after a single-target ack is heavy and racy. Wire a
  `getDrift(kind,name)` fetcher for the detail; if per-primitive scan is *not* used in the UI, drop
  `cmd_scan_drift` from the slice (Phase 1 builds it; Phase 4 must call it or it's dead code).
- **Reframe "two-phase confirm = write safety":** the *server* guarantee is core's `force:false` pre-flight
  abort (`CollidingContent`/`Drifted`/`OccupiedByUnexpectedKind` — never overwrites differing content);
  `force:true` is the sole overwrite path and **re-checks collisions at apply time** (verified: `force` is a
  bool that re-runs the check, not a passed-in list), so it's TOCTOU-safe. The dialog is the *UI consent layer*
  on top — display-only, bypassable by a direct `force:true` POST — not the security boundary. Align the plan's
  wording so reviewers don't assume the dialog gates the destructive write.

### D9 — DECIDED (2026-06-11, Scott): `format_version` lockstep + document
The dashboard's bundled core `FORMAT_VERSION` and the standalone app's are treated as **lockstep**. The
migration **hard-rejects** a source whose `format_version` differs (`installs_format_mismatch`, 422); the
user-facing recovery for a future mismatch is **"upgrade the dashboard build"** — there is no in-app
forward-compat upgrade path, and that is acceptable while both ship v1. **Implementation must document this
coupling** (a comment at the `format_version` check + a line in the plan/PR/ADR), so a future v2 bump on either
side is a deliberate, paired change rather than a silent dead-end. Considered and rejected: a forward-compat
upgrade path (premature while both are v1).

### Smaller corrections (fold in during implementation)
- **Batch drift:** rewrite `cmd_scan_drift_batch` to `InstallsFile::load` **once**, then loop
  `scan_record(&install_paths, record)` over `installs.records` building each `DriftReport{kind,name,target,
  status}` (`scan_record` returns `DriftStatus`, not `DriftReport` — wrap it). Promote from Open-Q1 fallback to
  the default; add a hyperfine gate over a 119-record fixture so a regression is visible. Reframe Open Q1: cost
  is stat-bound (core mtime-gates hashing, `drift.rs:222`), not hash-bound.
- **Error mapping:** `NoCurrentVersionForInstall` (unit variant) and `NoInstallRecord{kind,name,target}` (struct
  variant) are both real (`error.rs:99,105`). Also promote the **user-actionable** `TargetNotAllowed`,
  `TargetNotAllowedForKind`, `InstallNotSupported`, and `InstallsParse`/`InstallsSerialize` out of the `_=>`
  catch-all into real codes. `acknowledge_drift` on a `Missing` install errors generic `Io` → map to
  `drift_path_missing` (409) and offer Uninstall (not Acknowledge) on `Missing` rows in the UI.
- **`installed_at`:** validate it parses as RFC 3339 in the bridge before persisting (core does zero
  validation); one timestamp per install-batch is **correct/intended** (`installer.rs` doc: single clock per
  run) — resolves the plan's open risk, no change needed beyond format validation. Lives in
  `src-tauri/src/time_helpers.rs:5` (UTC, trailing `Z`).
- **No-op outcomes need UI:** `no_op_identical` install and `not_installed` uninstall must show a visible
  "already up to date"/"was not installed" confirmation, not a silent no-op (dead-button feel). Enumerate every
  `TargetOutcome`/`UninstallOutcome` variant with a cue.
- **Empty/pre-migration state:** empty `installs.json` → all-`not installed` rows (no error) + prominently
  surface the Import call-to-action so a fresh user knows migration is available.
- **Batch drift server-side single-flight:** if the scan can overrun the 30 s poll, coalesce concurrent
  `GET /api/library/drift` to one in-flight spawn (client nonce-gating hides the stale *response* but not the
  redundant server *spawn*). Optionally route-gate the drift poll so it only fetches when the Library route is
  active (the desktop app blur-paused its watcher).
- **Acknowledge adopts extras:** `acknowledge_drift` folds *all* current on-disk files (incl. user-added junk)
  into the baseline — dialog copy must say "adopt current contents as truth," not "ignore once."
- **Lock sidecar:** core's `save` creates a persistent `installs.json.lock` in `DATA_DIR` — gitignore it; note
  fd-lock is intra-machine only (keep `DATA_DIR` off network/sync mounts).
- **Citations:** re-exports span `lib.rs:75-87` (not `:75-83`); `scan_record` is a public top-level re-export;
  `PrimitiveKind` has a 4th variant `codex_agent` — confirm `parse_kind` + TS models cover it; add
  `time_helpers.rs` to the reference list.

## Overview

The read-only slice deferred Drift and per-target Install records because a read-only dashboard installs nothing, so a dashboard-owned `installs.json` would be empty and Drift vacuous (ADR-0008 Decision). This slice makes the dashboard the **sole installer** and closes the minimal install/drift loop: install a Primitive to Targets, see where it is installed, detect Drift, reinstall or acknowledge, uninstall.

This plan is **HOW**. The **WHAT** and the architectural choices are settled in the ADR-0008 amendment (2026-06-11): the slice command set, one-click migration, pull-poll batch drift (no `subscribe_drift`), two-phase confirm write safety, and the network-free/secrets-free invariant. This plan does not relitigate those; it grounds them in the actual code.

**In scope (the closed loop):** `install`, `uninstall`, `scan_drift` (batch + per-primitive), `acknowledge_drift`, `list_installs_for_primitive`; `DATA_DIR/installs.json` ownership; a one-click "Import existing installs" migration; per-target install rows + two-phase conflict dialog + drift badges in the Library route.

**Explicitly deferred (ADR-0008 amendment):** `scan_library_drift` (the launch-time "library source dir deleted" `MissingPrimitive` reconcile — a distinct concept), `subscribe_drift` (the desktop app itself polls instead of using its own watcher), `revert_to_version`, a backup mechanism, and a diff view.

**Explicitly excluded (keeps the bridge network-free + secrets-free):** git sync (pull/push/conflict), publish/versioning, import-from-URL, PAT/secrets. Install is fs-only.

## Key repository facts (verified at source)

### Reference core signatures (`prompt-library/crates/core`, re-exported from `lib.rs:75-83`)

- `installer::install(InstallRequest) -> Result<InstallSummary, Error>` (`installer.rs:116`). `InstallRequest { layout: LibraryLayout, install_paths: &InstallPaths, installs_file_path: &Utf8Path, kind, name: &PrimitiveName, targets: &[Target], force: bool, installed_at: &str }` (`installer.rs:95-109`).
- `installer::uninstall(UninstallRequest) -> Result<UninstallSummary, Error>` (`installer.rs:212`). `UninstallRequest { install_paths, installs_file_path, kind, name, targets, force }` (`installer.rs:198-207`).
- `InstallSummary { successes: Vec<TargetResult>, failures: Vec<TargetFailure> }` (`installer.rs:35`). `TargetResult { target, outcome }`; `TargetOutcome` is a **tagged enum** `#[serde(tag="kind", rename_all="snake_case")]` (`installer.rs:50-65`): `Installed { version }` | `NoOpIdentical { version }` | `CollidingContent { version, conflicts: Vec<String> }`. **`CollidingContent` is NOT a failure** — it is a normal result the UI uses to prompt; `conflicts` are install-relative path strings.
- `TargetFailure { target, reason: InstallFailureKind }` (`installer.rs:67`); `InstallFailureKind` tagged enum `OccupiedByUnexpectedKind`/`Io`/`Other` (`installer.rs:73-91`) — pre-flight aborts (never blindly deletes).
- `UninstallSummary { successes: Vec<TargetUninstallResult>, failures }` (`installer.rs:171`); `UninstallOutcome` tagged enum (`installer.rs:185-196`): `Removed` | `NotInstalled` | `Drifted { conflicts: Vec<String> }`. **`Drifted` is NOT a failure** — same two-phase prompt-then-force shape as `CollidingContent`.
- `drift::scan_drift_for_primitive(&InstallPaths, installs_file_path: &Utf8Path, kind, name: &PrimitiveName) -> Result<Vec<DriftReport>, Error>` (`drift.rs:56`). Aliased `core_scan_drift` in `commands.rs:30`. `DriftReport { kind, name, target, status }` (`drift.rs:32`); `DriftStatus` tagged enum (`drift.rs:39-51`): `Clean` | `Modified { conflicts: Vec<String> }` | `Missing { missing: Vec<String> }`.
- `drift::acknowledge_drift(&InstallPaths, installs_file_path, kind, name, target) -> Result<(), Error>` (`drift.rs:83`). Aliased `core_acknowledge_drift`. **Errors `NoInstallRecord` if no record exists** (`drift.rs:91-97`) — a real application error to map, not a panic.
- `install_state::InstallsFile { format_version: u32, records: Vec<InstallRecord> }` (`install_state.rs:74`); `InstallsFile::load(path: &Utf8Path) -> Result<Self, Error>` (`install_state.rs:93`); `FORMAT_VERSION` re-exported as `INSTALLS_FORMAT_VERSION` (`lib.rs:82`). `InstallRecord` keyed `(kind, name, target)` with `installed_version`, `file_hashes`, `mtimes`, `last_known_install_hashes`, `installed_at` (`install_state.rs:20-38`). `load` on a missing path returns an empty file (first-launch parity — see `list_installs_for_primitive` "Returns an empty vec" comment, `commands.rs:863`).
- `install_paths::InstallPaths::new(home: impl Into<Utf8PathBuf>)` (`install_paths.rs:18`). Root defaults to user home; scans `~/.claude/...`, `~/.pi/...`, `~/.codex/...` (read-only slice C2).
- The Tauri command bodies to port verbatim (strip `AppHandle`/`State`; resolve paths from env/config instead of `*_path_for(app)`): `list_installs_for_primitive` (`commands.rs:867-887`, defines the compact `InstalledTarget { target, installed_version, installed_at }` projection at `:856`), `install` (`:895-920`), `uninstall` (`:927-947`), `scan_drift` (`:954-965`), `acknowledge_drift` (`:972-990`). Each wraps the core call in `blocking(...)`; the bridge drops that wrapper (it is already a one-shot process).

### Migration source (verified on this machine)

- Standalone app's `installs.json` at `~/Library/Application Support/com.sknutti.promptlibrary/installs.json` — exists, 94 KB, `format_version: 1`, first record `{kind:"skill", name:"prime-project", target:"claude", installed_version:"v1", ...}`. ADR records 119 records (49 skills / 64 agents / 6 commands across Claude/Codex/Pi). Left **untouched** by import (still used for authoring); dashboard copies it to `DATA_DIR/installs.json`.

### Dashboard seams (all created by the read-only slice — extend, do not rewrite)

- **Bridge** `crates/prompt-library-bridge/src/main.rs`: dispatch match at `:89-102` (currently 5 read commands). `map_core_error` at `:289-308` already maps `CoreError` variants; the `_ =>` arm at `:305` catches write-side variants as `bridge_command_failed` — this slice promotes the ones it now reaches (`NoCurrentVersionForInstall`, `NoInstallRecord`) to real codes. Helpers `require_library` (`:241`), `parse_kind` (`:274`), envelope (`:350-360`) are reused as-is. Tests + golden fixtures live in `#[cfg(test)]` at `:372-603`.
- **TS bridge** `scripts/library_bridge.ts`: `runBridge(bridgePath, command, args, opts) -> Promise<BridgeResult<T>>` (`:135`) — argv-only spawn (M1, `:155`), concurrent stdout/stderr drain, watchdog, two-layer transport/application error model. Reused unchanged; new commands are just new `command`+`args`.
- **TS models** `scripts/library_models.ts`: hand-written interfaces + `parseX` validators throwing `BridgeShapeError` (`:81`). Add `InstallSummary`/`UninstallSummary`/`DriftReport`/`InstalledTarget` interfaces + parsers, mirroring the tagged-enum shapes above.
- **TS config** `scripts/library_config.ts`: `loadLibraryConfig(env, cfg)` (`:34`) resolves `libraryPath`/`bridgePath` with `CC_LIBRARY_*` precedence. Extend to also resolve `installsPath`/`home`. `scripts/paths.ts:14` already has `DATA_DIR`; add `CC_LIBRARY_INSTALLS_PATH` (default `DATA_DIR/installs.json`) and `CC_LIBRARY_HOME` (default user home) constants.
- **TS routes** `scripts/library_routes.ts`: `registerLibraryRoutes(app)` (`:164`), called from `scripts/routes.ts:277`. Factored `buildX(config)` handlers (`:172-177`) returning `{ status, body }`; `statusForCode` maps codes→HTTP (`:33`); `errorResult` logs `detail` server-side and never forwards it (m4). All currently GET. Add POST/DELETE handlers here.
- **Server guard** `scripts/server.ts:63-101`: Host allowlist on **everything** + Origin check on `POST/PATCH/PUT/DELETE`. New write endpoints inherit this automatically — **no new mechanism needed**.
- **UI api** `ui/src/lib/api.ts:394-471`: read models + `getLibraryX` fetchers. Add install/drift models + `installPrimitive`/`uninstallPrimitive`/`acknowledgeDrift`/`getInstallsForPrimitive`/`getDriftBatch`/`importInstalls` fetchers (POST/DELETE via the existing fetch helpers).
- **UI route** `ui/src/routes/Library.svelte` (18 KB, Variant B) + `ui/src/lib/library.ts` (pure cues/grouping — `dirtyCue`/`gitSummary` colorblind-safe pattern at `:60-85`). Uses `resource()` (`ui/src/lib/resource.svelte.ts`) which auto-refetches on `dataEpoch` (the 30s poll). Add a per-target install-rows section in detail, conflict dialog, drift badges, Import button.
- **Tests:** `cargo test --workspace`; `bun test scripts` (`scripts/library_routes.test.ts` stubs `runBridge`); `ui` vitest `*.svelte.test.ts` + `ui/src/lib/library.test.ts`. `CC_LIBRARY_HOME` lets tests inject a temp install root.

## Open questions (non-blocking; proceeding with labeled assumptions)

1. **Batch drift fan-out cost.** The batch scan loads `installs.json` once and calls `scan_drift_for_primitive` per distinct `(kind,name)` (119 records → ~80-100 primitives, each hashing a few files). **Assumption:** acceptable inside one process spawn on the 30s poll; if a `hyperfine` micro-bench shows p99 > ~200 ms, group records and scan once via `scan_record` (`drift.rs:120`) directly over `installs.records` instead of re-loading per primitive. Flagged, not blocking — start with the simple per-primitive loop.
2. **Targets argument source for `install`.** Desktop sends `targets: Vec<Target>` chosen in the inspector. **Assumption:** the dashboard install row composes legal targets from `metadata.allowed_targets` (already in `PrimitiveDetail`) and the user picks which to (re)install; install is always per-target from the detail row. No "install all" bulk action this slice.
3. **`acknowledge_drift` target granularity.** Core acknowledges one `(kind,name,target)` (`drift.rs:83`). **Assumption:** the UI exposes acknowledge per drifted target row (matching the per-target `DriftReport`), not a primitive-wide "ack all". Mirrors desktop.

## Proposed solution

Four vertical slices, backend-first — the same justification as the read-only slice (the UI route already exists and can only render real install/drift data once the bridge + routes return it; ADR's gates split backend from UI). Sequencing within each phase is test-/fixture-first. Phase 1 is `cargo`-green in isolation; Phases 2-3 are `bun test`-green with stubbed/fixture I/O; Phase 4 is the only user-visible change.

---

### Phase 1: Bridge write commands + batch drift (`cargo test --workspace` green)

- **Objective:** Add `install`, `uninstall`, `scan_drift` (per-primitive + batch), `acknowledge_drift`, `list_installs_for_primitive`, and `import_installs` to the bridge dispatch, resolving install paths from request args (so the TS layer injects `DATA_DIR/installs.json` + home), with the network-free/secrets-free invariant preserved.
- **Why this phase exists:** Everything downstream depends on a stable write contract. It is the only phase touching Rust and is independently testable against a temp install root.
- **Changes:**
  - **Dispatch** (`main.rs:89-102`): add arms `install`, `uninstall`, `scan_drift`, `scan_drift_batch`, `acknowledge_drift`, `list_installs_for_primitive`, `import_installs`. Each is sync core work — keep them off the async path (only `library_status` needs the runtime); they take `&Value` args and return `Result<Value, LibraryError>` like `cmd_list_primitives`.
  - **Path resolution:** new helper `install_context(args) -> (InstallPaths, Utf8PathBuf)` reading `args.installs_path` and `args.home` from the request (the TS layer supplies them from config/env). Build `InstallPaths::new(home)` and the `installs_file_path`. Reject missing/empty `installs_path` as a new code `installs_unconfigured`. Reuse `require_library(args)` for the commands that also need the layout (`install`).
  - **`cmd_install`:** port `commands.rs:895-920` body — `core_install(InstallRequest { layout: LibraryLayout::new(&root), install_paths, installs_file_path, kind, name, targets, force, installed_at: now })`. Parse `kind` via `parse_kind`, `name` via `PrimitiveName::try_new` (M3 — already the pattern at `main.rs:147`), `targets` via `serde_json::from_value::<Vec<Target>>`, `force: bool` (default false), `installed_at` from a request-supplied RFC3339 string (TS supplies a single clock value, matching desktop's `now_rfc3339()`).
  - **`cmd_uninstall`:** port `commands.rs:927-947`. Same arg parsing minus `installed_at`/layout (`UninstallRequest` needs no layout).
  - **`cmd_scan_drift`** (per-primitive): port `commands.rs:954-965` → `scan_drift_for_primitive(&install_paths, &installs_file_path, kind, &name)`. Serialize `Vec<DriftReport>`.
  - **`cmd_scan_drift_batch`:** new — `InstallsFile::load(&installs_file_path)` **once**, then loop
    `scan_record(&install_paths, record)` over `installs.records`, building each `DriftReport { kind:
    record.kind, name: record.name.clone(), target: record.target, status }` (`scan_record` returns
    `DriftStatus`, so wrap it). One load, one O(N) walk → every recorded primitive's drift (ADR: feeds both
    explorer badges and detail). **Do NOT loop `scan_drift_for_primitive`** — it reloads the whole file per
    call (`drift.rs:62`), making the batch O(N²) (see D-deepening / Open Q1, now resolved: `scan_record` is the
    default, not a fallback). Core mtime-gates hashing (`drift.rs:222`), so steady-state is stat-bound.
  - **`cmd_acknowledge_drift`:** port `commands.rs:972-990` → `acknowledge_drift(&install_paths, &installs_file_path, kind, &name, target)`. Returns `()` → serialize `json!({})`.
  - **`cmd_list_installs_for_primitive`:** port `commands.rs:867-887` — `InstallsFile::load`, filter `records` by `(kind,name)`, map to the `InstalledTarget { target, installed_version, installed_at }` projection (redeclare the struct from `commands.rs:856` in the bridge — hashes/mtimes stay in core, not on the wire). Empty vec when nothing matches (first-launch parity).
  - **`cmd_import_installs`:** new — args `source_path` + `installs_path`. **Idempotent + guarded:** if `installs_path` already exists → `installs_already_present` error (refuse to clobber, ADR). Load source via `InstallsFile::load(source_path)`; reject if `format_version != INSTALLS_FORMAT_VERSION` → `installs_format_mismatch` (format_version-guarded, ADR). Save to `installs_path` via `InstallsFile::save` (atomic + fd-lock, the same write path core uses). Source left untouched. Return a small summary `{ imported: <record count> }`.
  - **Error mapping** (`map_core_error`, `main.rs:289`): promote from the `_ =>` arm — `NoCurrentVersionForInstall` → `library_no_current_version` (install with no pinned version), `NoInstallRecord` → `drift_no_install_record` (acknowledge with no record). Confirm exact variant names against `crates/core/src/error.rs` when implementing.
- **Affected areas:** `crates/prompt-library-bridge/src/main.rs` only (imports from `prompt_library_core`: `install`, `uninstall`, `InstallRequest`, `UninstallRequest`, `InstallSummary`, `UninstallSummary`, `scan_drift_for_primitive`, `acknowledge_drift`, `DriftReport`, `InstallPaths`, `InstallsFile`, `INSTALLS_FORMAT_VERSION`, `InstallRecord`).
- **Dependencies:** none new — all from the already-imported `core` crate.
- **Risks:**
  - **Invariant regression:** install touches the user's real `~/.claude` etc. Mitigation: every test injects a temp `home` via the `install_context` arg (the `CC_LIBRARY_HOME` mechanism) — no test writes to the real home. Add an assertion/comment that no `reqwest::Client`/`SecretStore` is constructed (the crate still doesn't depend on `prompt-library-secrets`).
  - **`installed_at` clock from TS:** if omitted, install records get an empty timestamp. Mitigation: require it; bridge returns `bridge_bad_request` if absent (desktop always supplies one).
- **Validation (`cargo test` in the bridge crate, extending `main.rs` tests):**
  - Build a fixture library (reuse `fixture_library()` at `main.rs:382`) + a temp install home + a temp `installs.json` path.
  - `install` to one target → `InstallSummary.successes[0].outcome.kind == "installed"`; the file lands under the temp home; `installs.json` now has the record. Re-`install` (force=false) over identical content → `no_op_identical`. Externally edit the installed file, `install` force=false → `colliding_content` with `conflicts` non-empty and **disk unchanged**; force=true → `installed` and disk overwritten.
  - `scan_drift` after a clean install → `Clean`; after external edit → `Modified`; after external delete → `Missing`. `scan_drift_batch` over two installed primitives returns both.
  - `acknowledge_drift` on a `Modified` target re-baselines → next scan `Clean`. `acknowledge_drift` with no record → `drift_no_install_record`.
  - `uninstall` force=false on a drifted install → `Drifted` (disk untouched); force=true → `Removed` and record dropped. `uninstall` of a never-installed primitive → `NotInstalled`.
  - `list_installs_for_primitive` reflects records; empty when none.
  - `import_installs`: into an empty `installs_path` → copies records, source untouched; into an existing `installs_path` → `installs_already_present`; from a bumped `format_version` source → `installs_format_mismatch`.
  - Golden fixtures: capture representative `install`/`scan_drift`/`list_installs` envelopes into `scripts/fixtures/bridge/*.json` with a Rust-side `assert_eq!`-vs-committed-JSON test (mirroring `kind_info_matches_committed_fixture` at `main.rs:574`) so a serde rename on the tagged enums breaks a test. Update `scripts/fixtures/bridge/capture.ts` to emit them.

---

### Phase 2: TS models + config + migration importer + fixtures (`bun test scripts` green)

- **Objective:** Type the new envelopes, teach config to resolve the installs path + install home, and add the migration importer — all unit-tested against committed fixture bridge output (no live Rust).
- **Why this phase exists:** Isolates the process-boundary contract (new tagged-enum shapes, install-path resolution, the idempotent-import precondition) so it is tested independently of Rust and HTTP.
- **Changes:**
  - **`scripts/paths.ts`** (after `:14`): add `LIBRARY_INSTALLS_PATH = process.env.CC_LIBRARY_INSTALLS_PATH ?? join(DATA_DIR, "installs.json")` and `LIBRARY_HOME = process.env.CC_LIBRARY_HOME ?? homedir()`. Follows the `CC_*` idiom already there.
  - **`scripts/library_config.ts`** (`LibraryConfig` at `:20`, `loadLibraryConfig` at `:34`): add `installsPath: string` and `home: string`, resolved with the same `CC_LIBRARY_* > config > default` precedence. Default `installsPath` to `DATA_DIR/installs.json`, `home` to the user home. The migration source path (`~/Library/Application Support/com.sknutti.promptlibrary/installs.json`) is a **constant in the migration code**, not config (it is a one-time, app-specific source).
  - **`scripts/library_models.ts`:** add interfaces mirroring Phase 1 wire shapes — `TargetOutcome` (discriminated union on `kind`: `installed`/`no_op_identical`/`colliding_content`), `InstallSummary`, `TargetFailure`/`InstallFailureKind`, `UninstallOutcome` union (`removed`/`not_installed`/`drifted`), `UninstallSummary`, `DriftStatus` union (`clean`/`modified`/`missing`), `DriftReport`, `InstalledTarget`, and an `ImportResult { imported: number }`. Add `parseX` validators throwing `BridgeShapeError` (`:81`) for each, **validating the discriminant** (`kind`) so a renamed variant becomes a typed error, not `undefined` in the dialog.
  - **`scripts/library_migration.ts`** (new): `importInstalls(config, run)` that calls the bridge `import_installs` command with the standalone source path + config `installsPath`, maps `installs_already_present`/`installs_format_mismatch` to typed results. Pure over an injected `run` (stubbed in tests). This is the backend half of the one-click import.
  - **Fixtures:** commit the Phase-1-captured `install`/`uninstall`/`scan_drift`/`list_installs` JSON to `scripts/fixtures/bridge/`; the TS parsers are tested against the same bytes the Rust goldens assert (drift-safe both ways).
- **Affected areas:** `scripts/paths.ts`, `scripts/library_config.ts`, `scripts/library_models.ts`, new `scripts/library_migration.ts`, `scripts/fixtures/bridge/*.json`, `scripts/fixtures/bridge/capture.ts`.
- **Dependencies:** Phase 1 wire contract.
- **Risks:** tagged-enum drift between TS unions and Rust enums. Mitigation: discriminant-validating parsers + the shared fixtures asserted by both sides (the read-only slice's proven approach).
- **Validation (`bun test scripts`, stubbed `run`/fixtures — no spawned Rust):**
  - Config: `installsPath`/`home` resolve from `CC_LIBRARY_INSTALLS_PATH`/`CC_LIBRARY_HOME`, then config, then `DATA_DIR/installs.json` + user home; malformed/missing collapses to the safe default (never throws — mirror `loadAgentsConfig`).
  - Each `parseX` accepts the committed fixture and rejects a fixture with a renamed/dropped discriminant (`BridgeShapeError`).
  - `importInstalls`: happy path returns `{ imported }`; `installs_already_present` → a distinct "already imported" result; `installs_format_mismatch` → a distinct error; transport failure surfaces as the bridge error code.

---

### Phase 3: `/api/library/*` write routes + route-local failure states (`bun test scripts` green)

- **Objective:** Expose the write/drift/migration endpoints the Svelte route calls, normalized and route-local — a write failure never degrades Observability health.
- **Why this phase exists:** Defines the exact HTTP contract the UI consumes and proves failures stay Library-local.
- **Changes (all in `scripts/library_routes.ts`, registered from the existing `registerLibraryRoutes` at `:164`):**
  - `POST /api/library/primitives/:kind/:name/install` — body `{ targets, force }`; delegates to bridge `install` with config-resolved `libraryPath`/`installsPath`/`home` + a server-generated `installed_at`. Returns `InstallSummary` (200 even when it contains `colliding_content` — that is a normal result, not an error; the UI inspects outcomes).
  - `DELETE /api/library/primitives/:kind/:name/install` — body `{ targets, force }`; bridge `uninstall`. Returns `UninstallSummary` (200 even with `drifted`).
  - `POST /api/library/primitives/:kind/:name/acknowledge-drift` — body `{ target }`; bridge `acknowledge_drift`. 200 `{}` on success; `drift_no_install_record` → 409.
  - `GET /api/library/primitives/:kind/:name/installs` — bridge `list_installs_for_primitive` → `InstalledTarget[]`.
  - `GET /api/library/drift` — bridge `scan_drift_batch` → `DriftReport[]` (the batch that feeds explorer badges + detail; rides the 30s poll).
  - `POST /api/library/import-installs` — calls `library_migration.importInstalls`. 200 `{ imported }`; `installs_already_present` → 409; `installs_format_mismatch` → 422.
  - **Factored handlers:** add `buildInstall`/`buildUninstall`/`buildAcknowledgeDrift`/`buildInstallsForPrimitive`/`buildDriftBatch`/`buildImportInstalls(config, run, …)` returning `{ status, body }`, mirroring the existing `buildX` (`:172-177`); register the thin `c.json` wrappers.
  - **Status mapping** (extend `statusForCode` at `:33`): add `installs_unconfigured` → 409, `installs_already_present` → 409, `installs_format_mismatch` → 422, `drift_no_install_record` → 409, `library_no_current_version` → 409. `errorResult` continues to log `detail` and never forward it (m4).
  - **Write serialization (D1 — required for correctness):** add a process-wide async mutex / single-flight
    queue that every **write** handler (`install`/`uninstall`/`acknowledge_drift`/`import_installs`) acquires
    before spawning the bridge and releases in a `finally` after it exits. fd-lock only guards core's `save()`,
    not the `load→mutate→save` cycle, so concurrent spawns lost-update without this. Reads skip the mutex. Test:
    two concurrent installs of different primitives → both records survive.
  - **Write timeout (D4):** write commands pass a larger `timeoutMs` (≥30 s) than the 10 s read default and
    `killSignal:"SIGKILL"`; killing a write is destructive (D3), so the timeout must never trip on a healthy fs
    write.
  - **Security:** the Host allowlist + Origin guard (`server.ts`) cover writes for *browser* CSRF — but this is
    **not "no new mechanism needed"** for write *correctness* (see the write mutex above). Additionally, the
    `server.ts` carve-out that allows **absent-Origin** POST/DELETE (for OTLP emitters) should **not** apply to
    `/api/library/*` writes (only ever called by the same-origin UI, which always sends Origin): require Origin
    present + loopback on the library write routes, or document the local-non-browser-process write as accepted
    residual (D7). Add the server-resolved-path tripwire test (D7): a body carrying `home`/`installs_path` is
    ignored in favor of config.
- **Affected areas:** `scripts/library_routes.ts`, `scripts/library_routes.test.ts`.
- **Dependencies:** Phases 1-2.
- **Risks:** coupling write failures to global health. Mitigation: a test asserts a failing install (bridge error) leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.
- **Validation (`bun test scripts`, stubbed `runBridge`):**
  - Each route maps fixture summaries/reports to the right status + normalized body. `colliding_content`/`drifted` return 200 with the outcome visible (the dialog trigger), **not** an error status.
  - `acknowledge-drift` with no record → 409 `{ code, message }` (no `detail`). Import: success / already-present / format-mismatch map to 200/409/422.
  - Observability routes unaffected when a write fails. A traversal `:name` is rejected upstream as `library_invalid_name` → 422 (M3, already enforced in the bridge).

---

### Phase 4: Svelte per-target install rows, two-phase conflict dialog, drift badges, Import button (UI gate)

- **Objective:** Render the closed loop in the existing Variant B Library route: per-target install/update/uninstall rows in detail, a two-phase confirm dialog on conflict, drift badges in explorer + detail, and the one-click Import button — all colorblind-safe.
- **Why this phase exists:** The only user-visible deliverable; closes the install/drift loop end-to-end.
- **Changes:**
  - **`ui/src/lib/api.ts`** (after `:471`): add the install/drift/installed-target/import models + fetchers — `getInstallsForPrimitive(kind,name)`, `getDriftBatch()`, `installPrimitive(kind,name,{targets,force})` (POST), `uninstallPrimitive(...)` (DELETE), `acknowledgeDrift(kind,name,target)` (POST), `importInstalls()` (POST). Reuse the existing fetch helpers; POST/DELETE bodies are JSON.
  - **`ui/src/lib/library.ts`** (pure helpers, after `:85`): add `outcomeCue`/`driftCue`/`uninstallCue` returning the same colorblind-safe `Cue` shape (`:63`) — pair every install/drift state with a **text label + glyph**, tones from the Okabe-Ito-safe set already used (`amber`/`cyan`/`default`; never bare red/green — Scott is red/green colorblind). e.g. drift `Modified` → `{label:"drifted", tone:"amber", glyph:"●"}`, `Missing` → `{label:"missing externally", tone:"cyan", glyph:"⊘"}`, `Clean` → `{label:"installed", tone:"default", glyph:"✓"}`, not-installed → `{label:"not installed", tone:"default", glyph:"○"}`. Add a `driftByTarget(reports, kind, name)` selector to fold the batch `DriftReport[]` into per-target lookup.
  - **`ui/src/routes/Library.svelte`:**
    - Add a `resource("library:drift", getDriftBatch)` (rides `dataEpoch`/30s poll, ADR) feeding both the explorer (a per-primitive drift badge when any of its targets drift) and the detail.
    - In the detail pane (near the `allowed_targets` render at `:264`), add **per-target install rows** (mirror desktop `TargetInstallRow`): compose from `detail.metadata.allowed_targets` × `getInstallsForPrimitive` × the batch drift — each row shows the target, install state cue, installed version (if any), and Install/Update/Uninstall actions. A second `resource` keyed `kind:name` fetches installs for the selected primitive (lazy, like `detailRes` at `:74`).
    - **Two-phase conflict dialog:** Install/Uninstall call with `force:false`. If the response `InstallSummary` contains a `colliding_content` outcome (or `UninstallSummary` a `drifted`), open a dialog listing the exact `conflicts` paths + an overwrite warning; on confirm, re-call with `force:true`. **Never auto-force.** No diff view, no backup (deferred). Mirror desktop's prompt-then-force.
    - **Acknowledge:** a drifted target row offers "Acknowledge" → `acknowledgeDrift` → reload drift + installs.
    - **Import button:** in the status rail / route header, an "Import existing installs" action → `importInstalls()` → on success reload installs+drift; on `already-present`/`format-mismatch` show the route-local message. One-click, explicit (ADR — not automatic).
    - All new states (install failure, conflict, import errors) are **route-local** panels/toasts — they don't touch the shell (consistent with the existing `EmptyState` usage).
  - **Reload discipline:** after any write, call `.reload()` on the installs + drift resources (no `useEffect`; event-handler-driven, per the repo's no-`useEffect` rule).
- **Affected areas:** `ui/src/lib/api.ts`, `ui/src/lib/library.ts` (+ `library.test.ts`), `ui/src/routes/Library.svelte`, possibly a small `ConflictDialog.svelte` under `ui/src/lib/components/`.
- **Dependencies:** Phase 3 endpoints.
- **Risks:**
  - Stale drift after a write (the 30s poll hasn't fired). Mitigation: explicit `.reload()` of the drift resource on every successful install/uninstall/acknowledge.
  - Conflict dialog showing stale conflicts if the user edits between phases. Acceptable for this slice (force re-runs the install, which re-checks) — note, don't over-engineer.
- **Validation (`bun run test` → vitest; `*.svelte.test.ts`):**
  - `library.test.ts`: each new cue is distinguishable by label+glyph (not color) and uses no bare red/green tone; `driftByTarget` folds a batch correctly.
  - Component tests (stub `api` with `vi.spyOn(...).mockResolvedValue(...)`): a `colliding_content` install response opens the dialog with the exact conflict paths; confirming re-calls with `force:true`; a clean install shows the installed cue; acknowledge clears a drifted row; the Import button calls `importInstalls` and surfaces already-present/format-mismatch as route-local messages. Verify no write happens before confirm (force never auto-sent).

---

## Acceptance criteria

- `cargo test --workspace` passes; the bridge answers `install`, `uninstall`, `scan_drift`, `scan_drift_batch`, `acknowledge_drift`, `list_installs_for_primitive`, `import_installs` over the `{v,ok,data|error}` envelope, against a temp install home (no test writes the real `~/.claude`).
- Two-phase confirm holds end-to-end: `install`/`uninstall` with `force:false` over conflicting/drifted content write nothing and return `colliding_content`/`drifted` with exact `conflicts`; only an explicit `force:true` overwrites. No backups, no diff view, no auto-force.
- Batch drift: one bridge spawn loads `installs.json` and returns every recorded primitive's `DriftReport`s; `GET /api/library/drift` feeds both explorer badges and detail on the 30s poll. `subscribe_drift` and `scan_library_drift` are absent by design (ADR-0008 amendment).
- Migration: the "Import existing installs" button copies the standalone app's `installs.json` to `DATA_DIR/installs.json` once; idempotent (refuses to clobber → `already-present`) and `format_version`-guarded (`format-mismatch`); the standalone file is left untouched.
- `bun test scripts` covers config (installs path/home), model parsers (discriminant-validated), migration, and every write/drift/import route incl. route-local failure mapping; a failing write leaves `/api/summary`, `/api/agents`, `/healthz`, and doctor at 200.
- Write endpoints inherit `server.ts`'s loopback Host allowlist + Origin guard with no new mechanism.
- Every install/drift state in the UI is distinguishable without red/green alone (label + glyph + Okabe-Ito-safe tone).
- Install always deploys the current pinned version; `revert_to_version` is absent. Bridge stays network-free + secrets-free (no `reqwest::Client`, no `SecretStore`).

## Dependencies and risks

- **Writes touch the real user home** (`~/.claude`, `~/.pi`, `~/.codex`) — the highest-consequence change in this slice. Mitigated by: two-phase confirm parity with desktop (never auto-force), tests pinned to a temp `CC_LIBRARY_HOME`, core's atomic-write + pre-flight `OccupiedByUnexpectedKind` abort ("never blindly delete"), and the route-level write mutex (D1). **Caveats the deepening surfaced:** fd-lock alone does **not** prevent concurrent lost-updates (D1); install is **not atomic across targets** (D3 — a killed/failed-save install orphans on-disk files); and the two-phase dialog is a *UI consent* layer, the *server* guarantee being core's `force:false` pre-flight abort (D8). The real safety argument for a killed bridge is that the Rust child writes atomically (D4).
- **Tagged-enum contract drift** across the boundary. Mitigated by Rust goldens + discriminant-validating TS parsers over shared fixtures (read-only slice's proven method).
- **Scope creep into excluded flows** — git sync, publish/versioning, import-from-URL, PAT/secrets, `scan_library_drift`, `subscribe_drift`, `revert_to_version`, backups, diff view are all explicitly out (ADR-0008 amendment) and must not leak in; the bridge's network-free + secrets-free invariant is the tripwire.
- **Migration anti-divergence is behavioral** (install via the dashboard only) — the standalone app's `installs.json` is read once and never again; no lock prevents a user re-running the standalone installer, but that is an accepted, documented posture (ADR).

## References

- ADR-0008 amendment (2026-06-11): `docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md:48-57`
- Read-only slice plan (seams, conventions, security guardrails): `docs/plans/2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md`
- Reference core: `prompt-library/crates/core/src/{installer.rs,drift.rs,install_state.rs,install_paths.rs}`
- Reference Tauri command bodies to port: `prompt-library/src-tauri/src/commands.rs:856-990`
- Dashboard seams: `crates/prompt-library-bridge/src/main.rs`, `scripts/library_{bridge,models,config,routes,migration}.ts`, `scripts/paths.ts`, `scripts/server.ts:63-101`, `ui/src/lib/{api.ts,library.ts}`, `ui/src/routes/Library.svelte`

## Next step

**Phase 1 is unblocked.** Start with the bridge dispatch arms + the temp-home install tests (the riskiest, most isolated work). Recommended: `/workflows:work docs/plans/2026-06-11-feat-prompt-library-install-drift-slice-plan.md`, or `/workflows:deepen-plan` first if you want the exact `core::Error` write-side variant names and the `installed_at` clock-injection detail pinned before coding.
