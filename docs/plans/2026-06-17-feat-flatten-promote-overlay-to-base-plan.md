# Flatten (promote Overlay to Base) — implementation plan

- **Date:** 2026-06-17
- **Type:** feat
- **ADR:** docs/adr/0009-flatten-promote-overlay-to-base.md (status: proposed)
- **Terminology:** CONTEXT.md (Primitive, Base, Overlay, Base-follower target, Flatten, Version, Drift, Install record, KindTarget)

## Overview

ADR-0009 settles **WHAT** Flatten does. This plan is the **HOW**: a single
transactional core operation `flatten_promote_to_base`, its bridge command, its
TS route + model, the api.ts client, and the primitive-detail UI affordance —
mirroring the existing reimport-from-drift slice end to end, since Flatten is
its structural sibling (read installs → mutate library → snapshot → reinstall →
re-baseline `installs.json`, with a clean-working gate and a force/collision
guard).

The operation, on one Primitive given a chosen Target `X` that **has an
Overlay**:

1. Gate on a clean Working copy (reuse reimport's dirty rule).
2. Pre-scan the **converging base-follower targets** (allowed targets with no
   overlay, other than `X`) for skills-list Drift; if any are dirty, abort with
   a conflict list unless `force`.
3. Mutate the library: `base := merge(base, X-overlay)`; drop `X`'s overlay;
   recompute every *other* overlay-bearing target's overlay as a delta against
   the new base so its Materialized bytes are unchanged; base-followers now
   follow the new base.
4. Snapshot a new Version (caller-supplied label; never a reset) and commit.
5. Reinstall the converging base-follower targets to disk (force per step 2).
6. Re-baseline `installs.json` for the affected targets so both Drift surfaces
   read Clean.

## Key facts grounding this plan (from the codebase)

- **Overlay model** (`crates/core/src/overlay_merge.rs`): `merge(overlay, target)`
  = `base` with `targets[target]` files shadowing/extending at the same relpath.
  Additive whole-file shadows only; no deletes (matches ADR "out of scope").
- **`OverlayBytes`** (`working_copy.rs`): `{ base: HashMap<Utf8PathBuf,Vec<u8>>,
  targets: HashMap<Target, HashMap<Utf8PathBuf,Vec<u8>>> }`. The exact in-memory
  shape Flatten will rewrite.
- **WorkingCopy** (`working_copy.rs`) exposes `save_base_file`,
  `remove_base_file`, `save_target_file`, `remove_target_file`, `load`. These
  are the only writes Flatten needs (same set reimport's step 7 uses).
- **VersionStore** (`version_store.rs`): `snapshot` errors `VersionExists` if the
  label dir exists (immutability — never reset); `read_current`, `read_version`.
- **Reimport** (`reimport.rs`) is the template: `working_diverges_from_current`
  (the dirty gate), the `single_target_primitive` live-install reasoning, the
  re-baseline block (`collect_disk_state` → `installs.upsert(InstallRecord{..})`),
  and `ReimportResult` as a tagged union riding the OK envelope.
- **Installer** (`installer.rs`): `install(InstallRequest{ .. force, .. })`
  returns `InstallSummary { successes, failures }`; `TargetOutcome::CollidingContent`
  is the force-prompt result. Reinstall in step 5 is exactly `install(..)` with
  `force: true` over the converging targets — after step 4's snapshot bumped
  `current.txt`, install reads the new base.
- **Drift** (`drift.rs`): `scan_drift_for_primitive(install_paths,
  installs_file_path, kind, name) -> Vec<DriftReport>`; `DriftStatus::{Clean,
  Modified{conflicts}, Missing{missing}}`. The step-2 pre-scan filters this to
  the converging targets and treats non-`Clean` as a conflict.
- **Metadata** (`metadata.rs`): `PrimitiveMetadata.allowed_targets: Vec<Target>`;
  `Error::TargetRemovedWithOverlays { dropped: Vec<OverlayList> }` is the
  precedent for an error that carries overlay/conflict payload to the UI.
- **Detail** (`detail.rs`): `list_overlays(layout, kind, name) -> Vec<OverlayList>`
  and `TargetView.has_overlay` already tell the UI which targets have an overlay
  (drives which targets are flatten-eligible and which converge). No new read
  needed for the UI's pick list.
- **Bridge** (`crates/prompt-library-bridge/src/main.rs`): `cmd_reimport` (≈ln
  1012) is the exact pattern — `require_library`, `install_context`, parse args,
  call core, serialize the tagged result, commit ONLY on the success arm. New
  command registered in the dispatch `match` (≈ln 221).
- **TS route** (`scripts/library_routes.ts`): `buildReimport` (≈ln 462) is the
  pattern — `withWriteLock`, `WRITE_TIMEOUT_MS`, server-stamped `created_at`,
  all variants ride 200. Registered at `app.post(".../reimport", ..)` (≈ln 1540).
- **TS model** (`scripts/library_models.ts`): `ReimportResult` tagged union +
  `parseReimportResult` (≈ln 290) is the parser pattern.
- **api.ts** (`ui/src/lib/api.ts`): `LibraryReimportResult` + `reimportInstall`
  (≈ln 649/717), `primPath` (≈ln 687). Flatten adds a sibling type + fn.
- **library.ts** (`ui/src/lib/library.ts`): `reimportResultCue` (≈ln 236) is the
  colorblind-safe cue pattern (no red/green — see MEMORY.md).
- **Library.svelte** (`ui/src/routes/Library.svelte`, ~2850 lines): reimport
  form/dirty/broken state + `selectPrimitive` reset (≈ln 354) and
  `reloadInstallState` (≈ln 256) are the UI patterns to mirror.

## Key decisions

### D1. Where the orchestration lives — new `crates/core/src/flatten.rs`
- **Choice:** A new core module `flatten.rs` exporting `flatten_promote_to_base`
  + a `FlattenResult` tagged enum, alongside reimport (not folded into it).
- **Alternatives:** extend `reimport.rs`; orchestrate in the bridge.
- **Why:** reimport pulls *one target's disk* into the library; Flatten promotes
  *one overlay* and fans out to *many targets' disk*. Different inputs, different
  fan-out. Core is where every other transactional library op lives (the bridge
  is a thin shell — `cmd_reimport` does no logic). Keeps the bridge testable and
  the operation unit-testable with `TempDir` fixtures (reimport's `Fixture`).
- **Reversible:** yes (module boundary, no schema change).

### D2. Overlay-delta recompute for preserved targets — store full effective bytes
- **Choice:** For each *other* overlay-bearing target `T`, compute
  `eff_T = merge(old_overlay, T)` (its current Materialized bytes), then after
  setting `new_base = merge(old_overlay, X)`, rewrite `T`'s overlay to exactly
  the files where `eff_T` differs from `new_base` (or `eff_T` has a file
  `new_base` lacks). Files where `eff_T == new_base` are dropped from `T`'s
  overlay (now redundant). This keeps `merge(new_overlay, T) == eff_T`
  byte-for-byte — the ADR invariant "its Materialized bytes are unchanged".
- **Alternatives:** keep `T`'s overlay verbatim (wrong: a verbatim file that
  happened to equal old base now diverges from new base, silently changing
  shadow semantics and bloating the overlay); recompute as a line-level delta
  (out of scope per ADR — overlays are whole-file).
- **Why:** whole-file shadow semantics + "unchanged Materialized bytes" force
  exactly this set difference. Dropping now-redundant files is the minimal
  correct overlay.
- **Reversible:** yes (the prior Version is the undo, per ADR).
- **Assumption:** "unchanged Materialized bytes for preserved targets" is the
  binding invariant; convergence applies ONLY to base-followers. (Directly from
  ADR Decision step 3 + the "Considered and rejected: mode toggle" entry.)

### D3. Step ordering — gate, pre-scan, mutate-library+snapshot+commit, reinstall, re-baseline
- **Choice:** Do all library mutation + snapshot + commit BEFORE touching any
  install dir, exactly as reimport snapshots before re-baselining. Reinstall
  reads the freshly-bumped `current.txt`.
- **Why:** a snapshot is cheap and reversible (immutable Version, the undo); a
  disk write to `~/.claude/...` is the risky, user-visible side effect and must
  come last, gated by step 2's force confirm. If reinstall partially fails, the
  library is already in the new coherent state and the per-target failures ride
  back in the result for retry (installer's per-target independence).
- **Reversible:** library half yes (prior Version); disk half is the point.

### D4. Force semantics — single `force` flag covering the converging-target pre-scan
- **Choice:** One `force: bool` on the request. `false` + any dirty converging
  base-follower → return `FlattenResult::ConvergingConflicts { conflicts }` and
  write NOTHING. `true` → proceed and clobber via `install(force:true)`.
- **Alternatives:** always force (rejected by ADR); skip dirty targets (rejected
  by ADR — leaves drift).
- **Why:** mirrors install's `CollidingContent` + `force` and reimport's
  `discard_working` two-phase confirm; the ADR explicitly chose detect→confirm→
  clobber. The clean-working-copy gate is SEPARATE (it has its own result
  variant) because it guards the library, not the install dirs.
- **Reversible:** yes.

### D5. Version label is caller-supplied (UI suggests next), not auto-incremented
- **Choice:** The request carries `new_version: VersionLabel`, like reimport and
  publish. The UI suggests the next label client-side (the existing publish form
  pattern: `/^v\d/` validation, user edits).
- **Why:** core has no next-label helper (`version_label.rs` has only
  `try_new`/`as_str`); reimport/publish already push label choice to the caller;
  ADR says "snapshot a NEW version", not a specific scheme. Consistency over a
  new invention.
- **Reversible:** yes.

## Implementation units

Each unit is test-first. Checkpoints between groups. IDs are stable.

### Phase A — core operation (the risk; fail fast here)

#### U1. `flatten.rs` types + the library-mutation core (no disk writes yet)
- **Objective:** Establish `FlattenRequest`, `FlattenResult`, and the pure-ish
  library rewrite (D2) as the first vertical slice, validated by unit tests,
  before any install/disk fan-out.
- **Changes:**
  - New `crates/core/src/flatten.rs`. Add `pub mod flatten;` to `lib.rs` (≈ln 31,
    next to `reimport`).
  - `pub struct FlattenRequest<'a>` mirroring `ReimportRequest`: `layout`,
    `install_paths`, `installs_file_path`, `kind`, `name`, `source_target: Target`
    (the `X` whose overlay is promoted), `new_version: VersionLabel`,
    `created_at: &str`, `notes: Option<String>`, `force: bool`.
  - `#[derive(Serialize, Deserialize, Type)] #[serde(tag="kind", rename_all="snake_case")]
    pub enum FlattenResult`:
    - `Flattened { new_version: VersionLabel, converged_targets: Vec<Target>,
      preserved_targets: Vec<Target> }`
    - `WorkingCopyDirty` (reuse reimport's gate)
    - `ConvergingConflicts { conflicts: Vec<TargetConflict> }` where
      `TargetConflict { target: Target, paths: Vec<String> }` (paths from
      `DriftStatus::Modified.conflicts` / `Missing.missing`)
    - `NotAnOverlayTarget` (the chosen target is a base-follower → no-op refusal)
    - `NoCurrentVersion` (nothing pinned to read base from)
  - A private `rewrite_working_for_flatten(wc, kind, name, source_target,
    metadata.allowed_targets) -> Result<(converged, preserved), Error>` implementing
    D2: load current working `OverlayBytes`; `new_base = merge(old, source_target)`;
    for each other target `T` with an overlay, compute `eff_T = merge(old, T)`,
    rewrite `T`'s overlay to the set-difference vs `new_base` (save changed,
    remove redundant); drop `source_target`'s overlay entirely; replace base files
    (`save_base_file` for each new-base file, `remove_base_file` for any old-base
    file absent from new base). Returns the converged base-follower targets
    (allowed, no overlay, ≠ source) and the preserved overlay targets.
- **Affected:** `crates/core/src/flatten.rs` (new), `crates/core/src/lib.rs`.
- **Dependencies:** none beyond existing core.
- **Tests (write first, in `flatten.rs`):**
  - `rewrite_promotes_chosen_overlay_into_base`: base `b`, Claude overlay `c`;
    after rewrite, base == `c`, Claude overlay gone.
  - `rewrite_preserves_other_target_materialized_bytes`: base `b`, Claude `c`,
    Pi `p`; promote Claude; assert `merge(new, Pi)` byte-equal to old
    `merge(old, Pi)`; assert Pi overlay drops any file now equal to new base.
  - `rewrite_converges_base_follower_in_memory`: base `b`, Claude `c`, Codex no
    overlay; promote Claude; `merge(new, Codex) == new_base == c`.
  - `rewrite_drops_redundant_preserved_overlay_files`: a preserved target whose
    overlay file equals the promoted content → that file removed from its overlay.
- **Risk:** the set-difference is the subtle part (D2). Tests pin
  byte-equality of preserved Materialized output — the ADR's hard invariant.
- **Validation:** `cargo test -p <core-crate> flatten::` green.

#### U2. `flatten_promote_to_base` orchestration — gate, pre-scan, snapshot, reinstall, re-baseline
- **Objective:** Wire U1's rewrite into the full transactional op with the disk
  fan-out and both guards.
- **Changes (in `flatten.rs`):** `pub fn flatten_promote_to_base(req) ->
  Result<FlattenResult, Error>`:
  1. Load metadata (`PrimitiveMetadata::from_yaml`); read `current` via
     `VersionStore::read_current` → `NoCurrentVersion` if absent.
  2. Load working `OverlayBytes`; if `source_target` has NO overlay →
     `NotAnOverlayTarget`.
  3. Clean-working gate: reuse reimport's `working_diverges_from_current` logic
     (extract it to a shared `pub(crate)` fn or copy the 8-line check) →
     `WorkingCopyDirty`.
  4. Compute converging targets = allowed ∩ (no overlay) ∖ {source}. Pre-scan
     them with `scan_drift_for_primitive` filtered to those targets; collect
     non-`Clean` into `conflicts`. If non-empty AND `!force` →
     `ConvergingConflicts { conflicts }` (write nothing).
  5. `rewrite_working_for_flatten` (U1).
  6. `VersionStore::snapshot(new_version, VersionMetadata{created_at, notes})`.
     (Errors `VersionExists` propagate as a normal `Error` → 409, like publish.)
  7. Reinstall converging targets: `install(InstallRequest{ targets:
     &converged, force: true, .. })`. Fold any `summary.failures` —
     return them inside `Flattened` is wrong; instead, surface as a top-level
     `Error::FlattenReinstallFailed { failures }` ONLY if non-empty? No — keep
     parity with installer's per-target independence: include
     `reinstall: InstallSummary` in `Flattened` so the UI can show partial
     failures and offer retry. (Deferred impl note: confirm the UI wants the
     full summary vs a count; see U7.)
  8. The promoted + preserved targets are unchanged on disk; their
     `installs.json` records still pin the OLD label but their bytes equal the
     new Materialized output (preserved) or were never base-followers. Re-baseline
     **all affected records** (converged + the promoted target + preserved
     overlay targets) by bumping `installed_version` to `new_version` and
     recomputing hashes/mtimes from disk via reimport's `collect_disk_state`
     pattern, so a post-flatten drift scan reads Clean for every target. (See
     ADR step 6 "the affected targets".)
- **Affected:** `crates/core/src/flatten.rs`.
- **Dependencies:** U1.
- **Tests (write first):** use reimport's `Fixture` + `published_and_installed_skill`.
  - `flatten_single_overlay_converges_everyone_and_clears_drift`: Claude+Codex
    allowed, Claude has overlay (via `save_target_file` then re-snapshot), Codex
    is base-follower; flatten Claude; assert new base == Claude content, Codex
    install file rewritten to it, `scan_drift_for_primitive` all `Clean`,
    `installs.json` all on `v2`.
  - `flatten_preserves_other_overlay_target_on_disk`: Claude+Pi both overlays;
    flatten Claude; Pi install file byte-unchanged, Pi drift `Clean`.
  - `flatten_aborts_on_dirty_base_follower_without_force`: hand-edit the Codex
    install; flatten Claude `force:false` → `ConvergingConflicts` listing Codex;
    assert NO new version, NO disk change, `installs.json` unchanged.
  - `flatten_force_clobbers_dirty_base_follower`: same setup, `force:true` →
    `Flattened`, Codex file overwritten, drift `Clean`.
  - `flatten_refuses_dirty_working_copy`: edit `working/` → `WorkingCopyDirty`,
    nothing written.
  - `flatten_refuses_base_follower_source`: pick Codex (no overlay) →
    `NotAnOverlayTarget`.
  - `flatten_existing_label_errors`: reuse current label → `Error::VersionExists`.
- **Risk:** re-baselining the promoted/preserved targets (not just converged) is
  the correctness crux for "no drift in EITHER view"; the dirty-base-follower
  abort must be fully atomic (no partial writes).
- **Validation:** `cargo test -p <core-crate> flatten::` green; `cargo clippy`.

**Checkpoint 1:** core builds, `cargo test` + `cargo clippy` clean. Flatten is
correct and fully tested at the core level with no UI. This is the tracer
bullet's load-bearing slice.

### Phase B — bridge command

#### U3. `cmd_flatten` + dispatch arm
- **Objective:** Expose `flatten_promote_to_base` over the bridge, commit on the
  `flattened` arm only.
- **Changes (in `crates/prompt-library-bridge/src/main.rs`):**
  - Add to `use prompt_library_core::{..}` the `flatten_promote_to_base`,
    `FlattenRequest`, `FlattenResult` symbols (next to reimport, ≈ln 62/68).
  - `async fn cmd_flatten(args) -> Result<Value, LibraryError>` cloning
    `cmd_reimport` (≈ln 1012): `require_library`, `install_context`, `parse_kind`,
    `parse_name`, `parse_target` (the source), `parse_version_label`,
    `parse_created_at`, `parse_optional_notes`, `parse_force` (the existing
    `parse_force` helper, ≈ln 1810 region). Call core, `map_core_error`,
    serialize. Commit ONLY on `FlattenResult::Flattened` (the new version tree is
    git-tracked) via `commit_change(&root, &message)` with a
    `format_flatten_commit_message(kind, name, new_version)` helper modeled on
    `format_reimport_commit_message` (≈ln 1890): subject
    `flatten({dir}/{name}): {label}`.
  - Register `"flatten" => cmd_flatten(args).await,` in the dispatch `match`
    next to `"reimport_install"` (≈ln 221), with a doc comment explaining: it
    re-baselines `installs.json` (so the TS route takes the write lock, the
    reimport divergence) and commits on success only.
- **Affected:** `crates/prompt-library-bridge/src/main.rs`.
- **Dependencies:** U2.
- **Tests (write first, in bridge `#[cfg(test)]`):** mirror the reimport bridge
  tests (≈ln 4198) using the bridge's `InstallFx`:
  - `flatten_commits_on_success`: `flattened` arm returns `committed:true` when
    git configured.
  - `flatten_conflict_rides_ok_envelope`: dirty base-follower, `force:false` →
    `data.kind == "converging_conflicts"`, no commit.
  - `flatten_dirty_working_no_commit`: `working_copy_dirty` arm, `committed`
    absent.
- **Validation:** `cargo test -p prompt-library-bridge flatten` green.

**Checkpoint 2:** bridge builds + tested. The capability is reachable via the
bridge JSON protocol end to end (core + bridge), no HTTP/UI yet.

### Phase C — TS route + model + client (shared API contract)

These three define/consume one wire contract — sequence the model (U4) first,
then route (U5) and client (U6) can fan out.

#### U4. `FlattenResult` wire model + parser
- **Objective:** TS mirror of the core enum.
- **Changes (`scripts/library_models.ts`):** add `FlattenResult` tagged union
  (mirror the `ReimportResult` block ≈ln 290) with all five variants;
  `Flattened` carries `new_version`, `converged_targets`, `preserved_targets`,
  the non-fatal `{ committed, commit_error }`, and the `reinstall` summary
  shape; export `parseFlattenResult` (runtime-validate `kind`, mirroring
  `parseReimportResult`).
- **Affected:** `scripts/library_models.ts`, `scripts/library_models.test.ts`.
- **Tests (write first):** `parseFlattenResult` accepts each variant, rejects an
  unknown `kind` (mirror the reimport model tests).
- **Validation:** `npm test scripts/library_models` (or repo's TS test cmd).

#### U5. `buildFlatten` route + registration
- **Objective:** HTTP `POST .../flatten` mapping to the bridge command.
- **Changes (`scripts/library_routes.ts`):** add `buildFlatten` cloning
  `buildReimport` (≈ln 462): `withWriteLock`, `WRITE_TIMEOUT_MS`, server-stamped
  `created_at`, refuse early if `!config.libraryPath`; body
  `{ source_target, version_label, notes, force }`; all variants ride 200, only
  genuine faults map to 4xx/502 via the existing `errorResult`. Register
  `app.post("/api/library/primitives/:kind/:name/flatten", ..)` next to the
  reimport route (≈ln 1540).
- **Affected:** `scripts/library_routes.ts`, `scripts/library_routes.test.ts`.
- **Dependencies:** U3, U4.
- **Tests (write first):** mirror reimport route tests — `flattened` 200 +
  commit fields; `converging_conflicts` 200; unconfigured → error; assert the
  write lock + server-stamped `created_at` (the route owns the clock).
- **Validation:** TS route tests green.

#### U6. api.ts `flattenPrimitive` + `LibraryFlattenResult`
- **Objective:** browser client fn.
- **Changes (`ui/src/lib/api.ts`):** `LibraryFlattenResult` (mirror
  `LibraryReimportResult` ≈ln 649) + `flattenPrimitive(kind, name, opts)` calling
  `sendJson<LibraryFlattenResult>(`${primPath(kind,name)}/flatten`, "POST", opts)`
  (mirror `reimportInstall` ≈ln 717).
- **Affected:** `ui/src/lib/api.ts`.
- **Dependencies:** U4 (shape parity).
- **Tests:** covered by U7's component tests + the TS route tests; api.ts is a
  thin `sendJson` wrapper (no logic to unit-test alone — consistent with
  `reimportInstall`).
- **Validation:** type-check (`tsc`/`svelte-check`).

**Checkpoint 3:** full backend path testable from a browser fetch; TS suites
green; `svelte-check` clean.

### Phase D — UI

#### U7. Flatten affordance in Library.svelte + cue helper
- **Objective:** From the primitive-detail view, let the user pick an
  overlay-bearing Target and flatten, with a pre-flight "these base-follower
  targets will be rewritten" surface and the conflict/force two-phase confirm.
- **Changes:**
  - `ui/src/lib/library.ts`: add `flattenResultCue(result: LibraryFlattenResult):
    Cue` mirroring `reimportResultCue` (≈ln 236). Colorblind-safe per MEMORY.md —
    use tone `default`/`amber`/`cyan` + glyphs, never red/green.
  - `ui/src/routes/Library.svelte`:
    - Flatten is offered ONLY for targets where `has_overlay` is true (drive off
      the existing overlay/target view data; base-followers are not offered —
      ADR). Reuse `list_overlays`/`TargetView.has_overlay` already in the detail.
    - A `flattenForm` / `flattenConflicts` / `flattenNotice` state trio mirroring
      the reimport `reimportForm`/`reimportDirty`/`reimportBroken`/`reimportNotice`
      set; suggest the next version label (publish form's `/^v\d/` pattern).
    - Before confirm, surface which targets converge (will be rewritten on disk)
      vs which are preserved — ADR consequence "must surface which targets will
      change before the user confirms."
    - `doFlatten()`: call `flattenPrimitive`; route on result kind:
      `working_copy_dirty` → notice ("save/publish your working edits first");
      `converging_conflicts` → show the conflict list + a "Flatten anyway
      (overwrite)" force button that re-calls with `force:true`;
      `not_an_overlay_target` → guard (should be unreachable given the gating);
      `flattened` → success cue, then `detailRes.reload()`, `reloadInstallState()`,
      `driftBatchRes.reload()`, `primitivesRes.reload()`.
    - Extend `selectPrimitive` (≈ln 345) to reset the new flatten state (the
      "never leak across selection" invariant the file already enforces for
      reimport).
- **Affected:** `ui/src/lib/library.ts`, `ui/src/routes/Library.svelte`,
  `ui/src/routes/Library.svelte.test.ts`, `ui/src/lib/library.test.ts`.
- **Dependencies:** U6.
- **Constraint:** No `useEffect`-equivalent — Svelte 5 runes; derive the
  eligible-targets list during render, reset state via `selectPrimitive`, not via
  an effect (CLAUDE.md React/effect rule applies to the project's reactive code).
- **Tests (write first):**
  - `library.test.ts`: `flattenResultCue` returns committed/not-committed/
    conflict cues with correct tones + glyphs (no red/green).
  - `Library.svelte.test.ts`: flatten button only shown for overlay targets; a
    `converging_conflicts` response renders the conflict list + force button; the
    force re-call sends `force:true`; a `flattened` response reloads install +
    drift state. (Mirror the reimport component tests.)
- **Validation:** `svelte-check` clean; component + lib tests green.

**Checkpoint 4:** end-to-end. Manual browser QA (the only remaining gap per
prior slices): pick `improve`-style primitive with a Claude overlay over a
frozen base + a base-follower, flatten, confirm zero drift in BOTH the
skills-list view and the bootstrap-scan view (ADR's two drift surfaces).

## Acceptance criteria

- Flattening a Primitive on target `X` (which has an overlay) sets
  `base := merge(base, X-overlay)`, drops `X`'s overlay, and snapshots a NEW
  Version; the prior Version still exists (`list_versions` shows both; the prior
  is the undo). No label is ever reset or deleted.
- Every preserved overlay target `T`'s Materialized bytes are byte-identical
  before and after (`merge(old,T) == merge(new,T)`), and `T`'s install file on
  disk is untouched.
- Every converging base-follower target's install file on disk equals the new
  base after flatten; a hand-edited converging target without `force` aborts the
  whole operation (`ConvergingConflicts`, nothing written) and with `force`
  overwrites it.
- A dirty Working copy aborts with `WorkingCopyDirty` and writes nothing.
- After a successful flatten, `scan_drift_for_primitive` reports `Clean` for ALL
  targets, and `installs.json` records all pin the new Version (both drift
  surfaces read clean).
- The success arm commits to the library git; non-success arms do not commit.
- The UI offers Flatten only for overlay-bearing targets, surfaces which targets
  will be rewritten before confirm, and uses colorblind-safe cues.

## Risks and dependencies

- **Atomicity of the abort paths** (U2): the dirty-working gate and the
  no-force conflict path must write NOTHING — assert via "no new version,
  installs.json unchanged, disk unchanged" in tests.
- **Re-baselining the non-converging targets** (U2 step 8): easy to re-baseline
  only the converged set and leave the promoted/preserved targets pinned to the
  old label, which the bootstrap-scan surface would flag. The ADR's "no drift in
  EITHER view" requires re-baselining all affected records.
- **Partial reinstall failure** (U2 step 7): installer is per-target
  independent; the library mutation already committed. Returning the
  `InstallSummary` in `Flattened` lets the UI offer retry without leaving the
  library half-done. (Deferred impl note: confirm with U7 whether the UI shows
  the full summary or a failure count.)
- **External dependencies:** none new. All work rides existing crates (no new
  Cargo/npm deps to pin).
- **Reference divergence:** like reimport/bootstrap, the dashboard COMMITS on
  success where the standalone reference may not (MEMORY.md: reimport diverges
  from the reference; align Flatten's commit story to the dashboard's
  commit-on-write posture, not the reference).

## Deferred (execution-time) unknowns

- Exact name for the extracted clean-working-copy helper (reuse vs copy of
  reimport's `working_diverges_from_current`) — decide when touching `flatten.rs`.
- Whether `Flattened` carries the full `InstallSummary` or a reduced
  `{converged, failed}` shape — settle against the U7 UI need.
- The precise core-crate package name for `cargo test -p ...` — read from
  `Cargo.toml` at execution time.

## References

- docs/adr/0009-flatten-promote-overlay-to-base.md
- CONTEXT.md (Flatten, Base-follower target, Overlay, Version, Drift)
- crates/core/src/{overlay_merge,reimport,version_store,working_copy,installer,drift,metadata,detail}.rs
- crates/prompt-library-bridge/src/main.rs (cmd_reimport, dispatch, commit helpers)
- scripts/library_routes.ts (buildReimport), scripts/library_models.ts (ReimportResult)
- ui/src/lib/api.ts (reimportInstall), ui/src/lib/library.ts (reimportResultCue),
  ui/src/routes/Library.svelte (reimport UI flow)

## Next step

`/deepen-plan docs/plans/2026-06-17-feat-flatten-promote-overlay-to-base-plan.md`
to resolve the three deferred unknowns (helper extraction, `Flattened` payload
shape, package name) against live code, then `/work`.
