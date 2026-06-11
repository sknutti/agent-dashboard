# Prompt Library Consolidation — Read-Only Slice — Implementation Plan

- **Date:** 2026-06-11
- **Type:** feat
- **ADR:** [docs/adr/0007-prompt-library-rust-command-bridge.md](../adr/0007-prompt-library-rust-command-bridge.md)
- **Track doc:** [docs/library-consolidation-track.md](../library-consolidation-track.md)
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Library layer · Primitive · Kind · Target · Working copy · Version · Install record · Drift
- **Builds on:** the prototype route (`ui/src/routes/LibraryPrototype.svelte`, Variant B selected) and the existing Bun/Hono backend (`scripts/server.ts`, `scripts/routes.ts`, `scripts/agents_config.ts`)

## Enhancement summary (deepened 2026-06-11)

Deepened with 6 parallel research agents grounded in the **actual** local code of both repos
(`prompt-library` and `agent-dashboard`), not generic best practice. One agent built the standalone
workspace and ran the imported crate tests; another extracted exact serde struct shapes; the rest mapped
backend seams, UI conventions, the subprocess/bridge state of the art, and plan-level security.

**Verdict:** the load-bearing premise holds — `core`/`git`/`secrets` are genuinely Tauri-free and
build + test standalone (verified). Backend-first sequencing is sound. But three things must change before
Phase 1, and several "maps to existing core calls" claims are wrong against real signatures. See the new
**Critical findings** section directly below; per-phase **Research insights** are inlined in each phase.

Headline changes:
1. **Build blocker — pin specta.** Copying `[workspace.dependencies]` verbatim does **not** "resolve as it
   already does": `specta = "2.0.0-rc.22"` floats up to `rc.25` and breaks `core`'s manual `impl Type`
   (12 compile errors). Fix: copy the reference `Cargo.lock` (preferred) or pin `=2.0.0-rc.22`.
2. **Architectural gap — install records & drift have no data source. ✅ RESOLVED (2026-06-11): Option A —
   cut drift/install-records from v1.** `installs.json` is per-machine *deployment* state (records keyed by
   `(kind,name,target)` with version + file hashes, `install_state.rs:20-39`), not library content, and
   drift scans the real user home (`~/.claude`, `~/.pi`, `~/.codex` via `install_paths.rs:28-46`). In a
   read-only slice the dashboard installs nothing, so a dashboard-owned `installs.json` is empty and drift is
   vacuous. **Decision: the dashboard *replaces* the standalone app (not coexisting), so v1 ships
   status/kind-info/target-info/list/detail only; drift + install-records are deferred to the write-flow
   slice** — see the resolved C2 below for the recorded end-state.
3. **Models derive from Rust structs, not the prototype.** `PrimitiveSummary` is `{kind,name,dirty,author}`
   and `PrimitiveDetail` carries allowed Targets but no install records/drift — the prototype's flat
   `PrimitiveRow` conflates three different core calls. "Seed TS models from prototype shapes" manufactures
   the contract drift the plan says it avoids.

Smaller but load-bearing: process-per-request is **fine** (single-digit-ms spawn) provided the read path
never builds a `reqwest::Client` or multi-thread tokio; use `Bun.spawn` (async) not `spawnSync`; stdout is
protocol-only; add a protocol `v` field; the fixture approach needs a Rust-side golden snapshot test to be
drift-safe; six security guardrails should move from implicit to mandated.

## Critical findings from deepening (resolve before / during Phase 1)

### C1 — Pin specta or the workspace won't compile (verified failure)
The reference `Cargo.toml` pins `specta = "2.0.0-rc.22"`, but caret semantics on pre-release `rc` versions
float a fresh resolve up to **`2.0.0-rc.25`**, which removed/renamed the `Type` trait members that
`core`'s hand-written `impl specta::Type` blocks rely on. Reproduced in a clean copied workspace: 12
errors at `crates/core/src/version_label.rs:16` and `primitive_name.rs:13` (`method 'inline' is not a
member of trait specta::Type`, `cannot find type 'TypeCollection'`). The reference repo only builds
because its committed `Cargo.lock` pins rc.22.
**Fix (add as an explicit Phase 1 step):** copy the reference `Cargo.lock` alongside the manifests and
commit it (preferred — also locks the `reqwest`/`hyper`/`security-framework` graph), **or** pin
`specta = "=2.0.0-rc.22"` (and `specta-macros` to match). With this, the full workspace
(core+git+secrets+bridge) builds and all imported tests pass standalone — **confirmed**. This also
confirms assumption #2: specta does *not* need `tauri-specta` to compile.

### C2 — Install records & Drift have no source-of-truth location in the dashboard — ✅ RESOLVED (Option A)
**Decision (2026-06-11, Scott): the dashboard *replaces* the standalone app and v1 cuts drift +
install-records.** Rationale and recorded end-state below.

The facts that forced the decision (verified at source):
- `installs.json` = `InstallsFile { format_version, records: Vec<InstallRecord> }`; each `InstallRecord` is
  keyed `(kind, name, target)` with `installed_version`, `file_hashes`, `mtimes`, `installed_at`
  (`crates/core/src/install_state.rs:20-39`). It is **per-machine deployment state, not library content** —
  versioned, atomic-write, `fd-lock`'d, and deliberately placed in `app_data_dir`, *not* the library. A
  library-relative location is therefore wrong (a git-synced library would carry one machine's deploy state +
  meaningless hashes to another).
- Drift resolves against `InstallPaths`, rooted at the real user **`home`**, scanning `~/.claude/skills`,
  `~/.pi/agent/...`, `~/.codex/...` (`crates/core/src/install_paths.rs:28-46`). It compares records vs the
  actual installed files → Clean/Modified/Missing.
- `scan_library_drift(layout, installs: &InstallsFile) -> Vec<MissingPrimitive>`
  (`library_drift.rs:36`) **requires an `&InstallsFile`** the plan's mapping omitted; the richer per-target
  drift (`commands.rs:954-965`) also needs `&InstallPaths`. `InstallsFile::load(path)` takes an explicit
  path — no Library-relative fallback.

Why Option A: in a read-only slice the dashboard installs nothing, so a dashboard-owned `installs.json` is
**empty → drift is vacuous**. The only populated `installs.json` today is the standalone app's, but since the
dashboard *replaces* (not coexists with) that app per ADR-0007's "reference until parity," reading it is a
one-time *migration* concern, never an ongoing source. Showing empty or another-app's drift is worse than
honestly omitting it; status/list/detail is already a complete read view.

**Recorded end-state (implement in the write-flow slice, not now):** when the dashboard owns install/write
flows it becomes the *sole* installer; `installs.json` lives at **`DATA_DIR/installs.json`** (env
`CC_LIBRARY_INSTALLS_PATH`), next to the SQLite db per `paths.ts` convention; `home` (the `InstallPaths`
root) defaults to the user home, env-overridable as `CC_LIBRARY_HOME` for tests; the standalone app's
`installs.json` is migrated in once, then retired. **Recorded in [ADR-0008](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md)**
(replace-not-coexist + install-state ownership/location + v1 drift-deferral); ADR-0007 is amended with a
pointer to it.

### C3 — Three of the four cited core signatures are wrong in ways that change bridge code
All line numbers verified, but the signatures in "Key repository facts" need correcting before coding:
- `list_primitives` returns **`Result<Vec<PrimitiveSummary>, Error>`** (not `-> Vec<…>`).
- `read_primitive_detail` takes **`name: &PrimitiveName`** (not `&str`); the bridge must build it via
  `PrimitiveName::try_new` (`primitive_name.rs:36`), which is **fallible** → a new error path.
- `scan_library_drift` requires **`&InstallsFile`** (see C2).
- `LibraryLayout::new(&Utf8Path)` is correct, but incoming JSON path strings must convert via camino
  `Utf8Path`/`Utf8PathBuf` — **non-UTF-8 paths are rejected** (another unhandled error path).
- `library_status` is **not a core function** — it's net-new bridge composition: marker check
  (`layout.root.join(".prompt-library")` existence, `layout.rs:27`) **plus** git crate calls
  (`current_branch`, `remote_branch_exists`, `git_diff_changed_files`, all `<R: GitRunner>` in
  `crates/git/src/git_ops.rs`) run through a concrete `TokioProcessRunner` (`runner.rs:56`, exported).
  "Not a git repo" must be a **first-class status**, not an error (git is informational per ADR/prototype).

The plan's enumerated error set (`library_unconfigured/invalid_path/marker_missing/unreadable/
bridge_command_failed`) must grow to cover: `library_invalid_name` (bad `:name`),
`library_invalid_path_encoding` (non-UTF-8 path), and the transport-vs-application split (see Phase 2
research insights).

## Overview

ADR-0007 and the track doc settle **WHAT**: bring the Prompt Library Rust crates (`core`, `git`, `secrets`)
into this repo under a root Cargo workspace, wrap them in a short-lived Rust command bridge invoked over
JSON stdin/stdout from the Bun backend, expose dashboard-normalized `/api/library/*` routes, and ship a
read-only Svelte Library route using the **Variant B – Explorer detail** information architecture. The
file-backed Library stays the source of truth; dashboard SQLite owns nothing here.

This plan is **HOW**, not WHAT. The first slice is **read-only**: open a Library from `config/library.yaml`,
read the Rust-projected Kind/Target capability tables, list Primitives, read Primitive detail/structure,
surface Versions and metadata **allowed Targets**, and lightweight git status. **Per-target install records
and Drift are deferred** (Option A — see C2: they need per-machine deploy state the read-only dashboard
doesn't own yet). No save/install/publish/import, no folder picker, no SQLite Library state; the existing
dashboard `skills` table remains an Observability/discovery table, not a Prompt Library content store.

## Key repository facts (verified)

- **The reference repo exists and is the source of the crates.** `~/side_projects/playground/prompt-library`
  has `Cargo.toml` (workspace) + `crates/{core,git,secrets,dev-tools}` plus `src-tauri` and a React `src/`.
  ADR-0007 says: import `core`, `git`, `secrets` only; do **not** import `src-tauri` or the React app. The
  standalone app stays a reference until parity, not a runtime dependency.
- **Crate names and deps are known.** `prompt-library-core` depends on `serde`, `serde_json`,
  `serde_yaml_ng`, `marked-yaml`, `toml_edit`, `camino`, `fd-lock`, `blake3`, `tar`, `flate2`, `tokio`,
  `futures`, **`reqwest`**, and **`specta`**. `prompt-library-secrets` has a macOS-only
  `security-framework` dependency. ADR-0007 says keep the existing crate names initially (no rename churn).
- **The read-model surface already exists in `core` and is exercised by `src-tauri/src/commands.rs`.**
  The Tauri read commands map directly to core functions the bridge will reuse:
  - `list_primitives` → `listing::list_primitives(LibraryLayout) -> Result<Vec<PrimitiveSummary>, Error>`
    (`crates/core/src/listing.rs:34`). *(Corrected: returns a `Result`, not a bare `Vec` — the bridge must
    handle the error arm.)*
  - `read_primitive` → `detail::read_primitive_detail(LibraryLayout, kind, name: &PrimitiveName) ->
    Result<PrimitiveDetail, Error>` (`crates/core/src/detail.rs:64`). *(Corrected: the name arg is
    `&PrimitiveName`, not `&str`/`&name`; the bridge builds it via the **fallible** `PrimitiveName::try_new`
    (`primitive_name.rs:36`) → adds a `library_invalid_name` error path.)* Sibling read fns exist:
    `read_primitive_version_view`, `list_overlays`, `read_primitive_for_target`.
  - Drift → `library_drift::scan_library_drift(LibraryLayout, installs: &InstallsFile) ->
    Vec<MissingPrimitive>` (`crates/core/src/library_drift.rs:36`). *(Corrected: **requires an
    `&InstallsFile`** the dashboard has no source for — see open question 4 / **C2**; `MissingPrimitive
    {kind, name, install_targets}` is "library dir deleted," NOT the per-target Clean/Modified/Missing state
    the prototype renders.)*
  - `LibraryLayout::new(&Utf8Path)` (`crates/core/src/layout.rs:14`) — camino `&Utf8Path`, so the bridge
    must convert incoming JSON path strings via `Utf8Path`/`Utf8PathBuf`; **non-UTF-8 paths are rejected**
    (→ a `library_invalid_path_encoding` error path). `LibraryLayout::new` itself does no validation
    (no canonicalization, no marker check) — validation is the bridge's job (see security M2).
  - `library_status` is **not a core function** — it is bridge-composed: marker existence
    (`layout.root.join(".prompt-library")`, `layout.rs:27`) plus git crate calls (`current_branch`,
    `remote_branch_exists`, `git_diff_changed_files`, all `<R: GitRunner>` in `crates/git/src/git_ops.rs`)
    run through a concrete `TokioProcessRunner` (`runner.rs:56`). "Not a git repo" is a first-class status,
    not an error.
  - Library opening uses `LibraryLayout::new(&Utf8Path)`; the `.prompt-library` marker is validated in
    `library_init` / settings, and `get_library_path` returns `Option<String>`.
  - Kind/Target legality table: `KindInfoTable::current()` / `get_kind_info_table() -> KindInfoTable`
    (commands.rs). The bridge should expose this as a read model so TypeScript does not maintain a second
    install matrix.
  - `commands.rs` wraps each core call in a `blocking(...)` helper and maps errors into `AppError`.
- **The dashboard backend has clean seams to extend, not rewrite:**
  - Routes register via `registerApiRoutes(app: Hono)` in `scripts/routes.ts:269`; handlers return
    `c.json(...)` and the codebase already uses the `{ status, body }` factored-handler pattern with
    `{ error: string }` bodies for testability (`routes.ts:151,156,230`).
  - Config is YAML loaded with the `yaml` package; `loadAgentsConfig()` in `scripts/agents_config.ts`
    is the canonical pattern — **never throws**, returns a safe default on missing/malformed file.
  - Filesystem/runtime constants are centralized and env-overridable in `scripts/paths.ts`
    (`PROJECT_ROOT`, `CONFIG_DIR`, all `process.env.CC_*`-overridable).
  - `config/` currently holds only `agents.yaml` and `prices.yaml`. ADR-0007 mandates a **new**
    `config/library.yaml` (not folded into either existing file).
  - The existing `skills` table and `/api/skills` routes scan installed `SKILL.md` files for Observability
    surfaces; they must not become the authoritative store for Library **Primitives**.
  - Tests run via `bun test scripts`; route + config + adapter tests already exist
    (`routes.test.ts`, `agents_config.test.ts`, `error_context.test.ts`).
- **The UI route is prototyped, not wired.** `ui/src/routes/LibraryPrototype.svelte` is the Variant B
  selection with **mock data**; `router.svelte.ts` registers `/library-prototype` (label "Library",
  icon `book-open`) as a throwaway route. The production route does not exist. The prototype already
  encodes the read-model TypeScript shapes informally (`PrimitiveRow`, `Kind`, `TargetName`, `DriftState`)
  and the three-pane explorer/detail/status-rail layout, drift tones, and `@media` breakpoints.
- **`docs/` is committed (not gitignored)** in this repo, so this plan and the ADR are tracked.

## Open questions (non-blocking; proceeding with labeled assumptions)

1. **Cargo workspace placement vs. the Bun repo root.** ADR-0007 says "root Cargo workspace with `crates/`
   and `Cargo.toml`". This repo's root currently has no `Cargo.toml`. **Assumption:** add `Cargo.toml` +
   `crates/` at the repo root and `target/` to `.gitignore`; the bridge binary defaults to
   `target/debug/prompt-library-bridge`. Confirm before Phase 1 if you'd rather nest under e.g. `rust/`.
2. **`specta` dependency on the imported crates.** `core` pulls `specta` (for Tauri type generation).
   ADR-0007 defers generated bindings. **Assumption:** keep `specta` as a transitive dep of the imported
   crates as-is for the first import (low churn), and hand-write the bridge JSON contracts; do not wire
   specta into the dashboard. Revisit only if it complicates the workspace build.
3. **macOS `security-framework` in `secrets`.** The first slice is read-only and likely never calls
   secrets. **Assumption:** import the crate for boundary parity (ADR rejects importing only `core`) but
   do not exercise it in any read command; it compiles on macOS, which is the dev target.
   *(Deepening upgrade — security m5: change "likely never" to a **tested invariant** — read commands
   construct no `SecretStore` and no `reqwest::Client`.)*
4. **[NEW — ✅ RESOLVED] Where does the dashboard's `installs.json` live?** See **C2**. Decided (Option A):
   the dashboard replaces the standalone app; **v1 cuts drift + install-records**
   (status/kind-info/target-info/list/detail only).
   The end-state location (`DATA_DIR/installs.json`, env `CC_LIBRARY_INSTALLS_PATH`; `home` via
   `CC_LIBRARY_HOME`) is recorded in C2 and [ADR-0008](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md)
   for the write-flow slice — not built now.
5. **[NEW — verified, do at Phase 1 start] Pin specta / commit the reference `Cargo.lock`.** See **C1**.
   Without it, `cargo build` fails with cryptic specta rc.25 errors. Not an open question so much as a
   required step — flagged here so it isn't missed.

## Proposed solution

Four vertical slices, each independently verifiable. Backend-first is justified here (against the usual
"avoid backend-only phases" rule) because the UI route is already prototyped with realistic shapes, the
ADR's completion gates are explicitly split into a backend gate and a separate UI gate, and the Svelte
route can only render real data once the bridge + routes return it. Phases 1–3 satisfy ADR-0007's backend
gate; Phase 4 satisfies the UI gate.

Sequencing within each phase is test-/fixture-first.

---

### Phase 1: Import crates + standing Rust bridge binary (read commands)

- **Objective:** Establish the root Cargo workspace with the three imported crates and a
  `prompt-library-bridge` binary that answers the read-model commands over JSON stdin/stdout, with
  `cargo test --workspace` green.
- **Why this phase exists:** Everything downstream depends on a buildable workspace and a stable bridge
  contract. This is the ADR's first concrete deliverable and the riskiest (cross-repo import + new
  binary), so it ships first and in isolation.
- **Changes:**
  - Add root `Cargo.toml` (`[workspace]`, **`resolver = "2"` on `[workspace]` itself** — it does not
    inherit from a member) with members `crates/core`, `crates/git`, `crates/secrets`,
    `crates/prompt-library-bridge`. Copy the `[workspace.dependencies]` block from the reference
    `Cargo.toml`, dropping Tauri-only entries not needed by the imported crates (`tauri-specta`; keep
    `specta`/`specta-typescript` only if a crate still references them). Pin `reqwest` with
    `default-features = false, features = ["rustls-tls"]` in `[workspace.dependencies]` so the
    feature-unification rule doesn't drag in native-tls.
  - **[C1 — required, verified] Pin specta / commit the lockfile.** Copying `[workspace.dependencies]`
    verbatim does **not** "resolve as it already does": `specta = "2.0.0-rc.22"` floats up to **`rc.25`**
    under caret semantics and breaks `core`'s hand-written `impl specta::Type` (reproduced: 12 errors at
    `version_label.rs:16` / `primitive_name.rs:13`). Fix as an explicit step: **copy the reference
    `Cargo.lock` alongside the manifests and commit it** (preferred — also locks the
    `reqwest`/`hyper`/`security-framework` graph), or pin `specta = "=2.0.0-rc.22"` (and `specta-macros` to
    match). With this, the full workspace builds and all imported tests pass standalone (confirmed).
  - Copy `crates/{core,git,secrets}` from the reference repo verbatim (names unchanged per ADR), including
    their tests and test fixtures, into this repo's `crates/`.
  - Create `crates/prompt-library-bridge` (a `main.rs` bin) that:
    - Reads a single JSON request from stdin: `{ "command": string, "args": {...} }`.
    - Dispatches **coarse read-model commands** (ADR: not one-per-Rust-fn): `library_status` (validate path
      + `.prompt-library`, return git/branch summary), `kind_info`, `target_info`, `list_primitives`,
      `primitive_detail`. **`scan_drift` is deferred** (Option A / C2 — no installs source in v1).
    - Maps each to existing core calls: `LibraryLayout::new(&path)`, `listing::list_primitives`,
      `detail::read_primitive_detail`, and `KindInfoTable::current()`. Build `target_info` from
      `Target::ALL`/`Target::dir_name()` so the UI learns Target values from Rust too.
      (`library_drift::scan_library_drift` is intentionally **not** wired this slice — it needs an
      `&InstallsFile` the dashboard doesn't own yet.) Reuse the `blocking`-style wrapping that
      `src-tauri/src/commands.rs` already demonstrates, minus Tauri state.
    - Writes one JSON response to stdout: `{ "ok": true, "data": ... }` or
      `{ "ok": false, "error": { "code": string, "message": string, "detail": string } }`. Error `code`
      values are dashboard-stable (e.g. `library_unconfigured`, `library_invalid_path`,
      `library_marker_missing`, `library_unreadable`, `bridge_command_failed`); `detail` carries the Rust
      error text as diagnostics only.
  - Add `/target` and Rust build artifacts to `.gitignore`.
- **Affected areas:** new root `Cargo.toml`, new `crates/` tree, new `crates/prompt-library-bridge/`,
  `.gitignore`.
- **Dependencies:** reference repo crates (copied, not referenced at runtime).
- **Risks:**
  - Transitive deps (`reqwest` with rustls, `specta`) may pull a large/slow first build. Mitigation:
    commit the reference `Cargo.lock` or hard-pin `specta`/`specta-macros` per C1; do not rely on a fresh
    semver resolve matching the reference.
  - Hidden coupling to Tauri types in `core` public read fns. Mitigation: the bridge only calls the four
    functions verified above, all of which return plain `serde`-able core structs already used by
    `commands.rs` without Tauri wrappers.
- **Validation:**
  - `cargo build --workspace` and `cargo test --workspace` pass (imported crate tests run unchanged).
  - A `cargo test` in the bridge crate covers: command dispatch, the JSON request/response envelope, and
    the error-code mapping for missing-path / missing-marker / unreadable cases, driven against a fixture
    Library copied from the Prompt Library test corpus.

#### Research insights (Phase 1)

**Exact bridge contract (from reading real serde structs — file:line cited):**

- `kind_info` → `KindInfoTable::current()` (`domain.rs:95-103`). JSON is a total object keyed by Kind
  (`skill`, `agent`, `command`, `codex_agent`), each with `primary_filename`, `allowed_targets`, and
  `supports_ref_files`. This is the UI's v1 source for primary filenames and legal Target options; TypeScript
  must not duplicate the Rust install matrix.
- `target_info` → bridge-composed from `Target::ALL` + `Target::dir_name()` (`domain.rs:208-227`). JSON:
  `{ "targets": [ { "target": "claude", "dir_name": "claude" }, ... ] }`. This intentionally lists
  Prompt Library Targets only (`Claude`, `Pi`, `Codex`); Antigravity is an observed dashboard Agent, not a
  Library Target until the Rust core defines install semantics for it.
- `list_primitives` → `listing::list_primitives(LibraryLayout) -> Result<Vec<PrimitiveSummary>, Error>`
  (`listing.rs:34`). `PrimitiveSummary { kind: PrimitiveKind, name: PrimitiveName, dirty: bool,
  author: Option<String> }` (`listing.rs:18-24`). `PrimitiveKind` is `#[serde(rename_all="snake_case")]`
  → `"skill" | "agent" | "command" | "codex_agent"` (`domain.rs:4-11`). `PrimitiveName` is a newtype that
  serializes as a bare string. JSON:
  ```json
  { "data": [ { "kind": "skill", "name": "diagnose", "dirty": true, "author": "Alice" },
              { "kind": "codex_agent", "name": "code-gen", "dirty": false, "author": null } ] }
  ```
- `primitive_detail` → `detail::read_primitive_detail(LibraryLayout, kind, &PrimitiveName) ->
  Result<PrimitiveDetail, Error>` (`detail.rs:64`). `PrimitiveDetail { kind, name, metadata, working,
  versions, current_version }` (`detail.rs:11-20`). `metadata: PrimitiveMetadata { allowed_targets:
  Vec<Target>, created_at: String, display_name?, author?, source_url? }` (`metadata.rs:16-30`, the three
  optionals are `skip_serializing_if=Option::is_none`). `working: WorkingContent` is a **tagged enum**
  `#[serde(tag="kind", rename_all="snake_case")]`: `{ "kind":"md", "frontmatter":"…", "body":"…" }` or
  `{ "kind":"toml", "text":"…" }` (`detail.rs:27-42`). `Target` → `"claude" | "pi" | "codex"`
  (`domain.rs:13-19`). `versions: Vec<VersionLabel>` and `current_version: Option<VersionLabel>` serialize
  as strings / null. **No file bytes** are in this payload — `working` is text only; binary ref files are a
  separate (out-of-slice) command. This satisfies the plan's on-demand rule already at the struct level.
- `scan_drift` → **DEFERRED in v1 (Option A / C2).** For the future write-flow slice, the signature is
  `library_drift::scan_library_drift(LibraryLayout, &InstallsFile) -> Vec<MissingPrimitive>`
  (`library_drift.rs:36`), `MissingPrimitive { kind, name, install_targets: Vec<Target> }`
  (`library_drift.rs:23-28`); it sources `InstallsFile` from `DATA_DIR/installs.json` (see C2 end-state).
  Not wired this slice.
- `library_status` → bridge-composed (see C3): `{ is_valid, marker_exists, branch?, dirty?, unpushed?,
  is_git_repo }`. There is no core fn; compose marker check + git crate calls via `TokioProcessRunner`.

**Error mapping (real `core::Error` variants → dashboard codes, from `error.rs`):** the bridge must map
*every* variant, not a handful. Key ones: `Io{path,source}` → `library_unreadable`;
`NotALibrary{path}` → `library_marker_missing`; `MetadataParse`/`CodexAgentParse`/`NotUtf8`/`MdFrontmatter`
→ a `parse` family (carry the format as detail); `InvalidPrimitiveName` → `library_invalid_name`;
`PrimitiveNotFound` → `primitive_not_found`. Bridge-only codes (no core equivalent): `library_unconfigured`,
`library_invalid_path`/`library_invalid_path_encoding`, `bridge_command_failed`. The reference Tauri error
mapper at `src-tauri/src/error.rs:199-318` is the table to mirror (Tauri-free).

**The bridge does NOT need specta.** Every load-bearing struct derives plain `serde`; `PrimitiveName`/
`VersionLabel` are serde-only newtypes. Use `serde_json` directly — do not wire specta into the bridge.

**No async runtime / no network on the read path** (perf + security): the four read fns touch only
`std::fs`. Do **not** `#[tokio::main]` a multi-thread runtime per one-shot call (it spins worker threads);
use `current_thread` or no runtime. Never construct a `reqwest::Client` on the read path (TLS root-store
load is the one thing that turns a ~2 ms spawn into tens of ms). Assert network-free + secrets-free by test
(security m5). Add a `hyperfine` micro-bench (`hyperfine --shell=none './target/release/prompt-library-bridge
< fixtures/list_request.json'`) so the process-per-request decision stays evidence-based — if p99 < ~20-30 ms
there's no latency argument for a daemon.

**Verbatim-copy gotchas (grep every copied `Cargo.toml`):** dangling `path = "…"` deps that pointed at
sibling crates (`dev-tools`, `src-tauri`) in the old repo; `version.workspace = true` /
`edition.workspace = true` inheritance markers that break until a `[workspace.package]` exists at the new
root; `include_str!`/`include_bytes!`/fixture paths relative to the source tree; any `[patch]`/`[replace]`
or vendored `.cargo/config.toml` that silently changed resolution and won't travel. Set `resolver = "2"` on
**`[workspace]`** (it doesn't inherit from a member). Put `reqwest = { default-features = false,
features = ["rustls-tls"] }` in `[workspace.dependencies]` to avoid the feature-unification pitfall dragging
in native-tls. Commit `Cargo.lock` (workspace with a binary). Keep `cargo build` **off** the default `check`
script (a cold `reqwest`+`hyper`+`rustls`+`icu` build is minutes) — see m4/m7.

**Protocol design (daemon-ready from day one):** envelope is one-line NDJSON, UTF-8, no embedded newlines,
with a **`"v"` (protocol version) field in both request and response** — a `v` mismatch becomes a
transport error instead of a misparse. `stdout` carries protocol bytes **only**: any `println!` / `tracing`
/ panic backtrace in Rust **or a dependency** must go to **stderr** — a stray stdout write corrupts the
stream (the single most common stdio-bridge bug). Make `main` infallible at the envelope level: serialize
expected application errors as `{ok:false,error:{…}}` and **still exit 0**; reserve non-zero exit + stderr
for genuine panics/crashes. This keeps "not found" distinguishable from "panicked," and makes a future
switch to a persistent NDJSON daemon a transport swap, not a contract rewrite.

---

### Phase 2: Library config + TypeScript bridge wrapper + error mapping

- **Objective:** Let the Bun backend locate the Library and the bridge binary from config, invoke the
  bridge, and translate its JSON envelope into typed read models + dashboard error codes — all unit-tested
  with **fixture bridge output** (no live Rust required for these tests).
- **Why this phase exists:** Isolates the process-boundary contract (config resolution, subprocess
  invocation, JSON parsing, error normalization) so it is tested independently of both Rust and HTTP.
- **Changes:**
  - `config/library.yaml` (new): `library_path` (the chosen Library dir) and optional
    `bridge_path` (defaults to repo-local `target/debug/prompt-library-bridge`). Env overrides allowed for
    dev (`CC_LIBRARY_PATH`, `CC_LIBRARY_BRIDGE_PATH`) but config is the primary persisted setting (ADR).
  - `scripts/library_config.ts` (new): a `loadLibraryConfig()` modeled on `loadAgentsConfig()` —
    **never throws**, returns `{ libraryPath: string | null, bridgePath: string }` with the
    `target/debug/...` default. Add `LIBRARY_*` constants to `scripts/paths.ts` only if a constant is
    genuinely shared.
  - `scripts/library_bridge.ts` (new): `runBridge(command, args): Promise<BridgeResult<T>>` that spawns
    the bridge via `Bun.spawn`, writes the JSON request to stdin, reads stdout, parses the envelope, and
    maps `{ ok:false }` into a typed `LibraryError { code, message, detail }`. Handle: unconfigured path
    (no spawn — return `library_unconfigured`), spawn failure / non-zero exit / unparseable stdout
    (`bridge_command_failed`).
  - `scripts/library_models.ts` (new): hand-written TypeScript interfaces for the v1 read models
    (`LibraryStatus`, `KindInfoTable`, `TargetInfo`, `PrimitiveSummary`, `PrimitiveDetail`), matching the
    bridge JSON. (`DriftReport` is deferred with drift — Option A / C2.) **Derive these from the real Rust
    serde structs/projections** (Phase 1 research insights), **not** the prototype's flattened
    `PrimitiveRow` — the prototype conflates list-summary + per-target install + drift from three different
    core calls (M2). Reuse the prototype's `Kind`/`TargetName` *unions* only where they match the real serde
    enums after snake_case mapping; do not encode legal KindTarget combinations in TypeScript.
- **Affected areas:** new `config/library.yaml`, new `scripts/library_config.ts`,
  `scripts/library_bridge.ts`, `scripts/library_models.ts`; possibly `scripts/paths.ts`.
- **Dependencies:** Phase 1 bridge contract (the JSON envelope shape).
- **Risks:**
  - Drift between hand-written TS interfaces and the Rust structs. Mitigation: commit captured bridge
    output as JSON fixtures and assert the TS parser accepts them; ADR explicitly chose fixtures/tests
    over generated bindings for this small surface.
- **Validation:**
  - `bun test scripts` covers, using **committed fixture bridge stdout** (no spawned Rust):
    config loading (missing file → null path + default bridge path; valid file; env override),
    envelope parsing for each command, and error mapping for each `code`.
  - One test resolves the real bridge binary path default and asserts it equals
    `target/debug/prompt-library-bridge` under `PROJECT_ROOT`.

#### Research insights (Phase 2)

**Mirror `loadAgentsConfig` exactly (`agents_config.ts:51-62`):** YAML is the **`yaml`** package
(`import { parse as parseYaml } from "yaml"`), already a dependency. The pattern is
`try { cfg = parseYaml(readFileSync(...)) ?? {} } catch { return <safe default> }` — never throws. For
`loadLibraryConfig()` the safe default is `{ libraryPath: null, bridgePath: <PROJECT_ROOT>/target/debug/
prompt-library-bridge }`. **Fail-closed on the path (security m6):** any missing file, parse error, or
non-string `library_path` must collapse to `libraryPath: null` (→ `library_unconfigured`), **never** a
half-parsed/coerced path — mirror `agents_config`'s per-field `coerce`. Add the malformed-with-garbage-path
test, not just missing-file.

**`paths.ts` (`paths.ts:14-17`)** — add, following the `CC_*` idiom:
```ts
export const LIBRARY_PATH = process.env.CC_LIBRARY_PATH ?? null; // no default; null = unconfigured
export const LIBRARY_BRIDGE_PATH =
  process.env.CC_LIBRARY_BRIDGE_PATH ?? join(PROJECT_ROOT, "target", "debug", "prompt-library-bridge");
```
(`CC_LIBRARY_INSTALLS_PATH` / `CC_LIBRARY_HOME` are **not** added in v1 — they arrive with drift in the
write-flow slice, defaulting to `DATA_DIR/installs.json` and the user home; see C2 end-state.)

**`Bun.spawn` (async) — NOT `spawnSync`.** The repo currently uses only `Bun.spawnSync` once
(`doctor.ts:172`); the bridge introduces the **first** stdin/stdout subprocess and must be defensive.
`spawnSync` **cannot write stdin** (no writable pipe) — it's disqualified. Canonical safe idiom:
```ts
const proc = Bun.spawn([bridgePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
                                       timeout: 10_000, killSignal: "SIGKILL" });
proc.stdin.write(JSON.stringify({ v: 1, cmd, args }));
proc.stdin.end();                                   // end() sends EOF — flush() alone hangs a read_to_string reader
const [stdout, stderr] = await Promise.all([        // drain BOTH concurrently — prevents the pipe deadlock
  new Response(proc.stdout).text(), new Response(proc.stderr).text() ]);
await proc.exited;                                  // then read exitCode / signalCode
```
Pitfalls: omitting `stdin.end()` → hang; `await proc.exited` *then* reading stdout → deadlock on payloads
over the ~64 KB pipe buffer (Primitive lists can exceed this); `stderr` defaults to `"inherit"` in async
spawn — set it to `"pipe"` or diagnostics leak into the dashboard log instead of your error envelope.

**Two-layer error model (make explicit in `runBridge`):** distinguish **transport failures** (spawn
`ENOENT`, non-zero exit, kill/timeout → `signalCode` set or `exitCode===null`, empty/unparseable stdout,
`v` mismatch) from **application errors** (a *valid* envelope with `ok:false`). Order of checks: spawned? →
exited without kill? → exit 0? → stdout parses as envelope with matching `v`? → branch on `ok`. Map the four
transport modes to distinct dashboard codes (`bridge_not_found`, `bridge_timeout`, `bridge_bad_output`,
`bridge_command_failed`) — "binary not built" vs "command timed out" are different fixes; never collapse
them. Never parse stdout before checking exit/signal (a killed process emits partial JSON).

**Models derive from Rust structs/projections, not the prototype (corrects the plan's "seed from
`PrimitiveRow`" instruction — see C2/M2).** `library_models.ts` interfaces should mirror the real serde
shapes from Phase 1 (`PrimitiveSummary = {kind,name,dirty,author}`, the tagged `WorkingContent` union,
`versions` as `string[]`, `KindInfoTable` keyed by Kind, `TargetInfo` from `Target::ALL`, etc.), **not** the
prototype's flattened `PrimitiveRow` (which conflates list-summary + per-target install + drift from three
different core calls). The prototype is a *layout* reference, not a *schema* reference. (In v1 the
drift/per-target-install fields simply don't exist — Option A/C2 — so this "where does drift come from"
question is deferred to the write-flow slice along with `/api/library/drift`.)

**Fixture approach is drift-safe ONLY with a golden snapshot test.** Capture **real** bridge stdout (run
the actual binary against a fixture Library from the imported test corpus) into `scripts/fixtures/bridge/
*.json` — do **not** hand-author fixtures from prototype shapes (that bakes the C2/M2 contract error into
both sides so they pass while disagreeing with reality). Add (a) a Rust-side snapshot test (`insta` or
`assert_eq!` vs committed JSON) so a serde rename breaks a test, and (b) a `zod`/`valibot` schema per
command validated against the same fixture **and at the route boundary** — turning "TS interface lies" into
a typed `bridge_bad_output` rather than `undefined` deep in the UI. Record a switch trigger (">~8 shared
types or first write command → adopt specta-typescript, commit generated `.ts`, CI drift-check") since
specta is already in the tree.

---

### Phase 3: `/api/library/*` routes (read-only) + route-local failure states

- **Objective:** Expose dashboard HTTP endpoints the Svelte route will call, returning normalized read
  models and route-local error states that never degrade Observability health.
- **Why this phase exists:** Completes ADR-0007's backend gate ("`/api/library/*` route behavior with
  fixture bridge output") and defines the exact contract the UI consumes.
- **Changes:**
  - In `scripts/routes.ts` (or a new `scripts/library_routes.ts` registered from `registerApiRoutes`),
    add read-only endpoints, each delegating to `library_bridge.ts`:
    - `GET /api/library/status` → `LibraryStatus` (configured? marker valid? branch/dirty/unpushed
      summary if available).
    - `GET /api/library/kind-info` → `KindInfoTable` (primary filenames, legal allowed Targets, ref-file
      support), sourced from Rust.
    - `GET /api/library/target-info` → `TargetInfo` (Prompt Library Targets only), sourced from Rust.
    - `GET /api/library/primitives` → `PrimitiveSummary[]` across all four Kinds.
    - `GET /api/library/primitives/:kind/:name` → `PrimitiveDetail` (metadata + structure; **file bytes
      load on demand**, not in this payload — ADR).
    - ~~`GET /api/library/drift`~~ — **deferred (Option A / C2);** lands with the write-flow slice once
      `DATA_DIR/installs.json` exists.
  - Follow the existing factored-handler pattern (`{ status, body }` returning `200` / `4xx` with
    `{ error }` or `{ code, message }` bodies) so handlers are unit-testable without HTTP.
  - Map `LibraryError` codes to HTTP: unconfigured/marker-missing/invalid-path → `409`/`422` with a
    machine code; bridge failure → `502`. These are **Library-route-local** — Observability routes and
    `/healthz`/doctor are untouched.
  - Optional, only if identity is reliable: `Kind=Skill` cross-link field pointing at existing skill
    usage (`scripts/skills.ts` already serves skill data). Other Kinds claim no usage. Do not read from the
    `skills` table as Library source-of-truth; it is only Observability/discovery data. Defer entirely if it
    adds risk to the slice.
- **Affected areas:** `scripts/routes.ts` (registration) and/or new `scripts/library_routes.ts`;
  `scripts/routes.test.ts` or a new `scripts/library_routes.test.ts`.
- **Dependencies:** Phases 1–2.
- **Risks:**
  - Accidentally coupling Library failures to global health. Mitigation: assert in tests that a missing
    `config/library.yaml` leaves `/api/summary`, `/api/agents`, and doctor unaffected.
- **Validation:**
  - `bun test scripts` drives each route with a **stubbed `runBridge`** returning fixture data and fixture
    errors, asserting status codes, normalized bodies, and the happy-path read models for at least one
    fixture Library (the ADR's "list/detail read models" gate; drift deferred — Option A / C2).
  - A test confirms Observability routes still return `200` when the Library is unconfigured.

#### Research insights (Phase 3)

**Factored-handler pattern to mirror (`routes.ts:148-156, 414-417`):** an exported
`buildX(db, …): Promise<{ status, body }>` does the work and is unit-tested directly; the route handler is a
thin `const { status, body } = await buildX(...); return c.json(body, status)`. Error bodies are
`{ error: string }` today; use `{ code, message }` for Library routes per ADR. Routes register inside the
single `registerApiRoutes(app: Hono)` (`routes.ts:269`). A new `scripts/library_routes.ts` exporting
`registerLibraryRoutes(app, db)` called from `registerApiRoutes` fits the codebase (mirrors the skill-sync
registration at `routes.ts:1047-1050`) — but inlining is equally idiomatic; either is fine.

**HTTP status mapping:** unconfigured / marker-missing / invalid-path → `409`/`422` with a machine code;
transport/bridge failure → `502`. All **Library-route-local** — assert in tests that a missing
`config/library.yaml` leaves `/api/summary`, `/api/agents`, `/healthz`, and doctor at `200`.

**Security guardrails to mandate at the route/bridge boundary (calibrated to a local single-user
localhost dashboard — these are cheap defense-in-depth, not invented enterprise threats):**
- **M2 — validated-Library precondition for ALL read commands, not just status.** `LibraryLayout::new`
  does zero validation (`layout.rs:14`); without a guard, a mis-set `library_path` (typo, copied config,
  stale `CC_LIBRARY_PATH`) turns `/api/library/*` into a filesystem-read oracle over any directory the user
  can read. Require: resolve `library_path` to an absolute canonical path and **refuse**
  (`library_marker_missing`/`library_invalid_path`) if `.prompt-library` is absent — both `list_primitives`
  **and** `primitive_detail` must short-circuit on this, not only `library_status` (and `scan_drift` too once
  it lands). Don't follow symlinks out of the Library root. Test: marker-less dir returns the error for all
  read commands.
- **M3 — bind `:kind`/`:name` through validating constructors.** `PrimitiveName::try_new`
  (`primitive_name.rs:35-52`) already rejects `..`, `/`, `\`, leading dots (`[A-Za-z0-9._-]`, ≤64 chars) —
  but only if the bridge builds names via `try_new`/`try_from`, never a raw path join. Pin this as a tested
  contract: bridge tests include traversal payloads (`../`, `%2e%2e`, absolute, leading-dot) asserting
  `library_invalid_name`. This is the one place untrusted HTTP input reaches a path join.
- **M1 — argv spawn, never a shell string.** Invoke `Bun.spawn([bridgePath, …])` as an argv array; no
  `sh -c`, no interpolating `library_path`/`args` into a command line. Resolve `bridgePath` to an absolute
  path under `PROJECT_ROOT` (or an explicit allowed root); if it escapes or isn't an executable file, return
  `bridge_command_failed` **without spawning**. Test a relative/escaping `bridge_path` is rejected.
- **m4 — never surface `detail` to the client.** `core::Error::Io` embeds the full path
  (`detail.rs:71,80`). `detail` is server-side diagnostic context only — log it, never include it in
  `/api/library/*` response bodies; `message` must not interpolate filesystem paths. Test: error body
  contains no `/Users/`-style path.
- **m5 — assert read slice is network-free + secrets-free by contract.** `core` is `reqwest`-capable
  (only `url_import.rs:96`) and `secrets` links the keychain; neither is reached by the four read fns today,
  but promote Open-Question-3's "likely never" to a tested invariant (read commands construct no
  `reqwest::Client` and no `SecretStore`).
- One-line note: `/api/library/*` inherit the dashboard's existing localhost no-auth posture (consistent
  with all current routes) — out of scope for this slice, flagged for awareness.

---

### Phase 4: Production Svelte Library route (Variant B, real data)

- **Objective:** Replace the throwaway prototype with a production `/library` route that renders real
  `/api/library/*` data in the **Explorer detail** layout, with filtering, empty/error states, and selected
  Primitive detail — satisfying ADR-0007's UI gate.
- **Why this phase exists:** Closes the consolidation slice end-to-end and is the only user-visible
  deliverable; it depends on Phases 1–3 returning real data.
- **Changes:**
  - Promote `/library-prototype` to `/library` in `ui/src/lib/router.svelte.ts` (`RoutePath`, `ROUTES`);
    remove the `?variant=` switcher and the throwaway `LibraryPrototype.svelte` + `PrototypeSwitcher.svelte`
    once parity is reached. Wire the new route in `ui/src/App.svelte`.
  - New `ui/src/routes/Library.svelte` built from the Variant B markup/styles in the prototype
    (left grouped Primitive explorer by Kind, central read-only Working copy / Versions / allowed-Targets
    detail surface, right status rail), but driven by a data layer instead of the mock array. **Omit the
    Install-records and Drift cells/dots** (Option A / C2) — keep the layout slots but render them only when
    those models exist (write-flow slice), or drop them from the v1 markup.
  - New `ui/src/lib/library.svelte.ts` (or similar): fetch `/api/library/status` + `/primitives`, derive
    selection, fetch `/api/library/kind-info` + `/api/library/target-info` for labels/capabilities, and
    lazy-fetch `/primitives/:kind/:name` on selection (on-demand detail/file bytes per ADR). Use Svelte 5
    runes (`$state`/`$derived`); no `useEffect`-equivalent anti-patterns.
  - Render the **route-local** states: unconfigured (point to `config/library.yaml`), invalid path /
    missing marker, bridge failure, and empty Library — without touching the rest of the shell.
  - Keep Target values `Claude`/`Pi`/`Codex` verbatim; show all four Kinds equally. Do not show
    Antigravity as a Library Target until the Rust core adds Antigravity install semantics.
  - **Colorblind-safe status cues:** drift is deferred (Option A / C2), so the prototype's
    `drift→amber`/`missing→red`/`clean→green` mapping is out of v1 scope. But the remaining v1 status cue —
    the `dirty` flag (working copy differs from pinned version, from `PrimitiveSummary`) — and any
    git-status tones must **not** rely on a red/green pair alone (Scott is red/green colorblind): pair each
    state with a distinct label/icon and prefer Okabe-Ito-safe tones. When drift returns, the same rule
    applies to its states.
- **Affected areas:** `ui/src/lib/router.svelte.ts`, `ui/src/App.svelte`,
  new `ui/src/routes/Library.svelte`, new `ui/src/lib/library.svelte.ts`, removal of
  `ui/src/routes/LibraryPrototype.svelte` and `ui/src/lib/components/ui/PrototypeSwitcher.svelte`.
- **Dependencies:** Phase 3 endpoints.
- **Risks:**
  - Detail payload shape mismatch vs. on-demand file loading. Mitigation: detail endpoint returns
    structure first; the file viewer fetches bytes only when a file/tab is opened (later/optional within
    this slice).
- **Validation:**
  - Focused Svelte component tests (the `ui` test runner already exists per `package.json` `check`):
    filtering by name/Kind, empty state, each error state, and selected-Primitive detail rendering.
  - In-browser verification across desktop and mobile widths (the prototype already defines `1120px`,
    `760px`, `520px` breakpoints to reuse).

#### Research insights (Phase 4)

**Canonical data-layer to copy: `ui/src/lib/resource.svelte.ts`** — `resource<T>(key, fetcher):
Resource<T>` with `{ data, loading, error, reload }`. It already does the hard parts: nonce-gated refetch
(stale-request suppression), a `loadedOnce` flag so background refresh doesn't flash a skeleton, and
`$effect` tracking `key()` + `dataEpoch.value` for poll-driven refetch. `library.svelte.ts` should use
`resource()` for `/api/library/status`, `/api/library/kind-info`, `/api/library/target-info`, and
`/api/library/primitives`, keep selection in `$state`, and lazy-fetch
`/api/library/primitives/:kind/:name` via a second `resource` keyed by `kind:name` (the on-demand detail per
ADR). This is the house idiom — don't write a bespoke fetch/`$effect` (and per the no-`useEffect`/
no-bespoke-effect rule, prefer the existing abstraction). One-time-load global state (e.g.
`registry.svelte.ts`) is the alternative pattern if status/capabilities are loaded once.

**Loading/empty/error house style (`McpPanel.svelte:56-107`):** gate first load with
`res.loading && !res.data` (background refresh keeps stale data visible); render the shared `EmptyState`
component with `error={res.error}` + `onRetry={res.reload}` for empty/error. The four route-local states
(unconfigured → point at `config/library.yaml`; invalid path / missing marker; bridge failure;
empty Library) each render their own panel without touching the shell — consistent with how sibling routes
isolate failures.

**Router/App wiring:** promote `/library-prototype` → `/library` in `router.svelte.ts:5-12` (`RoutePath`
union + `ROUTES`; label `"Library"` / icon `book-open` are already correct) and swap the import + condition
in `App.svelte:33-43` (`router.path === "/library"` → new `Library` component). No other shell changes.

**Test infra exists (corrects m4 below): Vitest + `@testing-library/svelte` + jsdom.** Runner is
`bun run test` → `vitest run` (`ui/package.json:10`); component test files MUST be named `*.svelte.test.ts`
to compile runes. Patterns: `vi.spyOn(api, …).mockResolvedValue(...)`, `screen.findBy*`, manual
`cleanup()` in `afterEach` (no globals); data-layer tests use `$effect.root()` + `flushSync()` with
controllable fetcher promises (see `resource.svelte.test.ts`). **Important:** the plan's Phase-4 validation
says "the `ui` test runner already exists per `package.json` `check`" — but `check` is **`svelte-check`**
(type-checking), not the test runner. Target `bun run test` (vitest) for component tests; the root `check`
does **not** run them.

**Colorblind-safe drift (already partly handled):** the prototype pairs every drift state with a **text
label** (`"clean"/"drift"/"missing"/"not installed"`, `LibraryPrototype.svelte:172-184`) alongside the
amber/red/green tone — so it's not color-only today. Preserve the icon+label pairing in production and
prefer Okabe-Ito-safe tones over a raw red/green contrast (Scott is red/green colorblind). Note: drift is
cut from v1 (Option A / C2), so this applies to the remaining cues — the `dirty` flag and git status — now,
and to drift states when they return.

---

## Acceptance criteria

- `cargo test --workspace` passes for the imported `core`/`git`/`secrets` crates and the new
  `prompt-library-bridge` crate.
- The bridge answers `library_status`, `kind_info`, `target_info`, `list_primitives`, and
  `primitive_detail` over JSON stdin/stdout with a stable `{ v, ok, data | error{code,message,detail} }`
  envelope (stdout = protocol bytes only; logs to stderr). `scan_drift` is deferred (Option A / C2).
- `bun test scripts` covers Library config loading, bridge invocation, error mapping, and
  `/api/library/*` route behavior using fixture bridge output.
- At least one fixture Library from the Prompt Library test corpus verifies the
  kind-info/target-info/list/detail read models end-to-end through the routes (drift deferred — Option A /
  C2).
- A missing/invalid `config/library.yaml` produces route-local Library errors only; Observability routes,
  `/healthz`, and doctor remain `200`/healthy.
- `/library` renders real read-model data in the Variant B layout with filtering, empty/error states, and
  selected-Primitive detail; remaining status cues (`dirty`, git status) are distinguishable without relying
  on red/green alone (drift cut from v1 — Option A / C2).
- Targets stay `Claude`/`Pi`/`Codex`; Antigravity remains a dashboard Agent, not a Library Target, until
  the Rust install matrix defines it. All four Kinds (`Skill`/`Agent`/`Command`/`CodexAgent`) are shown
  equally; no write/install/import/picker flows exist; no drift or per-target install-records surface in v1.

## Dependencies and risks

- **Cross-repo crate import** is the highest-risk step (Phase 1) — large dependency graph and possible
  Tauri coupling. Mitigated by committing the reference lockfile or pinning the known-good `specta`
  versions per C1, and only calling the verified Tauri-free core read functions.
- **Process-boundary contract drift** between hand-written TS interfaces and Rust structs. Mitigated by
  committed JSON fixtures asserted by both bridge and backend tests (ADR's explicit choice over generated
  bindings).
- **Scope creep into write flows.** Save/install/publish/import, git pull/push/conflict, native folder
  picker, SQLite Library ownership, and the full editor shell are explicitly out of scope (ADR rejected
  list) and must not leak into this slice.
- **First-build cost** of the Rust workspace may slow `bun run check`. Consider keeping the Rust build off
  the default `check` script initially, or gating it behind a separate `cargo test --workspace` step in CI.

## References

- ADR: `docs/adr/0007-prompt-library-rust-command-bridge.md`
- Track: `docs/library-consolidation-track.md`
- Glossary: `CONTEXT.md` (Library layer, Primitive, Kind, Target, Working copy, Version, Install record, Drift)
- Reference crates: `~/side_projects/playground/prompt-library/crates/{core,git,secrets}` and
  `~/side_projects/playground/prompt-library/src-tauri/src/commands.rs` (read-command patterns)
- Backend seams: `scripts/server.ts`, `scripts/routes.ts:269` (`registerApiRoutes`),
  `scripts/agents_config.ts` (config-loader pattern), `scripts/paths.ts`
- UI prototype: `ui/src/routes/LibraryPrototype.svelte` (Variant B), `ui/src/lib/router.svelte.ts`

## Next step

✅ Deepened 2026-06-11 (6 research agents, both repos read at source; workspace built + tested standalone).
The exact bridge schemas, real core signatures, and error tables are now inlined per phase.

**Status:** ✅ C2 resolved (Option A — the dashboard replaces the standalone app; v1 cuts drift +
install-records). ✅ C1 + C3 corrections applied into the plan body.

**Phase 1 is unblocked.** First step inside Phase 1: commit the reference `Cargo.lock` (or pin
`specta = "=2.0.0-rc.22"`) per C1. The corrected signatures (C3), per-phase research insights, and six
security guardrails are ready to implement as-written. The v1 bridge command set is `library_status` /
`kind_info` / `target_info` / `list_primitives` / `primitive_detail` (no `scan_drift`).

**Decision record:** the replace-not-coexist + install-state ownership/location decision is captured in
[ADR-0008](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md); ADR-0007 is amended
with a pointer (its first-slice read gate is now list/detail only).
