# Prompt Library Consolidation — Slice L: Primitive Lifecycle — Implementation Plan

> **Status (2026-06-12): ✅ SHIPPED on `feat/library-lifecycle`** in three phases —
> Phase 1 bridge dispatch + the `PrimitiveAlreadyExists`→`library_primitive_exists` (409)
> mapping (`1513c03`), Phase 2 TS routes + models (`74989aa`), Phase 3 explorer + detail UI
> (`7af7c5a`). All open questions resolved: import takes `withWriteLock` (Q1, yes);
> **forget is NOT surfaced in the UI** — it has no natural home until the bootstrap
> Reconcile view (Slice 2), so its bridge/route/fetcher ship ready but unwired (Q2);
> create's primary-filename preview was kept minimal — no kind-info call (Q3); commit
> messages are inline `format!`, ported verbatim from the reference (Q4). The
> write-lock split deviates from the plan's "every mutating verb locked" to follow the
> shipped publish-vs-reimport invariant (lock IFF the command mutates installs.json):
> **create/duplicate unlocked** (publish posture), **delete/rename/import/forget locked**.
> Gates green: `cargo test --workspace` (664), `bun test scripts` (361), Library vitest
> (163), `svelte-check` 0, `tsc` clean, `cargo clippy -p prompt-library-bridge` clean
> (2 workspace-wide clippy warnings remain in `core/src/find.rs` + `core/tests/folder_import.rs`
> — both pre-date this branch, not lifecycle code).

- **Date:** 2026-06-12
- **Type:** feat
- **Roadmap:** [docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md](2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md) (Slice L, line 142)
- **Consumes the commit-on-write posture settled by Slice 4** (`docs/plans/2026-06-12-feat-prompt-library-versioning-publishing-slice-plan.md`): `cmd_publish` (`crates/prompt-library-bridge/src/main.rs:699-715`) is the exact template — `core fn → map_core_error → commit_change → return {committed, commit_error}`.
- **Builds on (shipped):** read-only (#4), install/drift (#5), working-copy editor (#3, #6), versioning (#4), overlays (#5), metadata (#6), reimport (#7), search (#9). Every seam below is **extended, not rebuilt**.

## Overview / problem statement

The Library route can author, version, install, overlay, and search Primitives — but it cannot **create, delete, rename, duplicate, import, or forget** them. Those six structural-CRUD operations are the explorer's "+"/context-menu surface. All six exist as ported core functions in `crates/core` and as reference command bodies in `prompt-library/src-tauri/src/commands.rs`; this slice is **bridge + route + UI wiring** plus the one core-error-mapping gap that lifecycle is the first slice to hit.

The slice's distinguishing risk is destructiveness: `delete_primitive` force-uninstalls every target and `rm -rf`s the library directory. The UI for delete is as much a deliverable as the wiring — a two-phase, colorblind-safe confirm that lists what is installed and versioned.

## Repository facts (verified at source, 2026-06-12)

### Core functions are all present and tested

- `crates/core/src/scaffold.rs:70` `scaffold_primitive(layout, kind, name, now, source)` — writes `metadata.yaml` + the primary file; errors `PrimitiveAlreadyExists` if the dir exists. `source: None` for a blank create (the dashboard create path; URL-seeded import is Slice 10b, not here).
- `crates/core/src/library_drift.rs:75` `forget_primitive(installs_file_path, kind, name) -> bool` — drops install records only; idempotent.
- `crates/core/src/library_drift.rs:118` `delete_primitive(DeletePrimitiveRequest{layout, install_paths, installs_file_path, kind, name}) -> DeletePrimitiveSummary{uninstall, library_dir_removed}` — force-uninstalls every recorded target, `rm -rf`s the dir, then `forget`s. Bails before the `rm -rf` if any per-target uninstall has `failures`.
- `crates/core/src/rename.rs:36` `rename_primitive(RenamePrimitiveRequest{layout, installs_file_path, kind, old_name, new_name}) -> RenamePrimitiveSummary{install_records_updated}` — `fs::rename` the dir, then rewrites every `installs.json` record's `name`. Errors `PrimitiveNotFound`/`PrimitiveAlreadyExists`.
- `crates/core/src/duplicate.rs:32` `duplicate_primitive(DuplicatePrimitiveRequest{layout, kind, source_name, new_name, now_rfc3339}) -> DuplicatePrimitiveSummary{new_name}` — copies `working/` verbatim + fresh `created_at`; does **not** carry versions or install records.
- `crates/core/src/import_path.rs:39` `import_primitive_from_path(layout, home, installs_file_path, source_path, now) -> ImportFromPathResult` (tagged: `Imported`/`AlreadyExists`/`NotClassifiable`). **Depends on `home`** and `classify_path` against `SCAN_MATRIX` (`scanner.rs`) — it classifies a path *already under a recognized install root*, then scaffolds at v1 and writes an install record via `execute_creates`.

All five non-forget functions return `Result<_, core::Error>` and are exercised by in-crate tests (`scaffold.rs`, `rename.rs`, `duplicate.rs`, `import_path.rs`, `library_drift.rs` test modules). `forget` is a `bool`.

### The bridge already has every helper lifecycle needs

- `install_context(args) -> (InstallPaths, Utf8PathBuf)` (`main.rs:1005`) resolves `home` + `installs_path` from request args (the TS layer injects them from config — `config.home`, `config.installsPath`; see `buildInstall:280-281`). delete/rename/import/forget reuse this verbatim.
- `require_library(args)` (`main.rs:945`) resolves the library root. create/delete/rename/duplicate need it; forget does not (works off `installs.json` only — exactly like `cmd_uninstall:357`).
- `commit_change(repo, message) -> (committed, commit_error)` (`main.rs:1243`) is the commit-on-write helper Slice 4 built: `.git` absent → `(false, None)`; nothing staged → `(false, None)`; identity/hook failure → `(false, git-stderr)`. **Never an error** — the commit failure rides back in the result body, route returns 200. This is the posture lifecycle mirrors.
- `parse_kind`/`parse_name`/`parse_required_str` parsers exist. A second name (rename's `new_name`, duplicate's `new_name`, import's `source_path`) needs a parser following the `parse_name`/`parse_required_str` shape.

### The one load-bearing gap: `PrimitiveAlreadyExists` is unmapped

`map_core_error` (`main.rs:1320-1395`) does **not** have an arm for `CoreError::PrimitiveAlreadyExists` (`crates/core/src/error.rs:73`). It currently falls into `_ => ("bridge_command_failed", ...)` → **502**. create, rename, and duplicate all return this variant on a name collision — a normal, user-actionable state ("that name is taken"), not a bridge fault. **This slice must add the arm** (→ a new code, e.g. `library_primitive_exists`, mapped to **409** in `statusForCode`). `PrimitiveNotFound` is already mapped → `primitive_not_found` → 404 (`main.rs:1327`, `library_routes.ts:119`), which covers rename/duplicate of a missing source.

### TS + UI seams to extend (not rewrite)

- `scripts/library_routes.ts`: `withWriteLock` (`:63`), `statusForCode` (`:78`), `errorResult`/`UNCONFIGURED`, `WRITE_TIMEOUT_MS`, the `build*` handler family, and route registration (`:902-1014`). Lifecycle routes mount under `/api/library/primitives` (and a collection-level `POST /api/library/primitives` for create + a separate import route).
- `scripts/library_models.ts`: parsers for `DeletePrimitiveSummary`, `RenamePrimitiveSummary`, `DuplicatePrimitiveSummary`, `ImportFromPathResult`, and the commit-result shape `{committed, commit_error}` (publish already has a `PublishResult` parser to mirror).
- `ui/src/routes/Library.svelte`: the explorer pane (`filterPrimitives:90`, `selectPrimitive:330`, `selectionKey`, the primitive list `:909-916`). Lifecycle affordances attach here (a create button + per-row context actions) and to the detail pane (delete/rename/duplicate on the selected primitive).
- `ui/src/lib/library.ts`: the colorblind-safe `Cue` vocabulary to extend for the destructive-confirm state.
- `ui/src/lib/api.ts`: read + write fetchers to add the six lifecycle calls to.

### Invariants this slice inherits (cross-cutting, roadmap §220)

- **All writes go through the Rust core**; the route acquires `withWriteLock` for every mutating verb; writes get `WRITE_TIMEOUT_MS` + the SIGKILL watchdog.
- **Secrets-free / network-free.** Lifecycle constructs no `SecretStore` and makes no network call. `import_primitive_from_path` is a *local* path classify — **not** the URL-import path (`fetch_primitive_from_url` / `url_import.rs`), which is Slice 10b and rides Slice 8's network posture. The bridge `Cargo.toml` secrets-free comment stays the tripwire.
- **Route-local failure:** a failed lifecycle op leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200 — a tested assertion (#5 precedent).
- **Colorblind-safe** (Scott is red/green colorblind): the destructive-confirm and the "N installed copies keep the old name" caveat are label+glyph+Okabe-Ito tone, never bare red/green.
- **No `useEffect`:** all post-write reload is event-handler-driven `.reload()` on the affected `resource()` (the primitives list + drift batch after create/delete/rename/duplicate/import; the detail resource after rename/duplicate selection change).

## Current state

### Facts
- All six core functions are imported, exported from `crates/core/src/lib.rs`, and unit-tested in-crate.
- The bridge has `install_context`, `require_library`, `commit_change`, and the parser helpers lifecycle needs.
- `cmd_publish` (`main.rs:699-715`) is the exact commit-on-write template, settled by Slice 4.
- `PrimitiveAlreadyExists` is unmapped in `map_core_error` → currently a 502; this is the only new error-mapping work.
- `PrimitiveNotFound` is already mapped → 404.
- The explorer (`Library.svelte`) has `selectPrimitive`/`selectionKey`/`filterPrimitives` and a primitive list to hang affordances on.

### Assumptions (labeled — confirm in implementation, not blocking)
- **A1 — Commit-on-write per op.** Every lifecycle op commits immediately (reference: each command calls `commit_change`/`commit_publish` after the core write), matching Slice 4 and roadmap open-question #1. Delete commits a deletion; rename commits a move; duplicate/create/import commit the new tree. Assumption: mirror the reference exactly, one commit per op, non-fatal (rides back in the result).
- **A2 — Import-from-path is the *local-path classify* flavor, scoped to "a path already under a recognized install root."** The reference's drag-drop fast path. The web redesign (roadmap 10a) is a **typed path input + server-side existence/classification**, not a native picker. `NotClassifiable` is a normal 200 result the UI routes on (it tells the user "this isn't auto-importable — use bootstrap," which lands in Slice 2). Assumption: ship import-from-path as a typed-path form returning the tagged result; do **not** attempt the bootstrap fallback here.
- **A3 — `home` for import comes from `config.home`** (same `CC_LIBRARY_HOME` mechanism `install_context` already uses), not from the request body — the route is the containment boundary (D7).
- **A4 — Delete's two-phase confirm sources its "what's installed/versioned" list from already-loaded data:** the per-primitive drift/installs resource (`list_installs_for_primitive`, `scan_drift`) and the version list, so the confirm needs no new read command.

### Open questions (resolve in implementation; none block starting)
1. **Does `import_primitive_from_path` need a `withWriteLock`-distinct posture?** It writes `installs.json` (via `execute_creates`) *and* the library tree, then commits. Like reimport (`buildReimport`, which took the lock because core touches `installs.json`), import should take `withWriteLock`. Confirm: yes, lock it.
2. **Forget vs delete UI placement.** `forget_primitive` is the "library dir is already gone, just clean up records" path — surfaced by the reference's Reconcile dialog, not a primary explorer action. Decide whether forget is a primary affordance or only appears on a `Missing`-drift primitive (lean: the latter — it's a reconcile action, not a CRUD verb the user reaches for).
3. **Does create need the kind-info table for the primary-filename preview?** The explorer create form picks a kind + name; the primary file is derived in-core (`kind.primary_filename`). The UI likely wants `kind-info` (already a read route) to show "this will create `SKILL.md`". Confirm whether to surface that or keep create minimal.
4. **Commit message format for each op** — the reference uses `create(dir/name)`, `delete(dir/name)`, `rename(dir/old -> new)`, `duplicate(dir/src -> new)`, `import(filename)` (`commands.rs:313-1170`). Port these verbatim into bridge-side `format_*` helpers (mirroring `format_publish_commit_message:1274`) or inline `format!`. Lean: inline `format!` like `cmd_set_current_version:730` — they're one-liners with no notes body.

## Proposed plan

Sequenced as **three phases** (Rust/bridge → TS routes/models → UI), test-first within each. This is the established slice shape (#3/#4/#7). The non-committing/install-aware half (forget) and the committing half (create/delete/rename/duplicate/import) ship together — Slice 4 already landed, so the commit-on-write dependency the roadmap flagged is **met**; there is no reason to split.

### Phase 1: Bridge dispatch + the error-mapping gap

- **Objective:** Six new dispatch arms wrapping the six core functions, each mirroring the publish commit-on-write template; close the `PrimitiveAlreadyExists` mapping gap.
- **Changes:**
  - `map_core_error` (`main.rs:1320`): add `CoreError::PrimitiveAlreadyExists { .. } => ("library_primitive_exists", "a primitive with that name already exists")`, promoted out of the catch-all. (Tested as a tripwire: a duplicate-name create returns this code, not `bridge_command_failed`.)
  - `cmd_create_primitive` (async): `require_library` → `parse_kind`/`parse_name` → `scaffold_primitive(layout, kind, &name, &now, None)` → `commit_change(&root, &format!("create({}/{})", kind.dir_name(), name.as_str()))` → return `{committed, commit_error}`. `now` is supplied by the TS layer (the Slice-4 deviation: bridge stays clock-free; TS injects `created_at`, shape-checked by `looks_like_rfc3339`).
  - `cmd_delete_primitive` (async): `require_library` + `install_context` → `delete_primitive(DeletePrimitiveRequest{..})` → if `summary.uninstall.failures` non-empty, **return the summary WITHOUT committing** (the dir wasn't removed — nothing to commit; mirror core's bail) → else `commit_change("delete(dir/name)")` → return `{summary, committed, commit_error}`.
  - `cmd_rename_primitive` (async): `require_library` + `install_context` + a `new_name` parse → `rename_primitive(..)` → `commit_change("rename(dir/old -> new)")` → return `{summary, committed, commit_error}`.
  - `cmd_duplicate_primitive` (async): `require_library` + `new_name` parse → `duplicate_primitive(..)` → `commit_change("duplicate(dir/src -> new)")` → return `{summary, committed, commit_error}`.
  - `cmd_import_primitive_from_path` (async): `require_library` + `install_context` (gives `home` + `installs_path`) + `parse_required_str(args, "source_path")` → `import_primitive_from_path(layout, &home, &installs_path, &source_path, &now)` → commit only on `Imported` (an `AlreadyExists`/`NotClassifiable` result wrote nothing) → return `{result, committed, commit_error}`.
  - `cmd_forget_primitive` (sync): `install_context` only (no library root) → `forget_primitive(&installs_path, kind, &name)` → return `{removed: bool}`. **No commit** — it touches only the dashboard-owned `installs.json` (gitignored / outside the library repo), exactly like uninstall.
  - Register all six in `dispatch` (`main.rs:109`).
- **Affected areas:** `crates/prompt-library-bridge/src/main.rs` (dispatch + 6 `cmd_*` + 1 `map_core_error` arm + possibly a `parse_new_name` helper).
- **Dependencies:** none beyond what's shipped.
- **Risks:**
  - **Delete commit-on-failure:** if uninstall partially failed, core leaves the dir in place and returns failures; the bridge must **not** commit (nothing changed in the library tree) and must surface the failures in the summary. Test: a delete with a wedged target returns failures + `committed:false` + dir still present.
  - **Import's `NotClassifiable`/`AlreadyExists` are normal 200 data**, not errors — same posture as install's `colliding_content`. Don't map them to an error code; the UI routes on the tag.
  - **Partial create** (scaffold writes `metadata.yaml` then the primary file, both via `atomic_write`): a kill between the two leaves a dir with metadata but no primary. Acceptable + recoverable (re-create errors `PrimitiveAlreadyExists`; the user deletes + retries, or the editor surfaces the missing primary). State this explicitly (D3 not-atomic-across-files), add a kill-mid-create test via the same mechanism Slice 4 used for kill-mid-publish.
- **Validation:** `cargo test --workspace`:
  - each op round-trips against a temp library (create→list shows it; delete→gone; rename→dir moved + install records rewritten; duplicate→new dir, no versions/installs carried; import→scaffolded at v1 + install record; forget→records dropped).
  - **`PrimitiveAlreadyExists` → `library_primitive_exists` tripwire** (create over an existing name).
  - **`PrimitiveNotFound` → `primitive_not_found`** (rename/duplicate of a ghost).
  - **delete-with-failures does not commit + dir survives.**
  - **rename migrates install records** (the `install_records_updated` count matches; unrelated records untouched — the core test already proves the core fn; the bridge test proves the count rides back).
  - **import of a path outside any install root → `NotClassifiable` 200**, no library mutation, no commit.
  - **kill-mid-create leaves a recoverable state** (D3).
  - commit lands on a `.git`-bearing temp library; `.git`-absent → `committed:false` no error.

### Phase 2: TS routes + models

- **Objective:** Six `build*` handlers + their models/parsers + route registration, every mutating verb under `withWriteLock` + `WRITE_TIMEOUT_MS`, with the new 409 mapping.
- **Changes:**
  - `library_routes.ts`: `statusForCode` — add `case "library_primitive_exists": return 409;` (alongside `working_file_exists`/`library_version_exists` — same "name/label taken, pick another" family).
  - `build*` handlers, mirroring `buildPublish`/`buildReimport`:
    - `buildCreatePrimitive(config, kind, name, run, now)` — needs `config.libraryPath` (refuse early if unconfigured); injects `created_at: now`; `withWriteLock`; returns `{committed, commit_error}` at 200 even on commit-fail.
    - `buildDeletePrimitive(config, kind, name, run)` — needs `libraryPath` + `home` + `installs_path`; `withWriteLock`; returns the `DeletePrimitiveSummary` + commit flags. A summary with uninstall `failures` is a **normal 200** (the UI inspects it), not an error — same as install's `colliding_content`.
    - `buildRenamePrimitive(config, kind, oldName, newName, run)` — `withWriteLock`; returns `{summary, committed, commit_error}`.
    - `buildDuplicatePrimitive(config, kind, sourceName, newName, run, now)` — `withWriteLock`; returns `{summary, ...}`.
    - `buildImportFromPath(config, sourcePath, run, now)` — injects `home`/`installs_path` from config (A3 — never from the body); `withWriteLock`; returns the tagged `ImportFromPathResult` + commit flags at 200 (including `NotClassifiable`/`AlreadyExists`).
    - `buildForgetPrimitive(config, kind, name, run)` — `home`/`installs_path` only; `withWriteLock` (it writes `installs.json`); returns `{removed}`.
  - `library_models.ts`: `parseDeletePrimitiveSummary`, `parseRenamePrimitiveSummary`, `parseDuplicatePrimitiveSummary`, `parseImportFromPathResult` (a tagged union — mirror the `primary_filename` tagged-union parser already in this file), and a shared `{committed, commit_error}` envelope parser (or reuse the publish one).
  - Route registration (`:951` block):
    - `POST /api/library/primitives` (create — collection-level; body `{kind, name}`).
    - `DELETE /api/library/primitives/:kind/:name` (delete).
    - `POST /api/library/primitives/:kind/:name/rename` (body `{new_name}`) — a POST sub-action, not a PATCH on the resource, to match the working-file rename precedent (`:982`).
    - `POST /api/library/primitives/:kind/:name/duplicate` (body `{new_name}`).
    - `POST /api/library/import-from-path` (body `{source_path}`) — collection-level, mirrors `import-installs:967`.
    - `POST /api/library/primitives/:kind/:name/forget` (or fold into the drift-reconcile UI — see open-Q2).
- **Affected areas:** `scripts/library_routes.ts`, `scripts/library_models.ts` (+ `.test.ts` for each).
- **Dependencies:** Phase 1.
- **Risks:**
  - **`source_path` containment.** `import-from-path` takes a user-supplied path. The bridge passes it to `classify_path`, which only matches paths under `home`'s install roots (`SCAN_MATRIX`) — a path outside returns `NotClassifiable`, so traversal is naturally contained (it can't redirect a write outside the install roots, and the scaffold dest is `(kind,name)`-derived in-core, not path-derived). Still: assert the route logs but never forwards the path (m4), and test a `../`-laden source returns `NotClassifiable`, not a write.
  - **`PrimitiveName` validation at the boundary** (rename/duplicate `new_name`): a malformed name → `library_invalid_name` → 422 (already mapped, M3 from the read slice). Test it.
- **Validation:** `bun test scripts`:
  - route code→HTTP mapping incl. the new `library_primitive_exists` → 409.
  - every mutating handler acquires the write lock (the established mutex assertion).
  - `home`/`installs_path` are injected from config, **never read from the request body** (the D7 tripwire test the install routes have).
  - model parsers round-trip real bridge shapes (capture via the `seed_fixture_library` + `capture.ts` flow if a new fixture is needed); the `ImportFromPathResult` tagged-union parser handles all three variants.
  - a delete summary with `failures` is a 200 (not coerced to an error).
  - **route-local failure:** a failed lifecycle op leaves `/api/summary` + `/healthz` at 200.

### Phase 3: Explorer + detail UI

- **Objective:** Create, delete, rename, duplicate, import affordances in the Library route, with the destructive-confirm as a first-class deliverable.
- **Changes:**
  - **Create:** a "+ New primitive" affordance in the explorer header → a small form (kind select + name input + `library_invalid_name` field error surfaced inline, never a generic toast). On success: `.reload()` the primitives list + select the new primitive. (Optionally show the derived primary filename via the existing `kind-info` read — open-Q3.)
  - **Duplicate / Rename:** per-primitive actions (detail pane or explorer context) → name-input dialogs. Rename surfaces the **"N installed copies keep the old name until reinstalled" caveat** from `RenamePrimitiveSummary.install_records_updated` (colorblind-safe info cue, not a warning red). On success: reload primitives + reselect under the new name.
  - **Delete — the headline UI work:** a **two-phase confirm** that lists, from already-loaded data (A4), what is **installed** (the per-target install/drift rows) and **versioned** (the version list), so the user sees the blast radius before confirming. Use the captured-intent + pending-write lock pattern (#5 D2): no `delete` fires before the second confirm; the confirm button is disabled while the request is in flight. The destructive state uses a **label+glyph+Okabe-Ito tone** cue (extend `library.ts`'s `Cue` vocab), never bare red. On a summary with `failures`, surface them (a target the uninstall couldn't reach) rather than reporting success. On success: reload primitives + clear the selection.
  - **Import-from-path:** a typed-path input (roadmap 10a web redesign — no native picker) → routes the tagged `ImportFromPathResult`: `Imported` → reload + select; `AlreadyExists` → "already in the library" message; `NotClassifiable` → "this path isn't auto-importable" with a pointer toward bootstrap (Slice 2), not an error toast.
  - **Forget** (open-Q2): lean toward surfacing it only on a `Missing`-drift primitive's reconcile row, not as a primary CRUD verb.
  - **Commit feedback:** every op's `{committed, commit_error}` follows the publish UI precedent — a `commit_error` shows an amber (not red) "saved but not committed" cue; the library write still succeeded.
- **Affected areas:** `ui/src/routes/Library.svelte`, `ui/src/lib/library.ts` (Cue vocab), `ui/src/lib/api.ts` (six fetchers).
- **Dependencies:** Phase 2.
- **Risks:**
  - **Delete is the most destructive non-git action in the whole consolidation.** Two-phase confirm + blast-radius list + in-flight lock are non-negotiable; the confirm copy is part of the deliverable, reviewed for clarity.
  - **Selection state after rename/duplicate/delete** must not dangle (a deleted/renamed `selectionKey` no longer resolves). Reload the list and re-derive selection explicitly in the success handler (no `useEffect` — event-handler-driven).
  - **Stale drift/install badges after delete:** the explorer's drift batch and the per-primitive installs must be reloaded so a deleted primitive's badges disappear.
- **Validation:** `*.svelte.test.ts` (Library vitest):
  - delete two-phase confirm: no request fires before the second confirm; the confirm lists installs + versions; the destructive cue is distinguishable **without color** (label/glyph assertion).
  - rename caveat renders the install-records-updated count.
  - create with an invalid name shows the field error, not a generic toast.
  - import routes each `ImportFromPathResult` variant to the right UI message.
  - a `commit_error` shows the amber "not committed" cue, op still reads as succeeded.
  - post-op the primitives list reloads and selection resolves (no dangling selection after delete/rename).

## Acceptance criteria

- All six reference commands (`create_primitive`, `delete_primitive`, `rename_primitive`, `duplicate_primitive`, `import_primitive_from_path`, `forget_primitive`) are ported as bridge dispatch arms wrapping the existing core functions, each (except forget) mirroring the Slice-4 commit-on-write template.
- `CoreError::PrimitiveAlreadyExists` is promoted out of `map_core_error`'s catch-all to `library_primitive_exists` → **409** — a name collision is a user-actionable conflict, never an opaque 502.
- Rename migrates `installs.json` records and the UI surfaces the "N installed copies keep the old name" caveat from the returned count.
- Delete is gated behind a two-phase, colorblind-safe confirm that lists what's installed and versioned before firing, never fires before the second confirm, and surfaces per-target uninstall failures instead of reporting false success.
- Import-from-path is a typed-path form (no native picker) that routes the tagged `Imported`/`AlreadyExists`/`NotClassifiable` result; `home`/`installs_path` come from config, never the request body.
- The slice constructs no `SecretStore` and makes no network call; the bridge `Cargo.toml` stays secrets-free; a failed lifecycle op leaves `/api/summary`, `/healthz`, `/api/agents`, and doctor at 200.
- Every commit-on-write op returns `{committed, commit_error}` and renders a `commit_error` as an amber "not committed" cue, never red.
- Gates green: `cargo test --workspace`, `bun test scripts`, the Library `*.svelte.test.ts`, `svelte-check`/`tsc`/`clippy` clean.

## Dependencies and risks

- **Slice 4 (commit-on-write) — MET.** The `commit_change` helper and the `{committed, commit_error}` posture are shipped; lifecycle consumes them directly. No split needed (the roadmap's "split or sequence after Slice 4" caveat is resolved by Slice 4 having landed).
- **The unmapped `PrimitiveAlreadyExists`** is the single non-obvious wiring gap — easy to miss because the core functions and bridge helpers are all present, but it's the difference between a clean 409 and a confusing 502 on the most common lifecycle error (name collision).
- **Delete's destructiveness** is the headline risk; the UI confirm is as load-bearing as the wiring.
- **Import-from-path's `home` dependency** (via `classify_path`/`SCAN_MATRIX`) is the only lifecycle op coupled to the install-roots layout; it's already plumbed by `install_context`, but the web redesign (typed path, A2/10a) means import only handles paths *already under an install root* — a free-form folder import is the bootstrap wizard (Slice 2), out of scope here.

## References

- Reference commands: `prompt-library/src-tauri/src/commands.rs` — `create_primitive:282`, `forget_primitive:1036`, `delete_primitive:1057`, `rename_primitive:1099`, `import_primitive_from_path:1143`, `duplicate_primitive:1181`.
- Core (this repo): `crates/core/src/scaffold.rs:70`, `library_drift.rs:75,118`, `rename.rs:36`, `duplicate.rs:32`, `import_path.rs:39`; error variant `crates/core/src/error.rs:73`.
- Commit-on-write template (Slice 4): `crates/prompt-library-bridge/src/main.rs` — `cmd_publish:699`, `commit_change:1243`, `format_publish_commit_message:1274`, `map_core_error:1320`, `install_context:1005`, `require_library:945`.
- TS seams: `scripts/library_routes.ts` (`withWriteLock:63`, `statusForCode:78`, `buildInstall:267`, `buildReimport:413`, route registration `:902-1014`), `scripts/library_models.ts`.
- UI seams: `ui/src/routes/Library.svelte` (`filterPrimitives:90`, `selectPrimitive:330`, primitive list `:909`), `ui/src/lib/library.ts` (Cue vocab), `ui/src/lib/api.ts`.
- Roadmap: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` (Slice L `:142`, cross-cutting `:220`, native-affordance 10a `:212`).

## Next step

Execute Phase 1 (bridge + the `PrimitiveAlreadyExists` mapping) — it's the lowest-risk, highest-leverage slice (all core fns + helpers exist; the only new logic is the six thin commit-on-write wrappers and one error arm). Recommended: `/workflows:work docs/plans/2026-06-12-feat-prompt-library-lifecycle-slice-plan.md`. Resolve open-Q2 (forget placement) and open-Q3 (create form's kind-info preview) during Phase 3 UI work — neither blocks Phase 1/2.
