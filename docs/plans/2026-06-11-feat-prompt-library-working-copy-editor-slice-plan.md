# Prompt Library Consolidation — Working Copy / Editor Slice (Slice 3) — Implementation Plan

- **Date:** 2026-06-11
- **Type:** feat
- **ADR:** [docs/adr/0007-prompt-library-rust-command-bridge.md](../adr/0007-prompt-library-rust-command-bridge.md) (consolidation track, error/contract posture) + [docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md) (write-safety precedents this slice inherits)
- **Roadmap:** [docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md](2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md) — **Slice 3** (this plan implements it)
- **Builds on (shipped):** [read-only slice](2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md) (PR #4) and [install/drift write-flow slice](2026-06-11-feat-prompt-library-install-drift-slice-plan.md) (PR #5). Every seam those created — the bridge dispatch + envelope, `library_{bridge,models,config,routes}.ts`, the route write mutex (D1) + write timeout/SIGKILL (D4), the `resource()` UI pattern, the captured-intent + pending-write-lock dialog (D2), the colorblind `Cue` vocabulary, the Variant B Library route — is **extended, not rebuilt**.
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Working copy · Primitive · Kind · Ref file · Primary file
- **Reference crates:** `~/side_projects/playground/prompt-library/crates/core/src/working_files.rs` (the editor's read/create/save/rename/delete + the `validate_path_shape`/`validate_ref_path` security boundary) and `~/side_projects/playground/prompt-library/src-tauri/src/commands.rs:349,610-721` (the Tauri command bodies to port, minus `AppHandle`/`State`).

## Enhancement summary (deepened 2026-06-11)

Deepened by reading the **actual** source of both repos at the cited lines — the seven reference command bodies (`commands.rs:349,610-721`), the entire `working_files.rs` module (signatures, the two containment guards, and its 30+ in-core tests), the live bridge dispatch + helpers (`main.rs`), and every TS/UI seam the install slice left in place. **Verdict: the roadmap's Slice 3 shape is sound** — this is a faithful port under proven invariants, with no architectural surprises. But six source-grounded corrections change the implementation, and the roadmap's three named risks each resolve to a concrete, already-existing mechanism rather than new invention. Per-item corrections are in **Critical findings** below.

Headline corrections (each verified at source):
1. **There are SEVEN commands, not six — and the seventh (`save_working`) is the load-bearing one.** The roadmap lists `read/list/create/save/rename/delete_working_file` but the editor's *primary* save path is `save_working` (`commands.rs:349`) → `WorkingCopy::save_primary_base` (`working_copy.rs:67`), a **different code path** from `save_working_file`. `save_working_file` (`:666`) edits *ref* files and **refuses the primary filename** (`validate_ref_path` rejects it, `working_files.rs:335`). Editing `SKILL.md`/`agent.md`/`<name>.toml` (the file users care most about) goes through `save_working`, which **validates parsability before writing** (MD frontmatter or TOML) — bad bytes never reach disk. Missing this splits the editor in half.
2. **The working-files functions are NOT re-exported at the core crate root.** `lib.rs:41` is `pub mod working_files;` (module public) but there is **no `pub use working_files::{…}`** — unlike `WorkingCopy` (`lib.rs:110`). The bridge must call them path-qualified: `prompt_library_core::working_files::read_working_file(...)` and import `WorkingFileEntry`/`WorkingFileBytes`/`WorkingFileRole` via the module path. `WorkingCopy` (for the primary save) *is* root-re-exported and already imported in the bridge tests (`main.rs:793`).
3. **The path-traversal guard is already a tested in-core tripwire — the slice's job is the ROUTE-level half.** `validate_ref_path`/`validate_path_shape` (`working_files.rs:293,329`) already reject `..`, absolute paths, NUL bytes, `is_ignored` segments, >8 components, >200 bytes, and the primary filename — with **11 dedicated tests** (`working_files.rs:362-470`). The in-core boundary is proven. What's *new* and must be added is: the bridge surfacing `InvalidWorkingPath` as a stable code, and a **route/bridge tripwire test** feeding a `../` path through the HTTP→bridge seam asserting `422`/`library_invalid_working_path` (the roadmap's risk-(a)).
4. **`read_working_file` is a binary-safe, tagged enum — the editor must branch on it.** `WorkingFileBytes` is `#[serde(tag="kind")]` → `{kind:"text", text, ext?}` | `{kind:"binary", size}` (`working_files.rs:42-55`). Binary files (NUL in first 8 KiB, git's heuristic) return **size only, never bytes** — the editor renders a placeholder, not a textarea. This is the on-demand/no-large-blob rule already at the struct level.
5. **The two named UI risks (b) and (c) are already solved patterns in the shipped route — reuse, don't reinvent.** (b) lost edits across the 30s poll: do **not** route the editor buffer through `resource()` — keep it in plain `$state`, hydrate once on file-select, `resource()` already documents the exact infinite-loop trap if you read `state.data` during the effect (`resource.svelte.ts:34-38`). (c) dirty recompute: the install slice already established `.reload()`-on-write event-handler discipline (`Library.svelte` `reloadInstallState`); a working-file write adds `detailRes.reload()` + `primitivesRes.reload()` (the `dirty` flag lives on `PrimitiveSummary`, surfaced in the explorer head cue at `Library.svelte:486`).
6. **`delete_working_file` is idempotent; `create`/`save`/`rename` are not.** `delete` returns `Ok(())` on a missing file (`working_files.rs:173-185`); `create` errors `WorkingFileAlreadyExists`, `save` errors `WorkingFileNotFound`, `rename` errors both + `RefuseRenamePrimary`. Each is a distinct, real `core::Error` variant (`error.rs:37-52`) the bridge must map to its own code so the UI gives the right next step (e.g. "use Save, not Create").

## Critical findings from deepening (resolve before / during implementation)

### W1 — `save_working` (primary) vs `save_working_file` (ref) are two paths; ship both, route correctly
- **Primary file** (`SKILL.md`, `agent.md`, `<name>.md`, `<name>.toml`): edited via `save_working` (`commands.rs:349`) → `WorkingCopy::new(layout).save_primary_base(kind, &name, bytes)` (`working_copy.rs:67`). This **validates the bytes parse for the kind** (`validate_primary_bytes`, `working_copy.rs:167`) — MD kinds parse frontmatter+body, CodexAgent parses TOML — and **bad bytes never reach disk** (a parse error returns before `atomic_write`). For MD kinds the UI assembles `---\n{frontmatter}---\n{body}` and sends the whole primary blob (matching the read model's `WorkingContent` md shape already at `api.ts:428`).
- **Ref files** (everything else under `working/base/`): `create_working_file`/`save_working_file`/`rename_working_file`/`delete_working_file` (`commands.rs:645-721`) → the `working_files.rs` fns. These go through `validate_ref_path`, which **rejects the primary filename** (`working_files.rs:335`) — so a ref command can never clobber the primary, and a primary edit can never accidentally route through the (unvalidated-for-format) ref path. Keep this split crisp; it is the core's own safety design.
- **Consequence for models:** the editor needs `WorkingContent` (the primary, already in `PrimitiveDetail.working`, `api.ts:444`) **and** the new `WorkingFileEntry[]` list + `WorkingFileBytes` per-ref-file read. The primary appears in **both** the detail's `working` field and the `list_working_files` output (pinned first, `role:"primary"`) — the UI uses the list for the tree and `save_working` for the primary's save.

### W2 — Path-qualify the core imports; the fns are module-public, not root-re-exported
`lib.rs:41` exposes `pub mod working_files` but does **not** `pub use` its functions (verified: only `working_copy::{OverlayBytes, WorkingCopy}` is re-exported at `lib.rs:110`). The bridge imports:
```rust
use prompt_library_core::working_files::{
    self, WorkingFileEntry, WorkingFileBytes, WorkingFileRole,
};
// call sites: working_files::read_working_file(layout, kind, &name, rel)?
```
`WorkingCopy` (for `cmd_save_working`) is already imported in the bridge **test** module (`main.rs:793`) but **not** in the bridge's non-test `use` block — add it there. `camino::Utf8Path::new(&path)` builds the `rel` arg exactly as the reference does (`commands.rs:634,654,675,695,716`).

### W3 — Route the new `InvalidWorkingPath`/working-file error variants out of the catch-all
`map_core_error` (`main.rs:677-714`) currently funnels `InvalidWorkingPath`, `WorkingFileAlreadyExists`, `WorkingFileNotFound`, `RefuseRenamePrimary`, `RefuseDeletePrimary`, and `TooManyWorkingFiles` into the `_ => bridge_command_failed` arm (a 502 — wrong; these are actionable application states). Promote them (mirroring how the install slice promoted `NoInstallRecord`/`TargetNotAllowed`):
| `core::Error` (`error.rs`) | New dashboard code | HTTP (`statusForCode`) | UI affordance |
| --- | --- | --- | --- |
| `InvalidWorkingPath` (`:37`) | `library_invalid_working_path` | 422 | reject the path; this is the **traversal tripwire** code |
| `WorkingFileAlreadyExists` (`:43`) | `working_file_exists` | 409 | "a file with that name exists — use Save or pick another name" |
| `WorkingFileNotFound` (`:46`) | `working_file_not_found` | 404 | "no such ref file — use Create" |
| `RefuseRenamePrimary` (`:49`) | `working_file_refuse_primary` | 409 | "rename the primitive, not its primary file" |
| `RefuseDeletePrimary` (`:52`) | `working_file_refuse_primary` | 409 | "delete the primitive, not its primary file" (shared code) |
| `TooManyWorkingFiles` (`:40`) | `working_file_too_many` | 422 | bundle is at the 200-file cap |
The primary-save parse failures (`MetadataParse`/`CodexAgentParse`/`MdFrontmatter`/`NotUtf8`) **already map** to `library_parse_error` (`main.rs:685-690`) — for the editor surface this as "the file doesn't parse — fix before saving" (the save never touched disk). `statusForCode` (`library_routes.ts:69`) gets the new 409/404 cases added.

### W4 — `read_working_file` binary branch must not become a textarea
`WorkingFileBytes::Binary { size }` (`working_files.rs:51`) carries no bytes. The editor's file pane branches on `content.kind`: `text` → editable textarea seeded with `content.text` (+ `ext` for a future syntax mode, unused this slice); `binary` → a read-only placeholder ("binary file, {size} bytes") with **no save action**. The reference's editor does the same and offers a Finder-reveal there (`commands.rs:728`) — that reveal is a **native affordance we drop** (roadmap Slice 10c); replace with a copy-the-absolute-path affordance or omit entirely this slice. Reading the *primary* file does **not** go through `read_working_file` for display — the primary's text is already in `detail.working` (the read-only slice's payload); `read_working_file` is for ref-file content on tree-click.

### W5 — Editor buffer is local `$state`, hydrated on select; never bound to `resource()` data (risk-b)
`resource.svelte.ts:34-38` documents the exact trap: reading `state.data` inside the tracked effect creates a refetch→set→refetch loop. The editor must therefore:
- Keep the open buffer in plain `$state<string>` (`let buffer = $state("")`), **not** a `$derived` of any resource.
- Hydrate the buffer **once** when the selected file changes — via a `key`-style reset (the Svelte-5 idiom: a keyed block or an explicit "load" event handler that sets `buffer` + a `baseline` snapshot), **not** a `$effect` reading resource data (no-`useEffect`/no-bespoke-effect rule).
- Compute `isDirty = buffer !== baseline` as `$derived`.
- A 30s `dataEpoch` poll may refetch `detailRes`/the working-file read **in the background**, but it writes only the resource's own `.data`, never the editor buffer — so an in-progress edit survives the poll. On **save success**, set `baseline = buffer` and `.reload()` the detail/primitives (W6).
This is the same "local mutable buffer over an external read source" shape the codebase already trusts; it just must stay out of `resource()`.

### W6 — Reload discipline after a working-file write (risk-c)
A working-file write changes the Primitive's `dirty` flag (working copy now differs from the pinned version — `PrimitiveSummary.dirty`, surfaced in the explorer cue at `Library.svelte:486` and the detail head). After any successful `save_working`/`save_working_file`/`create`/`rename`/`delete`, event-handler-driven `.reload()` (no effect):
- `detailRes.reload()` — re-reads `detail.working` (the primary may have changed) + `versions`/`current_version`.
- `primitivesRes.reload()` — refreshes the explorer `dirty` badge.
- the working-files-list resource `.reload()` — the tree changed (create/rename/delete).
This mirrors the install slice's `reloadInstallState` (`Library.svelte:183-187`) exactly.

### W7 — Per-row pending-write lock + (for delete/rename) confirm reuse the install slice's D2 machinery
Destructive working-file actions (delete a ref file, overwrite-save) reuse the shipped patterns:
- **Pending-write lock** keyed by the working-file path (mirror the `(kind,name,target)` lock at `Library.svelte:148-159`) — disable a file row's actions while its write is in flight, cleared in `.finally()`. Prevents double-fire delete and save-while-saving.
- **Delete confirm** can reuse the singleton captured-intent dialog (`Library.svelte:162-174`) extended with a `"delete-working-file"` action variant, OR a simpler inline confirm — delete is less catastrophic than the install-overwrite (idempotent, single ref file, recoverable from git). Decide in implementation; the captured-intent snapshot pattern is there if wanted. A **rename** is non-destructive (refuses to clobber an existing dest in-core, `working_files.rs:152`) so it needs no confirm, just the pending lock.

### Smaller corrections (fold in during implementation)
- **`list_working_files` returns `[]` when `working/base/` is absent** (`working_files.rs:199`) — not an error; the editor shows an empty tree, not a failure panel.
- **Symlinks and `is_ignored` files are silently skipped** in `list_working_files` (`working_files.rs:240,247`) — the UI never sees `.DS_Store`/symlinked escapes; no client-side filtering needed.
- **`size_bytes`/`size` saturate at `u32::MAX`** (specta legacy, `working_files.rs:30,54`) — fine over the JSON wire; TS types them as `number`.
- **`rename_working_file` creates intermediate dirs** for the destination (`working_files.rs:157`) — `notes.md` → `docs/notes.md` works; the test at `:632` proves it.
- **No `installed_at`/install-context args** for any working-file command — these are **library-only** writes (root from config `libraryPath`), they do **not** touch `installs.json` or the install `home`. They acquire the **write mutex anyway** (D1) only if they could race the ledger — they don't, but a working-file write *can* race another working-file write to the same file; core's `save_base_file` is an `atomic_write` (`working_copy.rs:46`), so the file-level race is safe. **Recommendation:** working-file writes skip the *ledger* mutex (they never load→mutate→save `installs.json`) but get the larger write timeout + SIGKILL (D4) since they write user files. State this atomicity story explicitly per the roadmap's multi-write rule (here it's single-file-atomic, the simplest case).
- **`looks_like_rfc3339`/`parse_installed_at` are irrelevant here** — no timestamps in working-file commands.
- **Fixtures:** reuse `fixture_library()` (`main.rs:801`, scaffolds a `diagnose` skill) + `WorkingCopy::save_base_file` (already imported in the test module, `main.rs:852`) to seed ref files. Add golden fixtures (`scripts/fixtures/bridge/list_working_files.json`, `read_working_file_text.json`, `read_working_file_binary.json`) asserted by a Rust-side `assert_eq!`-vs-committed test mirroring `kind_info_matches_committed_fixture` (`main.rs:1101`).

## Overview

The first two slices closed the **read** loop (open a library, list/detail Primitives) and the **install/drift** loop (deploy to targets, detect drift). The central pane today renders the working copy as a **read-only `<pre>`** (`Library.svelte:512-515`). This slice makes that pane an **editor**: read/create/save/rename/delete the working-copy files for the selected Primitive through the Rust core — the substrate every downstream authoring slice (versioning, overlays, metadata, lifecycle) snapshots or edits.

This plan is **HOW**. The **WHAT** and the ordering rationale are settled in the roadmap (Slice 3, first among authoring, network-free + secrets-free). It is a faithful port of seven reference Tauri commands under the exact write-safety invariants the install slice proved; it does not relitigate those.

**In scope:** `save_working` (primary-file save, parse-validated), `list_working_files`, `read_working_file` (text/binary tagged), `create_working_file`, `save_working_file`, `rename_working_file`, `delete_working_file`; a working-files tree + textarea-first editor in the Library route; dirty-state cue; the in-core `validate_ref_path` traversal boundary made a **route-level tripwire test**.

**Explicitly deferred (roadmap):** a syntax-aware/rich editor (textarea-first, roadmap open question 5); overlay/target-file editing (Slice 5 — `read_working_file`/`list` here cover `working/base/` only, *not* `working/targets/`, matching `working_files.rs:191`); versioning/publish of edits (Slice 4); metadata editing (Slice 6); primitive create/delete/rename (Slice L — distinct from *file* create/delete/rename).

**Explicitly excluded (keeps the bridge network-free + secrets-free):** no git, no secrets, no network. Every write is `std::fs`-only through core, atomic per file. The bridge's `prompt-library-secrets`-free invariant (roadmap: broken only by Slice 8) holds — a "no `SecretStore`/`reqwest::Client` constructed" assertion guards it.

## Key repository facts (verified at source)

### Reference core surface (`prompt-library/crates/core/src/working_files.rs`)

- `working_files::read_working_file(layout, kind, name: &PrimitiveName, rel: &Utf8Path) -> Result<WorkingFileBytes, Error>` (`:62`). Validates via `validate_path_shape` (primary is a legal *read* target). `WorkingFileBytes` tagged enum `#[serde(tag="kind", rename_all="snake_case")]`: `Text { text: String, ext: Option<String> }` | `Binary { size: u32 }` (`:42-55`); binary = NUL in first 8 KiB, bytes never returned.
- `working_files::create_working_file(layout, kind, name, rel, content: &str) -> Result<(), Error>` (`:90`). `validate_ref_path` (rejects primary filename), errors `WorkingFileAlreadyExists` if dest occupied (`:99`).
- `working_files::save_working_file(layout, kind, name, rel, content: &str) -> Result<(), Error>` (`:109`). `validate_ref_path`, errors `WorkingFileNotFound` if absent (`:118`) — callers must `create` first.
- `working_files::rename_working_file(layout, kind, name, old_rel, new_rel) -> Result<(), Error>` (`:130`). `validate_path_shape(old)` + `RefuseRenamePrimary` if old is primary (`:138`) + `validate_ref_path(new)`; errors `WorkingFileNotFound`/`WorkingFileAlreadyExists`; creates intermediate dirs (`:157`).
- `working_files::delete_working_file(layout, kind, name, rel) -> Result<(), Error>` (`:173`). `validate_path_shape` + `RefuseDeletePrimary` (`:180`); **idempotent** on missing (`:185` → `WorkingCopy::remove_base_file` no-ops, `working_copy.rs:112`).
- `working_files::list_working_files(layout, kind, name) -> Result<Vec<WorkingFileEntry>, Error>` (`:193`). Empty `[]` when `working/base/` absent (`:199`). `WorkingFileEntry { path: String, role: WorkingFileRole, is_text: bool, size_bytes: u32 }` (`:19-31`); `WorkingFileRole` = `Primary | Ref` (snake_case, `:33`). Primary pinned first, refs alphabetical (`:211`); symlinks + `is_ignored` skipped (`:240,247`); 200-file cap → `TooManyWorkingFiles` (`:205`).
- **Primary save** — `WorkingCopy::new(layout).save_primary_base(kind, name, bytes: &[u8]) -> Result<(), Error>` (`working_copy.rs:67`). `validate_primary_bytes` (`:167`) parses MD frontmatter / TOML **before** the `atomic_write` — bad bytes never reach disk. `WorkingCopy` is root-re-exported (`lib.rs:110`); the working-file *functions* are **not** (`lib.rs:41`, module-only — W2).
- **Containment guards** — `validate_path_shape` (`:293`): rejects empty/absolute/NUL/`.`/`..`/`is_ignored` segment/>8 components/>200 bytes → `InvalidWorkingPath`. `validate_ref_path` (`:329`): the above **plus** the kind's primary filename. **11 in-core tests** cover every payload (`:362-470`), incl. `../escape.md`, `notes/../escape.md`, `/etc/passwd`, `./notes.md`, NUL, `.DS_Store`, `.git/config`. The in-core boundary is proven; this slice adds the **route tripwire**.

### Reference Tauri command bodies to port (`prompt-library/src-tauri/src/commands.rs`, strip `State`/`require_library()` → resolve root from config)

- `save_working` (`:349`) → `WorkingCopy::new(LibraryLayout::new(&path)).save_primary_base(kind, &name, content.as_bytes())`. Args `kind, name, content: String`.
- `list_working_files` (`:610`) → `core_list_working_files(layout, kind, &name)`. Args `kind, name`.
- `read_working_file` (`:626`) → `core_read_working_file(layout, kind, &name, Utf8Path::new(&path))`. Args `kind, name, path: String`.
- `create_working_file` (`:645`) → `…create_working_file(layout, kind, &name, rel, &content)`. Args `kind, name, path, content`.
- `save_working_file` (`:666`) → `…save_working_file(…)`. Args `kind, name, path, content`.
- `rename_working_file` (`:686`) → `…rename_working_file(layout, kind, &name, from, to)`. Args `kind, name, old_path, new_path`.
- `delete_working_file` (`:708`) → `…delete_working_file(layout, kind, &name, rel)`. Args `kind, name, path`.
- Each wraps the core call in `blocking(...)`; the bridge drops that wrapper (already a one-shot process) and is **sync** (no `.await` — `std::fs` only, like `cmd_list_primitives`).

### Dashboard seams (all from the prior two slices — extend, do not rewrite)

- **Bridge** `crates/prompt-library-bridge/src/main.rs`: dispatch match `:101-124` (12 commands); add 7 arms. Helpers reused as-is: `require_library` (`:491`, M2 marker guard — gives the `libraryPath`), `parse_kind` (`:524`), `parse_name` (`:539`, M3 traversal-safe), envelope (`ok_envelope`/`err_envelope`), `map_core_error` (`:677`, **extend** per W3). `WorkingCopy` import to add to the non-test `use` block; `working_files::*` path-qualified (W2). Golden-fixture test pattern at `:1101`.
- **TS models** `scripts/library_models.ts`: hand-written interfaces + `parseX` validators throwing `BridgeShapeError` (`:160`). Add `WorkingFileEntry`/`WorkingFileRole`/`WorkingFileBytes` (discriminant-validated tagged union on `kind`).
- **TS routes** `scripts/library_routes.ts`: `registerLibraryRoutes(app)` (`:359`); factored `buildX(config, …)` handlers returning `{status, body}`; `statusForCode` (`:69`, **extend** per W3); `errorResult` logs `detail` server-side, never forwards it (m4); `withWriteLock` (`:54`, D1) + `WRITE_TIMEOUT_MS` (`:41`, D4). Reads (`list`/`read`) skip the mutex; writes get the timeout (W6 note: they skip the *ledger* mutex — they never touch `installs.json` — but use the write timeout/SIGKILL).
- **Server guard** `scripts/server.ts:63-101`: Host allowlist on everything + Origin check on `POST/PATCH/PUT/DELETE`. New write endpoints inherit it; the D7 residual note (absent-Origin local process) applies identically — no new mechanism.
- **UI api** `ui/src/lib/api.ts`: read fetchers (`:464-472`) + install/drift fetchers (`:571-595`) + `sendJson` POST/DELETE helper (`:552`) + `LibraryApiError` (`:543`). Add working-file models + `getWorkingFiles`/`readWorkingFile`/`saveWorking`/`createWorkingFile`/`saveWorkingFile`/`renameWorkingFile`/`deleteWorkingFile` fetchers (GET/POST/PUT/DELETE via `getJson`/`sendJson`).
- **UI route** `ui/src/routes/Library.svelte`: Variant B, three-pane. Detail pane currently renders `detail.working` read-only `<pre>` at `:509-515`; replace with the editor. Has `resource()` usage (`:48-131`), the D2 pending-lock + captured-intent dialog (`:148-174`), `reloadInstallState` (`:183`). `ui/src/lib/library.ts`: `Cue` helpers + `dirtyCue` (`:80`, colorblind-safe). `ui/src/lib/resource.svelte.ts`: `dataEpoch` poll refetch + the documented no-read-`state.data` trap (`:34-38`).
- **Tests:** `cargo test --workspace`; `bun test scripts` (`library_routes.test.ts` stubs `runBridge`); `ui` vitest `*.svelte.test.ts` + `ui/src/lib/library.test.ts`. Fixture libraries built with core scaffolding (`main.rs:801`).

## Open questions (non-blocking; proceeding with labeled assumptions)

1. **Editor richness.** Roadmap open question 5: textarea-first vs. syntax-aware. **Assumption (per roadmap):** textarea-first ships this slice; `read_working_file` returns `ext` so a future CodeMirror/Monaco mode is a drop-in. No syntax editor now.
2. **MD primary assembly on save.** The read model splits the primary into `frontmatter`/`body` (`WorkingContent.md`, `api.ts:428`); `save_working` wants the whole `---\nfm---\nbody` blob (and validates it). **Assumption:** the UI edits frontmatter + body as one textarea (or two fields it concatenates) and sends the reassembled blob; core re-validates. Two-field is closer to the reference but one-textarea is simpler for v1 — decide in Phase 4, both hit the same validated `save_working`.
3. **Delete-working-file confirm depth.** **Assumption:** a lightweight inline confirm (delete is idempotent + git-recoverable + single ref file), not the full captured-intent dialog. The D2 dialog machinery is available if a reviewer wants parity with the install overwrite; flagged, not blocking.
4. **Reveal-in-Finder for binary refs.** The reference offers it (`commands.rs:728`); it's a native affordance (roadmap Slice 10c). **Assumption:** drop the reveal; render a copy-the-absolute-path affordance or just the size placeholder. Not blocking.

## Proposed solution

Four vertical slices, backend-first — same justification as the prior two (the UI route exists and can only render real editor data once the bridge + routes return it). Sequencing within each phase is test-/fixture-first. Phase 1 is `cargo`-green in isolation; Phases 2-3 are `bun test`-green with stubbed/fixture I/O; Phase 4 is the only user-visible change.

---

### Phase 1: Bridge working-file commands + primary save (`cargo test --workspace` green)

- **Objective:** Add `save_working`, `list_working_files`, `read_working_file`, `create_working_file`, `save_working_file`, `rename_working_file`, `delete_working_file` to the bridge dispatch, resolving the library root from `require_library(args)` (config-supplied `path`), with the network-free/secrets-free invariant preserved and the traversal guard exercised as a bridge test.
- **Why this phase exists:** Everything downstream depends on a stable working-file contract. It is the only Rust-touching phase and is independently testable against a temp library.
- **Changes:**
  - **Imports** (non-test `use` block): add `WorkingCopy` and `use prompt_library_core::working_files::{self, WorkingFileEntry, WorkingFileBytes, WorkingFileRole};` (W2 — path-qualified; the fns are not root-re-exported).
  - **Dispatch** (`main.rs:101-124`): add arms `save_working`, `list_working_files`, `read_working_file`, `create_working_file`, `save_working_file`, `rename_working_file`, `delete_working_file`. All **sync** (no `.await` — `std::fs` only).
  - **`cmd_save_working`** (primary, W1): `require_library` → `parse_kind`/`parse_name` → `content: String` from args → `WorkingCopy::new(LibraryLayout::new(&root)).save_primary_base(kind, &name, content.as_bytes())` → `map_core_error` → `json!({})`. A parse failure surfaces as `library_parse_error` (already mapped) — the file was never written.
  - **`cmd_list_working_files`**: `require_library`/`parse_kind`/`parse_name` → `working_files::list_working_files(layout, kind, &name)` → serialize `Vec<WorkingFileEntry>`.
  - **`cmd_read_working_file`**: + `path: String` arg → `working_files::read_working_file(layout, kind, &name, Utf8Path::new(&path))` → serialize `WorkingFileBytes` (tagged enum rides serde).
  - **`cmd_create_working_file`** / **`cmd_save_working_file`**: + `path`, `content` args → the respective `working_files` fn.
  - **`cmd_rename_working_file`**: + `old_path`, `new_path` args → `working_files::rename_working_file(layout, kind, &name, from, to)`.
  - **`cmd_delete_working_file`**: + `path` arg → `working_files::delete_working_file(...)` → `json!({})` (idempotent).
  - **Arg parsing:** add a small `parse_str_arg(args, "path")` helper (or reuse the inline `args.get(..).and_then(Value::as_str)` pattern); an empty/missing `path`/`content` is a `bridge_bad_request`. The `path` is **not** pre-validated in the bridge — it flows straight to the core fn, which validates via `validate_path_shape`/`validate_ref_path` (the security boundary is core's, by design; the bridge must not duplicate or weaken it).
  - **Error mapping** (`map_core_error`, W3): promote `InvalidWorkingPath` → `library_invalid_working_path`, `WorkingFileAlreadyExists` → `working_file_exists`, `WorkingFileNotFound` → `working_file_not_found`, `RefuseRenamePrimary`/`RefuseDeletePrimary` → `working_file_refuse_primary`, `TooManyWorkingFiles` → `working_file_too_many`. Confirm exact variant names against `crates/core/src/error.rs:37-52` when implementing.
- **Affected areas:** `crates/prompt-library-bridge/src/main.rs` only.
- **Dependencies:** none new — all from the already-imported `core` crate.
- **Risks:**
  - **Path traversal** is the highest-consequence surface. Mitigation: the in-core `validate_ref_path` is the boundary (11 tests, `working_files.rs:362`); the bridge adds tests feeding `../escape.md`, `/etc/passwd`, `notes/../x.md`, `SKILL.md` (primary-as-ref) asserting `library_invalid_working_path`/`working_file_refuse_primary`. **No path validation is reimplemented in TS or the bridge** — duplicating it risks divergence; core is the single source of truth.
  - **Primary parse bypass:** ensure the primary save routes through `save_primary_base` (validating), never `save_base_file` directly — the validation is the safety. Mitigation: a test saving malformed frontmatter via `save_working` asserts `library_parse_error` **and** the on-disk primary is unchanged.
- **Validation (`cargo test` in the bridge crate, extending `main.rs` tests):**
  - Build a fixture library via `fixture_library()` (`main.rs:801`); seed ref files with `WorkingCopy::save_base_file` (`main.rs:852`).
  - `list_working_files` on a scaffolded skill → primary `SKILL.md` first (`role:"primary"`); after seeding `notes.md` → both, alphabetical refs. Empty `working/base/` → `[]`.
  - `read_working_file` on a text ref → `{kind:"text", text, ext:"md"}`; on a NUL-containing file → `{kind:"binary", size}`; on `../escape.md` → `library_invalid_working_path`.
  - `create_working_file` new path → file on disk; same path again → `working_file_exists`; primary filename → `library_invalid_working_path`.
  - `save_working_file` existing → updated; missing → `working_file_not_found`.
  - `rename_working_file` `a.md`→`docs/a.md` → moved + dir created; primary as source → `working_file_refuse_primary`; dest exists → `working_file_exists`; source missing → `working_file_not_found`.
  - `delete_working_file` ref → gone; second delete → still `Ok` (idempotent); primary → `working_file_refuse_primary` and primary still on disk.
  - `save_working` valid MD blob → primary updated, `list` reflects it; malformed frontmatter → `library_parse_error`, primary unchanged on disk.
  - **Network/secrets invariant:** an assertion/comment that no `reqwest::Client`/`SecretStore` is constructed (the bridge still doesn't depend on `prompt-library-secrets`).
  - **Golden fixtures:** capture `list_working_files`/`read_working_file` (text + binary) envelopes into `scripts/fixtures/bridge/*.json` with a Rust `assert_eq!`-vs-committed test (mirror `main.rs:1101`); update `scripts/fixtures/bridge/capture.ts`.

---

### Phase 2: TS models + parsers + fixtures (`bun test scripts` green)

- **Objective:** Type the working-file envelopes and add discriminant-validating parsers, tested against committed fixture bridge output (no live Rust).
- **Why this phase exists:** Isolates the process-boundary contract (the tagged `WorkingFileBytes` union, the `WorkingFileEntry` list) so it is tested independently of Rust and HTTP.
- **Changes:**
  - **`scripts/library_models.ts`:** add `WorkingFileRole = "primary" | "ref"`; `WorkingFileEntry { path: string; role: WorkingFileRole; is_text: boolean; size_bytes: number }`; `WorkingFileBytes` discriminated union on `kind` (`{kind:"text", text, ext: string|null}` | `{kind:"binary", size: number}`). Add `parseWorkingFileEntries` / `parseWorkingFileBytes` validators throwing `BridgeShapeError` (`:160`), **validating the discriminant** so a serde rename becomes a typed error, not `undefined` in the editor.
  - No config changes — working-file commands need only the existing `libraryPath` (no `installsPath`/`home`); `loadLibraryConfig` is unchanged.
  - **Fixtures:** commit the Phase-1-captured `list_working_files`/`read_working_file_text`/`read_working_file_binary` JSON to `scripts/fixtures/bridge/`; the TS parsers are tested against the same bytes the Rust goldens assert (drift-safe both ways).
- **Affected areas:** `scripts/library_models.ts`, `scripts/library_models.test.ts`, `scripts/fixtures/bridge/*.json`, `scripts/fixtures/bridge/capture.ts`.
- **Dependencies:** Phase 1 wire contract.
- **Risks:** tagged-enum drift between the TS union and the Rust enum. Mitigation: discriminant-validating parsers + the shared fixtures asserted by both sides (the proven method).
- **Validation (`bun test scripts`, fixtures — no spawned Rust):**
  - `parseWorkingFileEntries` accepts the committed list fixture; rejects an entry with a missing `role`/renamed field.
  - `parseWorkingFileBytes` accepts both the text and binary fixtures; rejects a renamed/dropped `kind` discriminant (`BridgeShapeError`); a `binary` payload carrying no `text` parses fine (size only).

---

### Phase 3: `/api/library/*` working-file routes + route-local failure states (`bun test scripts` green)

- **Objective:** Expose the read/write working-file endpoints the Svelte editor calls, normalized and route-local — a working-file failure never degrades Observability health — with the traversal **route tripwire** as a tested assertion.
- **Why this phase exists:** Defines the exact HTTP contract the editor consumes and proves the path-traversal boundary holds end-to-end (the roadmap's risk-a).
- **Changes (all in `scripts/library_routes.ts`, registered from `registerLibraryRoutes` at `:359`):**
  - `GET  /api/library/primitives/:kind/:name/working-files` → bridge `list_working_files` → `WorkingFileEntry[]` (read, no mutex).
  - `GET  /api/library/primitives/:kind/:name/working-files/content?path=…` → bridge `read_working_file` → `WorkingFileBytes` (read). The ref path rides a **query param** (a `:path` route segment can't carry `/` for nested refs like `notes/intro.md`); the bridge validates it, so the route passes it through verbatim.
  - `POST /api/library/primitives/:kind/:name/working` → body `{ content }` → bridge `save_working` (primary save). Write timeout + SIGKILL; **no ledger mutex** (W6 — never touches `installs.json`).
  - `POST /api/library/primitives/:kind/:name/working-files` → body `{ path, content }` → bridge `create_working_file`.
  - `PUT  /api/library/primitives/:kind/:name/working-files` → body `{ path, content }` → bridge `save_working_file`.
  - `PUT  /api/library/primitives/:kind/:name/working-files/rename` → body `{ old_path, new_path }` → bridge `rename_working_file`.
  - `DELETE /api/library/primitives/:kind/:name/working-files` → body `{ path }` → bridge `delete_working_file`.
  - **Factored handlers:** `buildListWorkingFiles`/`buildReadWorkingFile`/`buildSaveWorking`/`buildCreateWorkingFile`/`buildSaveWorkingFile`/`buildRenameWorkingFile`/`buildDeleteWorkingFile(config, kind, name, body, run)` returning `{status, body}`, mirroring `buildInstall` (`:224`). Each refuses early with `errorResult(UNCONFIGURED)` if `!config.libraryPath` (working files need the layout). The `path`/`content` args come from the body/query; `libraryPath` from config — there is no install destination to contain here, but the same "config not body" discipline applies to `path` (the library root).
  - **Status mapping** (extend `statusForCode` at `:69`): `library_invalid_working_path` → 422; `working_file_exists` → 409; `working_file_not_found` → 404; `working_file_refuse_primary` → 409; `working_file_too_many` → 422. `errorResult` continues to log `detail`, never forward it (m4).
  - **Write timeout (D4):** the write verbs pass `timeoutMs: WRITE_TIMEOUT_MS`; `runBridge` already escalates to SIGKILL. Reads use the default 10 s.
- **Affected areas:** `scripts/library_routes.ts`, `scripts/library_routes.test.ts`.
- **Dependencies:** Phases 1-2.
- **Risks:** coupling working-file failures to global health. Mitigation: a test asserts a failing save (bridge error) leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.
- **Validation (`bun test scripts`, stubbed `runBridge`):**
  - Each route maps fixture output/errors to the right status + normalized `{code, message}` body (no `detail`).
  - **Traversal tripwire (risk-a):** a `working-files/content?path=../../etc/passwd` and a `create` with `path:"../escape.md"` each map the bridge's `library_invalid_working_path` to **422** — the route never reaches the fs (the bridge already refused; this asserts the end-to-end seam).
  - `create` on an existing path → 409 `working_file_exists`; `save` on a missing path → 404; primary-as-ref delete/rename → 409 `working_file_refuse_primary`; a malformed primary `save_working` → the bridge's `library_parse_error` (502/422 per existing mapping — confirm the parse-family status).
  - Observability routes unaffected when a working-file write fails. A traversal `:name` (not `:path`) is still rejected upstream as `library_invalid_name` → 422 (M3, already enforced).

---

### Phase 4: Svelte working-files tree + textarea editor (UI gate)

- **Objective:** Replace the read-only `<pre>` working-copy view with an editor: a working-files tree (primary pinned first, refs alphabetical), a textarea-first file pane that edits the primary and ref files, create/rename/delete ref-file actions, a dirty cue, and binary-file placeholders — all colorblind-safe, with the editor buffer surviving the 30s poll.
- **Why this phase exists:** The only user-visible deliverable; turns the route from a viewer into the authoring substrate.
- **Changes:**
  - **`ui/src/lib/api.ts`** (after `:595`): add the working-file models (`WorkingFileEntry`/`WorkingFileBytes`) + fetchers — `getWorkingFiles(kind,name)` (GET), `readWorkingFile(kind,name,path)` (GET, `path` as encoded query param), `saveWorking(kind,name,content)` (POST primary), `createWorkingFile`/`saveWorkingFile(kind,name,path,content)` (POST/PUT), `renameWorkingFile(kind,name,old,new)` (PUT), `deleteWorkingFile(kind,name,path)` (DELETE). Reuse `getJson`/`sendJson` (`:552`); errors throw `LibraryApiError` (`:543`) carrying the route code.
  - **`ui/src/lib/library.ts`** (after the existing cues): the existing `dirtyCue` (`:80`) already covers the primitive-level dirty badge. Add an editor-local `editorDirtyCue(isDirty)` only if the per-file dirty cue needs distinct copy from the primitive cue — otherwise reuse `dirtyCue`. No new tones (the `amber`/`cyan`/`default` Okabe-Ito-safe set covers it; never bare red/green).
  - **`ui/src/routes/Library.svelte`** (replace the `<pre>` block at `:509-515`):
    - Add `const workingFilesRes = resource(keyed by sel, (k) => sel ? getWorkingFiles(sel.kind, sel.name) : Promise.resolve([]))` — keyed on the selection (like `detailRes` at `:92`), rides the 30s poll for background refresh.
    - **Tree:** render `workingFilesRes.data` grouped/ordered as the core returns it (already sorted; no client sort). Each entry shows path, a role badge (primary vs ref), and (for refs) rename/delete actions gated by the **per-file pending lock** (W7, mirror `:148-159`). Clicking an entry sets the selected file.
    - **File pane (W4/W5):** on file-select, load content:
      - **Primary** (the `role:"primary"` entry): seed the buffer from `detail.working` (already in the detail payload — no extra fetch). For MD kinds, edit `frontmatter`+`body` (one textarea over `---\nfm---\nbody`, or two fields — open question 2); for codex_agent, the raw `text`. Save → `saveWorking(kind, name, reassembledBlob)`.
      - **Ref file:** lazy `readWorkingFile(kind, name, path)`; if `{kind:"text"}` → editable textarea seeded from `text`; if `{kind:"binary"}` → read-only placeholder ("binary file, {size} bytes"), no save. Save → `saveWorkingFile(kind, name, path, buffer)`.
      - **Buffer is plain `$state` (W5):** `let buffer = $state("")`, `let baseline = $state("")`, hydrated once on file-change via an event handler / keyed reset — **never** a `$effect` reading resource data (no-useEffect; avoids the `resource.svelte.ts:34` loop). `const isDirty = $derived(buffer !== baseline)`.
    - **Create ref file:** a "+ New file" affordance → prompt for a path → `createWorkingFile` → on success select the new file + `reloadWorkingState()`. A `working_file_exists`/`library_invalid_working_path` error renders a **route-local** inline message (e.g. "name already exists" / "invalid file name"), never the shell.
    - **Rename / delete:** rename (non-destructive, pending-lock only) → `renameWorkingFile`; delete (idempotent, lightweight confirm per open question 3) → `deleteWorkingFile`. Both `reloadWorkingState()` on success.
    - **Save discipline (W6):** on any successful write, `reloadWorkingState()` = `workingFilesRes.reload()` + `detailRes.reload()` + `primitivesRes.reload()` (the `dirty` badge), and set `baseline = buffer` for the saved file. All event-handler-driven `.reload()` (no effect).
    - **Dirty cue:** the editor shows a save button enabled only when `isDirty`; the explorer/detail head dirty badge already exists (`Library.svelte:486`) and refreshes via `primitivesRes.reload()`. Cue stays label+glyph (colorblind-safe), reusing `dirtyCue`.
    - All new states (save parse error, invalid name, exists, not-found, too-many) are **route-local** panels/inline messages — they don't touch the shell (consistent with the existing `EmptyState`/install-error usage).
  - **`ui/src/routes/Library.svelte.test.ts`** + **`ui/src/lib/library.test.ts`:** extend with the editor cases.
- **Affected areas:** `ui/src/lib/api.ts`, `ui/src/lib/library.ts` (+ `library.test.ts`), `ui/src/routes/Library.svelte` (+ `Library.svelte.test.ts`), possibly a small `WorkingFileTree.svelte`/`FileEditor.svelte` under `ui/src/lib/components/` if the route file grows unwieldy.
- **Dependencies:** Phase 3 endpoints.
- **Risks:**
  - **Lost edits across the poll (risk-b):** mitigated by W5 — buffer in plain `$state`, never bound to `resource()` data; the poll refetches the resource's `.data` only. A test asserts the buffer survives a `dataEpoch` bump.
  - **Primary-save reassembly:** an MD primary edited as `frontmatter`+`body` must reassemble to exactly `---\n{fm}---\n{body}`; core re-validates and rejects malformed → surface "fix before saving," disk unchanged. A test drives a malformed save and asserts the route-local parse message + no optimistic buffer reset.
- **Validation (`bun run test` → vitest; `*.svelte.test.ts`):**
  - `library.test.ts`: the dirty cue is distinguishable by label+glyph (not color) and uses no bare red/green tone.
  - Component tests (stub `api` with `vi.spyOn(...).mockResolvedValue(...)`):
    - Tree renders primary-first; selecting the primary seeds the buffer from `detail.working`; selecting a ref lazy-loads via `readWorkingFile`.
    - Edit→save→dirty-clear: typing flips `isDirty`; save calls the right fetcher (`saveWorking` for primary, `saveWorkingFile` for ref); on success `baseline` resets and `detailRes`/`primitivesRes` reload.
    - **Editor buffer survives a poll tick:** with an unsaved edit in the buffer, a simulated `dataEpoch` bump (background refetch) does **not** clobber the buffer (the W5/risk-b assertion).
    - **Traversal name rejected at the route → route-local message:** a `createWorkingFile` with `path:"../escape.md"` surfaces `library_invalid_working_path` as an inline "invalid file name," not the shell (the risk-a UI half).
    - Binary ref → read-only placeholder, no save button.
    - Create-exists / save-not-found / refuse-primary errors render route-local messages; no write fires before a confirm where one is shown.

---

## Acceptance criteria

- `cargo test --workspace` passes; the bridge answers `save_working`, `list_working_files`, `read_working_file`, `create_working_file`, `save_working_file`, `rename_working_file`, `delete_working_file` over the `{v,ok,data|error}` envelope against a temp library (no test writes outside the temp dir).
- The path-traversal boundary holds end-to-end: a `../`/absolute/NUL/primary-as-ref path is rejected **in-core** (`validate_ref_path`) and surfaces as `library_invalid_working_path`/`working_file_refuse_primary` → 422/409 through the route, with a bridge **and** a route tripwire test (risk-a). No path validation is reimplemented outside core.
- Primary saves go through `save_working` → `save_primary_base`, which **validates parsability before writing** — a malformed MD/TOML primary returns `library_parse_error` and leaves the on-disk file unchanged (tested).
- `read_working_file` returns the tagged text/binary union; binary files return size only (no bytes); the editor renders a placeholder for them, a textarea for text.
- `bun test scripts` covers the working-file model parsers (discriminant-validated) and every working-file route incl. route-local failure mapping; a failing write leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.
- `/library` renders an editor: a primary-first working-files tree, a textarea-first file pane editing primary + ref files, create/rename/delete ref actions, a dirty cue, and binary placeholders. The editor buffer is plain `$state` (never bound to `resource()` data) and **survives a 30s poll tick** (risk-b, tested). After any write, `detailRes`/`primitivesRes` reload so the `dirty` flag recomputes (risk-c).
- Every editor state (dirty, invalid-name, exists, not-found, binary) is distinguishable without red/green alone (label + glyph + Okabe-Ito-safe tone). No `useEffect`/bespoke effect — all reload is event-handler-driven `.reload()`; the buffer hydrates via a keyed reset, not an effect.
- The bridge stays network-free + secrets-free: no `reqwest::Client`, no `SecretStore`; `prompt-library-secrets` remains unlinked (the roadmap invariant, broken only by Slice 8).

## Dependencies and risks

- **Working-file writes touch the user's library files** — lower-consequence than the install slice's `~/.claude` writes (these stay inside the configured library, are atomic per file via `WorkingCopy::save_base_file`'s `atomic_write`, and are git-recoverable), but still real. Mitigated by: core's `validate_ref_path` boundary (11 in-core tests), the primary-save parse-before-write guard, single-file atomic writes (a killed bridge leaves at most a `.tmp` orphan, never a torn file — the same D4 safety argument), and the route-local failure isolation. **Atomicity story (per the roadmap's multi-write rule):** every working-file command is a **single** atomic file operation — the simplest case, no multi-step partial-failure surface (unlike publish/install). State this explicitly in the PR.
- **The primary/ref split is the one subtle correctness point** — a primary edit MUST route through `save_working`/`save_primary_base` (validating), never the ref path (which refuses the primary anyway). Mitigated by W1's crisp split + the parse-bypass test.
- **Contract drift** across the boundary for the tagged `WorkingFileBytes`. Mitigated by the Rust golden + discriminant-validating TS parser over shared fixtures (the proven method).
- **Scope creep into adjacent authoring slices** — `working/targets/` overlay editing (Slice 5), versioning/publish of edits (Slice 4), metadata editing (Slice 6), and primitive (not file) create/delete/rename (Slice L) are explicitly out; `list`/`read_working_file` operate on `working/base/` only (`working_files.rs:191`), the natural boundary. The network-free + secrets-free invariant is the tripwire.

## References

- Roadmap (Slice 3 objective, seams, risks, gate): `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md:80-91`
- Prior slice plans (every pattern this slice extends): `docs/plans/2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md`, `docs/plans/2026-06-11-feat-prompt-library-install-drift-slice-plan.md`
- ADRs: `docs/adr/0007-prompt-library-rust-command-bridge.md` (contract/error posture), `docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md` (write-safety precedents D1/D2/D4)
- Reference core: `prompt-library/crates/core/src/working_files.rs` (`:62-193` fns, `:293`/`:329` guards, `:362-470` tests, `:19-55` `WorkingFileEntry`/`WorkingFileBytes`), `working_copy.rs:67` (`save_primary_base`) + `:167` (`validate_primary_bytes`), `layout.rs:50` (`working_base`), `domain.rs:175` (`primary_filename`), `error.rs:37-52` (working-file error variants)
- Reference Tauri command bodies to port: `prompt-library/src-tauri/src/commands.rs:349` (`save_working`), `:610` (`list_working_files`), `:626` (`read_working_file`), `:645` (`create_working_file`), `:666` (`save_working_file`), `:686` (`rename_working_file`), `:708` (`delete_working_file`)
- Dashboard seams (extend, don't rewrite): `crates/prompt-library-bridge/src/main.rs` (dispatch `:101-124`, `require_library` `:491`, `parse_name` `:539`, `map_core_error` `:677`, golden test `:1101`, fixture `:801`), `scripts/library_models.ts:160`, `scripts/library_routes.ts` (`registerLibraryRoutes` `:359`, `statusForCode` `:69`, `withWriteLock` `:54`, `WRITE_TIMEOUT_MS` `:41`, `buildInstall` `:224`), `scripts/server.ts:63-101`, `ui/src/lib/api.ts` (`getJson`/`sendJson` `:552`, fetchers `:464-595`), `ui/src/lib/library.ts:80` (`dirtyCue`), `ui/src/lib/resource.svelte.ts:34-38` (the no-read-`state.data` trap), `ui/src/routes/Library.svelte:509-515` (the `<pre>` to replace) + `:148-187` (D2 lock + reload discipline)

## Next step

**Phase 1 is unblocked.** Start with the bridge dispatch arms + the temp-library working-file tests (the riskiest, most isolated work) — in particular the traversal tripwire and the primary parse-bypass test, the two correctness anchors. Recommended: `/workflows:work docs/plans/2026-06-11-feat-prompt-library-working-copy-editor-slice-plan.md`, or `/workflows:deepen-plan` first if you want the MD-primary reassembly (open question 2) and the delete-confirm depth (open question 3) pinned before coding.

Two source-grounded decisions to make at Phase 4 (both non-blocking): (2) MD primary as one textarea vs. frontmatter/body fields, and (3) delete-ref-file inline confirm vs. the full D2 captured-intent dialog. Both hit the same validated core paths; pick the simpler unless a reviewer wants install-slice parity.
