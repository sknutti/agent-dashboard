# Prompt Library Consolidation — Slice 7: Reimport-from-drift — Implementation Plan

> **Status:** ✅ SHIPPED (2026-06-12) on `feat/library-reimport-from-drift`. Landed as 3 phases — Phase 1 bridge `reimport_install` (async, commits on `Reimported` only; 8 tests), Phase 2 `POST …/reimport` route + `ReimportResult` model (takes `withWriteLock`, unlike publish; 32 tests), Phase 3 the three-action drift row + dirty/broken-source flows (11 tests). Gate green: cargo 645 · scripts 307 · UI 137. **Two decisions settled in-flight worth noting: (1)** reimport COMMITS on the `Reimported` outcome — a deliberate DIVERGENCE from the reference (which never commits reimport), justified by the dashboard's Slice-4 commit-on-write posture (an uncommitted version tree would otherwise be swept into a later publish's commit under the wrong message). **(2)** `MaterializeShape` stays in the 502 catch-all (Open Q1 default). The plan below is retained as the historical record.

- **Date:** 2026-06-12
- **Type:** feat
- **Roadmap:** [2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md](2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md) (Slice 7 section, lines 153-161). This deepens that slice; the roadmap's invariants (write-safety inheritance, colorblind cues, route-local failure, secrets-free) apply unchanged.
- **Builds on (shipped):** the **install/drift slice** (PR #5 — the `Modified` drift row, `scan_drift`, `acknowledge_drift`, the two-phase confirm dialog) and **Slice 4 / versioning** (`39933b8` — `VersionStore::snapshot`, the `publish` commit-on-write posture, `PublishResult`, `read_primitive_version`). Reimport sits at the intersection: it is *a version snapshot of foreign bytes that also re-baselines an install record.*
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Drift · Reimport · Version · Overlay · Working copy · Install record.

## Overview / problem statement

The install/drift slice opened a one-way loop: the Library deploys to disk (install), and when the on-disk copy is edited out-of-band the dashboard *detects* it (`Modified` drift) and can either **Acknowledge** (adopt the on-disk bytes as the install baseline, Library untouched) or **Update/Reinstall** (overwrite disk with the Library's current version). What is missing is the **inverse**: pull the on-disk edits *back into the Library* as a new published version. That is reimport, and it closes the round-trip.

The core function (`crates/core/src/reimport.rs:89`, `reimport_install_as_version`) is **already imported, fully implemented, and exhaustively tested** (13 in-crate tests covering clean reimport, dirty-working block, broken-source, fixed-primary retry, multi-target overlay routing, Agent/Claude filename inversion, install-missing, and stale-file pre-wipe). This slice is **bridge wiring + TS route/model + UI** — no new core logic.

The slice's stated UI deliverable (roadmap risk a) is the **three-distinguishable-actions copy** on a `Modified` drift row. After this slice a drifted row offers, in order:

| Action | Direction | Destroys | Today |
|---|---|---|---|
| **Acknowledge** | adopt disk as the install baseline | nothing (re-baselines the record) | shipped (`doAcknowledge`) |
| **Reinstall** (currently labelled "Update") | overwrite **disk** with the Library's current version | the on-disk edits | shipped (`doInstall`, force-on-collision) |
| **Reimport** (new) | pull **disk** into the **Library** as a new version | nothing on disk; *can* discard unpublished working-copy edits (with confirm) | **this slice** |

Two of these are destructive in opposite directions (Reinstall → disk, Reimport-with-discard → working copy), and the third is non-destructive — so the **labels and confirm copy are the load-bearing deliverable**, not the wiring.

## Repository facts (verified at source, 2026-06-12)

### Core (no changes needed — read-only dependency)

- `crates/core/src/reimport.rs:89` — `reimport_install_as_version(req: ReimportRequest) -> Result<ReimportResult, Error>`. Exported from `lib.rs:98` as `reimport_install_as_version, ReimportRequest, ReimportResult`.
- `ReimportRequest` (reimport.rs:42-62) fields: `layout`, `install_paths`, `installs_file_path`, `kind`, `name`, `source_target`, `new_version` (a `VersionLabel`), `created_at: &str` (verbatim, core does ZERO validation — same as publish), `notes: Option<String>`, `discard_working: bool`, `fixed_primary_bytes: Option<Vec<u8>>`.
- `ReimportResult` (reimport.rs:66-87) is a `#[serde(tag = "kind", rename_all = "snake_case")]` enum — a tagged union exactly like `TargetOutcome`/`DriftStatus`. Variants:
  - `Reimported { new_version: VersionLabel }` — snapshot wrote, `current.txt` advanced, `installs.json` re-baselined → next drift scan reads Clean.
  - `WorkingCopyDirty` — `working/` diverges from the current pinned version; the UI must confirm-then-retry with `discard_working: true`.
  - `BrokenSource { primary_path: String, raw_bytes: Vec<u8>, parse_error: String }` — the on-disk primary file's frontmatter/TOML won't parse; the UI offers a fix sheet, the user edits, retry with `fixed_primary_bytes`.
  - `NotInstalled` — no record for `(kind, name, source_target)`.
  - `InstallMissing` — the recorded install path is gone from disk.
- **Every variant is an `Ok(...)` outcome, not an `Err`.** It rides the bridge `ok` envelope as data the UI routes on, identical to how `InstallSummary` rides install (the install slice's precedent). `Err(core::Error)` from reimport only fires on genuine faults (IO, metadata parse) → `map_core_error`. **No new `map_core_error` arm is required** — the reimport-reachable error variants (`Io`, `MetadataParse`, `InvalidVersionLabel`, `InvalidPrimitiveName`) are already mapped (main.rs:1182-1192). One to verify: `MaterializeShape` (reimport.rs:127, "primary file not found at install dest") — confirm its current mapping (likely the `_ => bridge_command_failed` catch-all; acceptable as a 502, but flag if it should be promoted).

### Bridge (extend — one dispatch arm + one command fn)

- `crates/prompt-library-bridge/src/main.rs` dispatch table at `:108-164`. Reimport adds **one arm**: `"reimport_install" => cmd_reimport(args)`. It is **sync** (std::fs only, like install/snapshot) — but it COMMITS afterward (the new `versions/<label>/` tree + `current.txt` are git-tracked, exactly like publish), so the arm is `cmd_reimport(args).await` and the fn is `async`, mirroring `cmd_publish` (main.rs:662).
- The `created_at` seam: the bridge owns no clock (main.rs:1081-1095, `parse_created_at` — already shape-validates `looks_like_rfc3339`). Reimport reuses `parse_created_at` verbatim; the TS route stamps `new Date().toISOString()` like publish/install.
- The commit seam: `commit_change(repo, message)` (main.rs:1119) is the shared non-fatal `(committed, commit_error)` helper. Reimport reuses it; the `.gitignore` excludes `*/working/`, so `git add -A` commits only the new version tree, never working-copy autosave (the publish argument, main.rs:1106).
- Existing parse helpers reused with **zero new helpers**: `require_library`, `parse_kind`, `parse_name`, `parse_target` (single target → `source_target`), `parse_version_label` (→ `new_version`), `parse_created_at`, `parse_optional_notes`, `install_context` (→ `install_paths` + `installs_file_path`). Two **new** trivial arg reads: `discard_working` (bool, default false — mirror `parse_force`) and `fixed_primary_text` (optional string → `.map(String::into_bytes)`, mirror `parse_optional_notes`).

### TS routes/models (extend)

- `scripts/library_models.ts` — add a `ReimportResult` tagged-union type + `parseReimportResult`, modelled on `parseDriftStatus` (`:556`, tag-on-`kind` switch) and `parsePublishResult` (`:419`). `raw_bytes: Vec<u8>` serializes as a JSON array of bytes; the parser keeps it as `number[]` (the fix sheet needs the bytes to seed an editable buffer — decode to text client-side, see Open Q2).
- `scripts/library_routes.ts` — add `buildReimport` (mirror `buildPublish` at `:558`): resolve config, refuse early when unconfigured, server-stamp `now`, `withWriteLock(...)` is **not** needed *for the ledger* (versioning skips it, Decision 4) — **but reimport DOES write `installs.json`** (reimport.rs:205-221 re-baselines the record). That re-introduces the load→mutate→save ledger cycle that the install slice's `withWriteLock` (D1) exists to serialize. **Therefore reimport's route handler MUST take `withWriteLock`** — unlike publish/overlay/metadata. This is the one place reimport's atomicity story diverges from Slice 4; see Risks.
  - Timeout: `WRITE_TIMEOUT_MS` + SIGKILL (`:48`, `:578`).
  - Validate: `parseReimportResult`. Returns at HTTP 200 even for `WorkingCopyDirty`/`BrokenSource`/`NotInstalled`/`InstallMissing` (they are *results*, not errors — same as `colliding_content` rides a 200 `InstallSummary`).
  - Route: `app.post("/api/library/primitives/:kind/:name/reimport", ...)` registered in `registerLibraryRoutes` (`:805`), grouped with the drift writes near `:874`. The `:target`, `:version_label`, `notes`, `discard_working`, `fixed_primary_text` ride the JSON body (the merged-bytes `fixed_primary_text` can be large + carry newlines → body, never query/segment).
- Error-code mapping (`statusForCode`, `:78`): no new code needed if no new `map_core_error` arm is added. Confirm.

### UI (extend — the deliverable)

- `ui/src/lib/api.ts` — add `LibraryReimportResult` (mirror `LibraryDriftStatus` at `:536`) + a `reimportInstall(kind, name, body)` fetcher (mirror `publishVersion` at `:675`), `sendJson<LibraryReimportResult>(`${primPath}/reimport`, "POST", {...})`.
- `ui/src/lib/library.ts` — add a `reimportResultCue` (CVD-safe, mirror `outcomeCue` at `:202`) for the post-action feedback, and possibly extend nothing else (`stateCue` for the row badge already covers `modified`).
- `ui/src/routes/Library.svelte` — the row markup at **`:886`** is where the three actions render. Today the `modified` branch shows `Update` + `Acknowledge` + `Uninstall`. This slice:
  1. **Relabels `Update` → `Reinstall`** with a tooltip/sub-label clarifying direction ("overwrite the installed copy with the Library version"). `Update`/`Install` for non-drifted rows can keep their current labels (they're not ambiguous outside a drift).
  2. **Adds a `Reimport` button** on the `modified` branch only (roadmap risk b: reimport of a `Missing` drift is nonsensical — `installStateFor` returns `"missing"` for `missing` drift, so gate on `row.state === "modified"`).
  3. Adds the **dirty/broken-source flows** (the two non-`Reimported` interactive results) via the captured-intent dialog pattern already established (`dialog`/`revertDialog` at `:962`/`:993`).

## Proposed plan (3 phases, test-first within each)

### Phase 1: Bridge command + Rust tests

- **Objective:** Expose `reimport_install_as_version` over the bridge as `reimport_install`, returning the `ReimportResult` tagged union on the `ok` envelope and committing the new version non-fatally.
- **Changes:**
  - Add `cmd_reimport(args: &Value) -> Result<Value, LibraryError>` (async): resolve `root` (`require_library`), `(install_paths, installs_file_path)` (`install_context`), `kind`/`name`/`source_target`/`new_version`/`created_at`/`notes`, `discard_working` (new bool read), `fixed_primary_text` (new optional-string read). Call `reimport_install_as_version(ReimportRequest{...})`. On `Ok(result)`, serialize the tagged union; **then** — only when the result is `Reimported` — run `commit_change(&root, &message)` and fold `{committed, commit_error}` into the response object. Format the commit message `reimport(<dir>/<name>): <label>` (mirror `format_publish_commit_message`).
  - Add the dispatch arm `"reimport_install" => cmd_reimport(args).await` (main.rs:158-area, in the metadata/commit-bearing group).
  - **Decision to settle here (commit only on `Reimported`):** the non-success results (`WorkingCopyDirty` etc.) wrote nothing to git-tracked paths, so committing on them would be a no-op at best and confusing at worst. Commit ONLY on the `Reimported` arm. State this explicitly (the way Slice 4 stated publish-not-atomic-across-snapshot+commit).
  - Verify `MaterializeShape` mapping in `map_core_error`; promote to a typed code only if a reviewer wants the "primary file vanished mid-reimport" case actionable (default: leave in the 502 catch-all — it's a genuine fault, not a user state).
- **Affected:** `crates/prompt-library-bridge/src/main.rs` (dispatch + `cmd_reimport` + commit-message fn + tests module at `:1328`).
- **Dependencies:** none beyond the already-imported core.
- **Risks:** (a) the `created_at`/commit seam must match publish exactly so the bridge stays clock-/date-crate-free. (b) `fixed_primary_text` is UTF-8 text on the wire but core wants `Vec<u8>` — `.into_bytes()` is the bridge's job (core's `fixed_primary_bytes` skips parse validation, so a non-UTF-8 payload can't arrive via JSON anyway).
- **Validation (`cargo test --workspace`):** bridge-level `handle()` tests against a temp scaffolded+published+installed+drifted library asserting each of the 5 result variants surfaces on the `ok` envelope with the right `kind` tag; a `Reimported` response carries `{committed, commit_error}`; a `WorkingCopyDirty` response does NOT commit (assert no new commit). Reuse the install-slice fixture builder (`init_library` + `scaffold_skill` + `WorkingCopy` + `VersionStore::snapshot` + `install` — the exact recipe in reimport.rs's own `published_and_installed_skill` test helper, ported to the bridge test module).

### Phase 2: TS route + model + parser

- **Objective:** `POST /api/library/primitives/:kind/:name/reimport` returns the `ReimportResult` at 200 (all result variants), 422/409/404/502 only for genuine `map_core_error` faults.
- **Changes:**
  - `scripts/library_models.ts`: `ReimportResult` union (`reimported`/`working_copy_dirty`/`broken_source`/`not_installed`/`install_missing`) + the `committed`/`commit_error` fields folded onto the `reimported` variant (or a sibling — match whatever Phase 1's envelope shapes); `parseReimportResult` (tag-on-`kind`, mirror `parseDriftStatus`). `broken_source.raw_bytes` → `number[]`.
  - `scripts/library_routes.ts`: `buildReimport(config, kind, name, body, run, now)` — **`withWriteLock`** (the ledger-mutating exception vs. publish), `WRITE_TIMEOUT_MS`, `parseReimportResult`, server-stamped `now`. Register `app.post(".../reimport")`.
  - `statusForCode`: confirm no new code; if `MaterializeShape` is promoted in Phase 1, add its case.
- **Affected:** `scripts/library_models.ts`, `scripts/library_routes.ts`.
- **Dependencies:** Phase 1's envelope shape.
- **Risks:** the `withWriteLock` divergence from the sibling publish handler is easy to copy-paste-wrong (publish skips it). A test must assert reimport serializes against a concurrent install/acknowledge.
- **Validation (`bun test scripts`):** parser round-trips each variant from captured bridge fixtures (add `scripts/fixtures/bridge/reimport_*.json` via the existing capture path); route maps each variant to 200; a stubbed `library_invalid_version` → 422 and `primitive_not_found`/`drift_no_install_record` → their codes; a **D1 tripwire**: two concurrent reimport+acknowledge calls serialize (the `withWriteLock` is present, unlike publish). Route-local-failure assertion: a failed reimport leaves `/api/summary`, `/healthz` at 200.

### Phase 3: UI — three distinguishable actions + dirty/broken-source flows (the deliverable)

- **Objective:** A `Modified` drift row offers Acknowledge / Reinstall / Reimport, each with an unambiguous label + CVD-safe cue + direction-explicit confirm copy; the `WorkingCopyDirty` and `BrokenSource` results are handled, not dropped.
- **Changes:**
  - `ui/src/lib/api.ts`: `LibraryReimportResult` + `reimportInstall(kind, name, { source_target, new_version, notes?, discard_working?, fixed_primary_text? })`.
  - `ui/src/lib/library.ts`: `reimportResultCue` (CVD-safe — labels + glyphs, Okabe-Ito tones, never bare red/green).
  - `ui/src/routes/Library.svelte`, row markup `:886`:
    - **Relabel `Update` → `Reinstall`** on the `modified` branch; keep a one-line sub-cue clarifying it overwrites *the installed copy* (it already has the `overlay-stale-note` precedent for inline row explanation).
    - **Add `Reimport`** button, `modified`-only. Clicking opens a **reimport form** (version label `^v\d` hint reusing the publish-form validation at `:340`, optional notes) — reimport *is* a publish of foreign bytes, so the label/notes UX mirrors `doPublish`. A captured-intent snapshot `{kind, name, target, label, notes}` (mirror `ConflictIntent` at `:177`) so a selection change across the await can't redirect it.
    - **`doReimport(intent, discard=false, fixedBytes?=null)`** — keyed pending-write lock (`writeKey`, `:163`); on success-`reimported` set a cue notice + `reloadInstallState()` (drift clears, the version list grew → also `detailRes.reload()`).
    - **`working_copy_dirty` result** → open a confirm dialog (mirror `revertDialog` at `:993`): "Your working copy has unpublished edits. Reimport will discard them and capture the installed copy's bytes as `<label>`. There is no backup." Confirm → `doReimport(intent, discard=true)`.
    - **`broken_source` result** → open a fix sheet: a textarea seeded from `raw_bytes` (decoded to text) + the `parse_error` shown, "Fix the frontmatter and retry." Save → `doReimport(intent, discard, fixedBytes=textarea)`. This is the one genuinely new surface (the dirty case reuses the dialog shape; the broken case needs an editable buffer + error display).
  - **The three-label rule (roadmap risk a):** Acknowledge / Reinstall / Reimport must be distinguishable **by label, not color** (Scott is red/green CVD — global memory). Reinstall and Reimport-with-discard are the two destructive ones in opposite directions; each gets a distinct glyph + an explicit direction word in its confirm copy ("overwrite the installed copy" vs. "discard working-copy edits"). A `*.svelte.test.ts` asserts the three labels are present and distinct with color stripped.
- **Affected:** `ui/src/lib/api.ts`, `ui/src/lib/library.ts` (+ `library.test.ts`), `ui/src/routes/Library.svelte` (+ a `Library.svelte.test.ts` case).
- **Dependencies:** Phases 1-2.
- **Risks:** (a) **the no-useEffect rule** — every reload-after-write is event-handler-driven `.reload()` (the file already follows this; the reimport form's reset on selection-change folds into `selectPrimitive` at `:286`, no effect). (b) the broken-source textarea is a *local buffer* (do not bind to `resource()` data — the editor-buffer-survives-poll lesson from Slice 3). (c) Reimport offered only on `modified` (gate on `row.state`), never `missing`/`clean`/`not_installed`.
- **Validation (`*.svelte.test.ts` + `library.test.ts`):** Reimport button renders only on a `modified` row; the three drift actions are distinguishable by label with color removed; a `working_copy_dirty` result opens the discard confirm and confirming re-issues with `discard_working:true`; a `broken_source` result shows the parse error + the raw bytes in an editable buffer and retry sends `fixed_primary_text`; `reimportResultCue` distinguishability test (no color).

## Acceptance criteria

- A drifted (`Modified`) install row → reimport → the on-disk bytes land as a new Library version, `current.txt` advances, and the next drift scan reads `Clean` (the install record re-baselined). Verified end-to-end in a `cargo` bridge test and asserted in the UI via the post-action cue + reloaded drift state.
- The reimport command commits the new version (non-fatal `{committed, commit_error}`, publish posture) **only** on the `Reimported` outcome; a non-success result commits nothing.
- All five `ReimportResult` variants ride HTTP 200 as data (not error codes); only genuine core faults map to 422/409/404/502.
- The reimport route takes `withWriteLock` (it mutates `installs.json`), unlike its publish sibling — asserted by a concurrency tripwire test.
- A `Modified` row presents **three distinguishable actions**: Acknowledge (adopt disk), Reinstall (overwrite disk), Reimport (pull disk into Library). They are distinguishable by **label, not color** (CVD), and the two destructive actions name their direction explicitly in confirm copy. Reimport is offered on `Modified` only, never `Missing`.
- `WorkingCopyDirty` → a confirm-then-`discard_working:true` flow; `BrokenSource` → a fix-buffer-then-`fixed_primary_text` retry. Neither is silently dropped.
- Route-local failure preserved: a failed reimport leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.
- Secrets-free invariant intact: no `prompt-library-secrets` link, no network call (the `Cargo.toml:12-14` comment is untouched).

## Dependencies and risks

- **Depends on:** Slice 4 (versioning — `VersionStore::snapshot`, `PublishResult`, commit-on-write posture) and the shipped install/drift slice (the `Modified` row, `scan_drift`, the two-phase confirm dialog). Both are merged.
- **Atomicity (the one divergence from Slice 4):** reimport is a multi-step write — snapshot the working copy, advance `current.txt`, then re-baseline `installs.json` — that ends by mutating the **ledger** (reimport.rs:205-221). Versioning skipped `withWriteLock` because it never touched `installs.json`; reimport DOES, so it **must** take the lock. Core writes each file atomically (temp+rename under fd-lock), so a killed bridge leaves the snapshot + ledger individually intact; the slice owes an explicit "not atomic across snapshot→current→ledger, but each step is recoverable" statement + a kill-mid-reimport test (the Slice 4 D3 pattern, extended to cover the ledger step).
- **Three-action ambiguity (the headline risk):** two opposite-direction destructive actions plus one safe action on one row. Mitigation is the deliverable: distinct labels, distinct glyphs, direction-explicit confirm copy, CVD-safe cues, and a test that strips color and asserts the labels still disambiguate.
- **Broken-source buffer:** the only net-new UI surface; reuse the local-buffer-not-resource-bound lesson from the Slice 3 editor.

## Open questions (resolve in-flight, non-blocking)

1. **`MaterializeShape` / `InstallMissing`-vs-fault boundary.** `InstallMissing` is a clean `Ok` result, but `MaterializeShape` (reimport.rs:127) is an `Err` that lands in the 502 catch-all. Keep it a 502 (a genuine "file vanished mid-call" fault) unless a reviewer wants it actionable. *Assumption: leave in the catch-all.*
2. **`broken_source.raw_bytes` decode.** Bytes on the wire (`number[]`); the fix sheet needs editable text. Decode as UTF-8 client-side for the textarea; if the bytes are non-UTF-8 the textarea shows replacement chars but the retry still sends `fixed_primary_text` (which core re-validates). *Assumption: lossy-decode for display, re-encode on save.*
3. **Reimport form vs. inline label.** Does Reimport open a labelled form (version label + notes, like publish) or reuse a quick default label? The reference takes a `new_version: VersionLabel` — so a label is required. *Assumption: a small form mirroring the publish form, reusing its `^v\d` client-side hint.*
4. **"Update" → "Reinstall" relabel scope.** Relabel only on the `modified` branch (where the direction is ambiguous against Reimport), or everywhere? *Assumption: relabel on the `modified` branch only; non-drifted `Install`/`Update` stay as-is.*

## References

- Roadmap: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` (Slice 7, lines 153-161)
- Slice 4 plan (the publish/commit posture this extends): `docs/plans/2026-06-12-feat-prompt-library-versioning-publishing-slice-plan.md`
- Core (read-only dependency, fully tested): `crates/core/src/reimport.rs` (fn `:89`, `ReimportRequest` `:42`, `ReimportResult` `:66`, 13 tests `:504-1033`); exported `crates/core/src/lib.rs:98`
- Reference command to port: `prompt-library/src-tauri/src/commands.rs:1303` (`reimport_install`)
- Bridge seams to extend: `crates/prompt-library-bridge/src/main.rs` (dispatch `:108`, `cmd_publish` analog `:662`, `commit_change` `:1119`, `parse_created_at` `:1085`, `map_core_error` `:1179`, tests `:1328`)
- TS seams to extend: `scripts/library_models.ts` (`parseDriftStatus` `:556`, `parsePublishResult` `:419`), `scripts/library_routes.ts` (`buildPublish` `:558`, `withWriteLock` `:61`, `statusForCode` `:78`, route registration `:805`/`:874`)
- UI seams to extend: `ui/src/lib/api.ts` (`publishVersion` `:675`, `LibraryDriftStatus` `:536`), `ui/src/lib/library.ts` (`stateCue` `:187`, `outcomeCue` `:202`), `ui/src/routes/Library.svelte` (drift-row markup `:886`, `doInstall`/`doAcknowledge` `:389`/`:503`, conflict dialog `:962`, revert dialog `:993`, `ConflictIntent` `:177`)

## Next step

Execute Phase 1 (`/workflows:work` this plan), or `/workflows:deepen-plan` if the three-action UI copy or the atomicity story wants more adversarial review before implementation. Per the roadmap, Slice 7 is the natural next authoring slice; Slice 9 (search) remains the low-risk palate-cleanser to interleave.
