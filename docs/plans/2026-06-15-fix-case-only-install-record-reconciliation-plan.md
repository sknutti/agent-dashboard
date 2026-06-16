# Case-Only Install-Record Reconciliation + Orphan Surfacing — Implementation Plan

- Date: 2026-06-15
- Type: fix
- Status: implemented (branch `fix/case-only-install-reconciliation`; Q1=bootstrap-only, Q2=skip-and-surface; Phase 0 confirmed exactly 2 case-only orphans, 0 collisions)
- Scope: auto-repair install records orphaned by a case-only manual disk rename
  (`Teach`→`teach`, `Synthesize`→`synthesize`) at bootstrap, and make the
  distinction between case-only-reconcilable vs truly-orphaned records explicit
  in the Library route.

## Overview / Problem statement

On a case-insensitive macOS filesystem the user manually renamed skill folders
`Teach`→`teach` and `Synthesize`→`synthesize` — both on disk under the install
roots and in the library at `~/my-prompt-library/skills/`. The app's
install-tracking file (`DATA_DIR/installs.json`, the path settled by ADR-0008)
still records those primitives as `Teach`/`Synthesize` (uppercase) for BOTH the
`claude` and `codex` targets.

Install records are keyed by `(kind, name, target)` with **case-sensitive** name
equality. Verified against the current tree:

- `crates/core/src/primitive_name.rs:36-56` — `PrimitiveName::try_new` stores the
  string verbatim; allowed charset `[A-Za-z0-9._-]` permits mixed case; derived
  `PartialEq`/`Eq`/`Hash` are case-sensitive.
- `crates/core/src/install_state.rs:142-171` — `upsert`/`remove`/`get` all match
  on `r.name == name` (case-sensitive). The tuple `(kind, name, target)` is the
  documented unique key.
- `crates/core/src/library_drift.rs:84,125` — `forget_primitive` and
  `delete_primitive` filter on `&r.name == name` (case-sensitive).
- `crates/core/src/cross_reference.rs:121-128` — `classify_one` reads the
  library's current version by `(kind, name)`; a library primitive `teach`
  (lowercase) and a — hypothetical — `Teach` group would classify independently.

**Effect:** the library primitive `teach` (lowercase) and the install record
`Teach` (uppercase) never line up. The record is never tied back to its
primitive, so drift never classifies it, Reimport is never offered, and the
user's on-disk edit can't flow into the library — the primitive is frozen at v1.
`Synthesize` has the identical latent break.

**What already exists (correction to the diagnosis brief):** the UI *does*
already surface these as orphans. `ui/src/lib/library.ts:366-388`
(`orphanInstalls`) derives "an install record whose `(kind, name)` has no
matching library primitive" purely from the drift batch (`scan_drift_batch`
enumerates every `installs.json` record — `crates/.../main.rs:520-534`) minus the
library primitive list, keyed by the case-sensitive `selectionKey`
(`library.ts:60`). Those orphans render in the Reconcile view with a CVD-safe
cyan `orphanCue` (`library.ts:392`) and a header badge
(`ui/src/routes/Library.svelte:1155,1895`). So `Teach`/`Synthesize` currently
show up as orphans whose only offered action is **forget** (drop the record) —
which is the wrong remedy: it would discard the install-tracking and any path to
Reimport, rather than re-linking it to the renamed primitive.

So the real work is:

- **(b) the genuinely-new piece** — a targeted reconciliation pass that detects a
  **case-only orphan** (a record whose `(kind, name, target)` has no exact-case
  library match but exactly one case-insensitive match) and re-links it by
  renaming the record's `name` to the library primitive's canonical case. This
  auto-repairs `Teach`/`Synthesize` so no manual `installs.json` edit is ever
  needed once shipped. It runs at bootstrap, is idempotent, and acts only on
  unambiguous case-only matches.

- **(c) a refinement of existing orphan surfacing** — once (b) re-links the
  case-only records, the *remaining* orphans are the genuinely-unmatched ones
  (no case-insensitive match at all). The plan keeps those visible (they already
  are) and ensures the case-only ones drop out of the orphan list because they've
  been repaired — not because they were forgotten.

## Confirmed root cause

(verified this session against the current tree; see file:line references above).
The diagnosis holds: case-sensitive `(kind, name, target)` equality + a manual
disk rename that bypassed the app's `rename_primitive` migration
(`crates/core/src/rename.rs`, surfaced as `renamePrimitive` in
`ui/src/lib/api.ts:1004`) = orphaned records with no recovery path.

## Approved approach: (b) + (c), NOT global case-insensitivity

Explicitly rejected: making core `(kind, name, target)` matching globally
case-insensitive. That would mask genuinely-distinct names on a case-sensitive
Linux filesystem (`foo` and `Foo` can legitimately coexist there) and would
weaken the documented unique-key invariant. Reconciliation is a **targeted,
opt-in repair pass** that *renames a record to match an existing primitive*; it
never changes the equality operator and never fires when the match is ambiguous.

## Architecture facts the plan relies on

### Facts

- The bridge is a **one-shot CLI** (`crates/prompt-library-bridge/src/main.rs`)
  dispatched per-command (`main.rs:200-309`); the Hono server (`scripts/server.ts`,
  routes in `scripts/library_routes.ts`) spawns it via `runBridge` and exposes
  `/api/library/...` HTTP routes (`library_routes.ts:1460+`). The Svelte UI
  (`ui/src/lib/api.ts`) calls those routes.
- Bootstrap runs through `bootstrap_scan` (`main.rs:1333` → core `bootstrap_scan`)
  which walks install roots, dedupes, cross-references against the library, and
  folds `derive_plan` in — returning `{cross_referenced, plan}`. Execution is
  `bootstrap_execute` (`main.rs:1358` → core `bootstrap.rs:149`), which takes a
  one-time tarball backup, then runs creates + reimports with a resumable session
  checkpoint (`bootstrap_session.rs`), committing only when
  `created + reimported > 0`.
- `InstallsFile` has `upsert`, `remove`, `get`, `load`, `save` (atomic + fd-lock)
  in `install_state.rs`. There is no existing "rename a record's name" operation.
- `LibraryLayout` (`crates/core/src/layout.rs`) resolves a primitive directory;
  the set of library primitives at launch is what `list_primitives`
  (`listing.rs`) enumerates — the same source the UI's `primitives` list and the
  cross-reference's `read_current` agree with.
- `scan_drift_batch` (`main.rs:520`) enumerates **every** record verbatim
  (case preserved) → this is what feeds the UI's orphan derivation.
- Rust tests are inline `#[cfg(test)]` modules (e.g. `library_drift.rs:169+`,
  `install_state.rs:180+`, `bootstrap.rs:630+`). Bridge tests are inline in
  `main.rs` (e.g. `main.rs:4708`). UI tests are vitest
  (`ui/src/routes/Library.svelte.test.ts`) + `svelte-check`. Server tests are
  `bun:test` (`scripts/library_routes.test.ts`).
- CVD constraint: Scott is red/green colorblind. The codebase convention is
  label + glyph + Okabe-Ito tone (`amber`/`cyan`), never bare red/green — see
  `orphanCue` (cyan ⊘), `pushGateCue` (amber ▲) in `library.ts`, and the
  `notice`/`importNotice` tones in `Library.svelte:249-252`.

### Assumptions (labeled; not yet verified)

- **A1.** `installs.json` on this machine has exactly the case-only orphans
  described (`Teach`/`Synthesize` × {claude, codex}) and no genuinely-ambiguous
  case collisions (e.g. both `teach` AND `Teach` as live library primitives).
  The algorithm is built to be safe even if A1 is wrong (ambiguous → skip), but
  Phase 0 verifies the actual file to size the fix.
- **A2.** Reconciliation belongs at **bootstrap** (the existing launch-time
  install/library convergence point), not at every drift scan. Running it inside
  `scan_drift_batch` (a frequently-polled read) would turn a read into a write.
  Bootstrap is the established "repair install↔library alignment" seam.
- **A3.** The set of library primitives reconciliation matches against is the
  same `list_primitives` enumeration the rest of the system trusts; no separate
  disk walk is needed in core (the layout/listing already does it).
- **A4.** A re-linked record keeps all its other fields (version, hashes, mtimes,
  installed_at) unchanged — only `name` changes case. The hashes still describe
  the same bytes on disk (the disk rename was case-only, contents unchanged), so
  drift will read Clean immediately after reconciliation.

### Open questions

- **Q1.** Should reconciliation run unconditionally at the start of every
  `bootstrap_execute`, or also be reachable as a standalone "repair" affordance
  the user can trigger from the Reconcile view without a full bootstrap?
  **Default if unanswered:** fold it into bootstrap only for this fix (smallest
  correct slice), and expose the case-only candidates as a distinct UI affordance
  in Phase 5 so the user isn't forced through a full scan to repair. Revisit a
  standalone bridge command only if Phase 5 shows bootstrap-coupling is awkward.
- **Q2.** When reconciliation would rename a record to a canonical name that
  *already* has a record at the same `(kind, canonical_name, target)` (i.e. both
  `Teach` and `teach` records exist for the same target), do we drop the orphan,
  merge, or skip-and-surface? **Default:** treat as ambiguous/unsafe → skip and
  leave it in the orphan list for manual handling (never silently clobber a live
  record). Phase 0's inspection of the real file confirms whether this case can
  occur here.

## Implementation phases (tracer-bullet first)

### Phase 0: Verify the live data + lock the contract

- **Objective:** confirm the exact orphan shape before writing repair logic, so
  the algorithm's safety branches are grounded in real data, not A1.
- **Changes:** read-only inspection. Dump the relevant `installs.json` records
  (names + targets for the affected `(kind)`), and list the library skill dirs,
  to confirm: (a) records are `Teach`/`Synthesize` uppercase; (b) library dirs
  are `teach`/`synthesize` lowercase; (c) no competing live record at the
  canonical name (Q2); (d) whether other latent case-only orphans exist beyond
  these two.
- **Affected areas:** `DATA_DIR/installs.json` (read), library skills dir (read).
  No code.
- **Dependencies:** none.
- **Risks:** none (read-only). Do **not** hand-edit `installs.json` — the whole
  point is that the shipped fix repairs it.
- **Validation:** a written summary of the actual orphan set; confirm Q2 cannot
  occur on this machine (or adjust the plan if it can).

### Phase 1 (TRACER): Core reconciliation function + the exact reproducing test

- **Objective:** the smallest end-to-end-meaningful unit: a pure-ish core
  function that, given the library primitive set + an `InstallsFile`, returns the
  set of **case-only re-link actions**, with a test that reproduces the precise
  `Teach`/`Synthesize` case.
- **Changes:** new module `crates/core/src/install_reconcile.rs`:
  - A `CaseRelink { kind, from_name, to_name, targets }` action struct (carries
    the verbatim `from_name`, the canonical `to_name`, and which targets were
    affected — for logging/UI).
  - `fn plan_case_relinks(library: &[(PrimitiveKind, PrimitiveName)], installs: &InstallsFile) -> Vec<CaseRelink>`:
    1. Build a lookup of library primitives keyed by `(kind, lowercased_name)` →
       the canonical `PrimitiveName`. If two library primitives share a
       `(kind, lowercased_name)` (a case collision *within the library*), mark
       that key **ambiguous** and exclude it from matching.
    2. Group install records by `(kind, name)` (verbatim case).
    3. For each group whose `(kind, name)` has **no exact-case** library primitive
       but whose `(kind, lowercased_name)` resolves to **exactly one, non-ambiguous**
       canonical library primitive whose canonical name **differs only in case**
       from the record name → emit a `CaseRelink`.
    4. **Skip** (do not emit) when: the record name already equals the canonical
       (nothing to do); the lowercased key is ambiguous; there is no
       case-insensitive match at all (that's a *true* orphan, handled by the
       existing UI); or a record already exists at the canonical
       `(kind, to_name, target)` for any affected target (Q2 collision → unsafe).
  - `fn apply_case_relinks(installs: &mut InstallsFile, relinks: &[CaseRelink])`:
    for each relink, for each record matching `(kind, from_name, *)`, rewrite its
    `name` to `to_name`. Pure in-memory mutation; idempotent (re-running on
    already-canonical records is a no-op because step 3 won't emit them).
  - Wire the module into `crates/core/src/lib.rs` (export `plan_case_relinks`,
    `apply_case_relinks`, `CaseRelink`).
- **Tests (inline `#[cfg(test)]`, written first):**
  - `teach_synthesize_case_only_orphan_produces_relinks` — the canonical
    reproduction: library has `teach`/`synthesize` (lowercase); installs has
    `Teach`/`Synthesize` × {Claude, Codex}; assert two `CaseRelink`s with the
    right `from`/`to`/`targets`, and that `apply_case_relinks` rewrites all four
    records to lowercase.
  - `exact_case_match_produces_no_relink` — `teach` record + `teach` primitive →
    empty.
  - `true_orphan_no_ci_match_is_left_alone` — record `Ghost`, no `ghost`
    primitive → empty (this is the existing-UI orphan path; reconciliation must
    NOT touch it).
  - `ambiguous_library_case_collision_is_skipped` — library has BOTH `foo` and
    `Foo`; record `FOO` → ambiguous → empty (no silent pick).
  - `canonical_target_collision_is_skipped` — records `Teach`@Claude AND
    `teach`@Claude both present → skip (Q2; never clobber a live record).
  - `apply_is_idempotent` — running `plan`+`apply` twice yields no further change.
  - `non_case_difference_is_not_a_relink` — guards that we only act on pure
    case differences, not arbitrary renames.
- **Affected areas:** `crates/core/src/install_reconcile.rs` (new),
  `crates/core/src/lib.rs`.
- **Dependencies:** Phase 0 (to confirm Q2 branch is needed — it is, defensively,
  regardless).
- **Risks:** getting the "differs only in case" predicate right for ASCII (the
  charset is ASCII-only per `primitive_name.rs`, so `eq_ignore_ascii_case` +
  `!=` exact is sufficient and avoids Unicode-casefolding subtlety).
- **Validation:** `cargo test -p <core-crate> install_reconcile` green; the first
  test fails before the impl exists and passes after (true tracer).

### Phase 2: Wire reconciliation into bootstrap_execute (core)

- **Objective:** run the repair at the established launch-time convergence point
  so the live machine self-heals on next bootstrap.
- **Changes:** in `crates/core/src/bootstrap.rs`, at the start of
  `bootstrap_execute` (after session setup, before/around the creates loop — a
  point where `installs.json` is loaded and saved anyway):
  - Enumerate current library primitives via the layout/listing already available
    to bootstrap (reuse the same source `cross_reference`/`list_primitives` use —
    `LibraryLayout` is in `BootstrapExecuteRequest`).
  - `load` installs, `plan_case_relinks`, and if non-empty `apply_case_relinks` +
    `save`. Record a count on `BootstrapExecuteSummary` (new field, e.g.
    `reconciled: u32`) so the bridge/UI can report "re-linked N records".
  - Idempotent + safe on resume (re-running finds nothing to do).
- **Tests (inline in `bootstrap.rs`):**
  - `bootstrap_reconciles_case_only_orphan_before_creates` — seed a library with
    `teach` at v1 + an `installs.json` record `Teach`; run `bootstrap_execute`
    with an empty plan; assert the record is now `teach` and
    `summary.reconciled == 1`, with no spurious create/reimport.
  - `bootstrap_reconcile_then_drift_reads_clean` (cross-checks A4) — after
    reconciliation, a follow-up `scan_record`/drift over the re-linked record
    reads Clean (the contents never changed; only the name case did).
- **Affected areas:** `crates/core/src/bootstrap.rs`,
  `crates/core/src/install_reconcile.rs` (consumed),
  `BootstrapExecuteSummary` (+ field — note this is a `specta::Type`, so the TS
  binding gains a field; check no exhaustive consumer breaks).
- **Dependencies:** Phase 1.
- **Risks:** `BootstrapExecuteSummary` is serialized to the wire and has a
  `specta::Type` derive — adding a field is additive/safe but the bridge + UI
  parsers must tolerate it (they do; they read named fields). Confirm the commit
  gating: a reconcile-only run mutates `installs.json` (dashboard-owned,
  gitignored per ADR-0008) and writes nothing git-tracked, so it must NOT trigger
  a library commit — keep the existing `created + reimported > 0` gate; do not
  add `reconciled` to it.
- **Validation:** `cargo test` for bootstrap green; manual confirmation that a
  reconcile-only bootstrap leaves the library git tree untouched (no commit).

### Phase 3: Surface reconcile count through the bridge

- **Objective:** let the bridge's `bootstrap_execute` response carry the
  reconcile count so the UI can report it, without changing the commit posture.
- **Changes:** `crates/prompt-library-bridge/src/main.rs` `cmd_bootstrap_execute`
  (`main.rs:1358-1393`) already serializes the full `BootstrapExecuteSummary`
  (`serde_json::to_value(&summary)`), so the new `reconciled` field rides through
  automatically. Verify (a) the message string and commit gate are unchanged
  (still `created + reimported > 0`), and (b) add an inline bridge test asserting
  the field is present in the envelope when a case-only orphan was seeded.
- **Tests (inline in `main.rs`):**
  - `bootstrap_execute_reports_reconciled_count` — fixture with a `Teach` record
    + `teach` library primitive; assert `data["reconciled"] == 1` and that no
    commit happened (`created + reimported == 0`).
- **Affected areas:** `crates/prompt-library-bridge/src/main.rs` (test +
  verification; likely zero production-line change since serialization is
  whole-struct).
- **Dependencies:** Phase 2.
- **Risks:** low — the envelope is whole-struct serialized; the only risk is an
  over-strict TS parser (addressed in Phase 4).
- **Validation:** bridge test green; `cargo test -p prompt-library-bridge`.

### Phase 4: Server route + TS types tolerate the new field

- **Objective:** thread `reconciled` through the Hono route and the TS
  `BootstrapExecute` result type so the UI can render it.
- **Changes:**
  - `scripts/library_routes.ts` `buildBootstrapExecute` (`:1197-1216`) — confirm
    its validator (if any `parse...` is applied to the execute result) admits the
    new field; widen the schema/type if it strips unknown keys.
  - `ui/src/lib/api.ts` bootstrap section (`:1026+`) — add `reconciled: number`
    to the `LibraryBootstrapExecuteResult` (or equivalently named) type.
- **Tests:**
  - `scripts/library_routes.test.ts` (bun:test) — a `buildBootstrapExecute` case
    with a stub `run` returning a payload that includes `reconciled` asserts it
    passes through (and isn't stripped by validation).
- **Affected areas:** `scripts/library_routes.ts`, `ui/src/lib/api.ts`,
  `scripts/library_routes.test.ts`.
- **Dependencies:** Phase 3.
- **Risks:** if validation uses an exact/strict object schema, an unmodeled field
  could be dropped or rejected — the test guards this.
- **Validation:** `bun test scripts/library_routes.test.ts`; `svelte-check`/`tsc`
  clean.

### Phase 5: UI — distinguish "repaired" from "truly orphaned", report the repair

- **Objective:** after a bootstrap that reconciled case-only records, the user
  sees a clear, CVD-safe confirmation, and the Reconcile view's orphan list now
  contains only *genuine* orphans (the `Teach`/`Synthesize` rows are gone because
  they were re-linked, not forgotten).
- **Changes:** `ui/src/routes/Library.svelte`:
  - When a `bootstrap_execute` result has `reconciled > 0`, set the existing
    `notice`/`importNotice` state to an **amber** (or cyan) message —
    `"Re-linked N install record(s) to renamed primitives"` — reusing the
    established `notice` tone pattern (`Library.svelte:249-252`); never red/green.
  - No new derivation needed for the orphan list: `orphanInstalls`
    (`library.ts:366`) is already correct — once core renames the records, the
    next `driftBatchRes.reload()` (already called post-action,
    `Library.svelte:256-257`) drops them from `orphans` because their
    `(kind, name)` now matches a live primitive via `selectionKey`.
  - Optional clarity (if Phase 0/Q1 favor it): in the Reconcile view's orphan
    rows, keep the existing cyan `orphanCue` ⊘ for *true* orphans and add a short
    help line (mirroring the `.drift-help`/`.overlay-stale-note` amber pattern
    referenced in the brief) explaining that case-only mismatches are auto-repaired
    by running bootstrap — so a user staring at a pre-fix orphan knows the remedy
    is "run bootstrap", not "forget".
- **Tests:** `ui/src/routes/Library.svelte.test.ts` (vitest) —
  - A test that a `bootstrap_execute` result with `reconciled: 2` renders the
    CVD-safe notice (assert the text + that the tone class is amber/cyan, not a
    red/green class).
  - A test that an orphan whose `(kind, name)` now matches a primitive (post-
    reconcile reload) no longer appears in the rendered orphan list (exercises the
    existing `orphanInstalls` derivation, guarding the regression).
- **Affected areas:** `ui/src/routes/Library.svelte`,
  `ui/src/routes/Library.svelte.test.ts`. No `useEffect`-equivalent — all changes
  are derived state / event-handler driven (the notice is set in the
  bootstrap-completion handler; the orphan list is `$derived`).
- **Dependencies:** Phase 4.
- **Risks:** none structural; keep strictly to existing tone tokens. Verify no
  `useEffect`/lifecycle-sync is introduced (the post-action reloads are already
  event-handler driven at `Library.svelte:256`).
- **Validation:** `vitest run Library`; `svelte-check`; manual: launch the app on
  the affected machine, run bootstrap, confirm the two skills now show drift /
  offer Reimport and the orphan badge no longer counts them.

## Acceptance criteria

- AC1: Given a library primitive `teach` (lowercase) and `installs.json` records
  `Teach` for {claude, codex}, after one bootstrap run the records are renamed to
  `teach` and `Synthesize`→`synthesize`, with no manual `installs.json` edit.
  (Phase 1–2 tests assert this end to end.)
- AC2: A re-linked record reads **Clean** drift immediately after reconciliation
  (contents unchanged; A4). (Phase 2 test.)
- AC3: Reconciliation never fires on an ambiguous case collision (library has both
  `foo` and `Foo`) and never clobbers an existing canonical record (Q2). (Phase 1
  tests.)
- AC4: A true orphan (no case-insensitive match at all) is left untouched by
  reconciliation and still surfaces in the Reconcile view via the existing cyan
  `orphanCue`. (Phase 1 test + existing UI behavior.)
- AC5: A reconcile-only bootstrap (no creates/reimports) writes nothing to the
  library git tree and creates no commit. (Phase 2/3 verification.)
- AC6: The bootstrap result reports the reconcile count end to end (core →
  bridge → route → UI), and the UI shows a CVD-safe (label + tone, no red/green)
  confirmation. (Phase 3–5 tests.)
- AC7: Global `(kind, name, target)` equality remains case-sensitive — no change
  to `install_state.rs`/`library_drift.rs` matching operators. (Code review +
  unchanged existing tests stay green.)
- AC8: The whole change is idempotent — a second bootstrap reconciles nothing.
  (Phase 1 `apply_is_idempotent` + Phase 2 resume safety.)

## Dependencies and risks

- **ADR-0008** governs install-state ownership: `installs.json` is dashboard-owned,
  gitignored, per-machine. Reconciliation mutating it is consistent with that
  ownership and must **not** trigger a library commit (AC5). The reconcile pass is
  the install-side analog of `forget_primitive`'s "touch only installs.json, no
  commit" posture.
- **`BootstrapExecuteSummary` is a `specta::Type`** on the wire — adding
  `reconciled` is additive; Phase 3/4 tests guard the parsers.
- **Charset is ASCII-only** (`primitive_name.rs`), so case comparison uses
  `eq_ignore_ascii_case`; no Unicode case-folding edge cases.
- **Bootstrap coupling (Q1):** if the user must run a full bootstrap to repair,
  that may feel heavy for a pure case fix. Mitigation deferred to Q1's default;
  Phase 5's help line tells the user the remedy. Revisit a standalone repair
  command only if review favors it.
- **Reference divergence:** the standalone reference app has no case-reconciliation
  pass (this is a dashboard-specific repair for a dashboard-specific manual-rename
  scenario). Log this divergence in auto-memory on completion, consistent with the
  project's reference-divergence tracking.

## References

- `crates/core/src/primitive_name.rs:36-56` — verbatim-case name; ASCII charset.
- `crates/core/src/install_state.rs:142-171` — case-sensitive upsert/remove/get;
  unique-key invariant.
- `crates/core/src/library_drift.rs:75-90,118-167` — forget/delete (the
  install-only, no-commit posture to mirror).
- `crates/core/src/cross_reference.rs:111-146` — `(kind, name)` classification.
- `crates/core/src/bootstrap.rs:149-219` — `bootstrap_execute` (reconcile insertion
  point + `BootstrapExecuteSummary`).
- `crates/prompt-library-bridge/src/main.rs:520-534` (`scan_drift_batch`),
  `:1333-1341` (`bootstrap_scan`), `:1358-1393` (`bootstrap_execute`).
- `scripts/library_routes.ts:1177-1216` — bootstrap scan/execute route builders.
- `ui/src/lib/library.ts:60` (`selectionKey`), `:355-394` (`orphanInstalls` /
  `orphanCue` — the existing orphan-surfacing path).
- `ui/src/routes/Library.svelte:71,249-257,793-797,1155,1895` — orphan wiring,
  notice tones, post-action reloads.
- `docs/adr/0008-...md` (esp. Amendment 2026-06-11, §52: `scan_library_drift` /
  `MissingPrimitive` is a *distinct* concept from install drift — reconciliation
  here is yet another distinct concern: case-only re-linking, not missing-dir
  reconcile).

## Next step

`/workflows:work docs/plans/2026-06-15-fix-case-only-install-record-reconciliation-plan.md`
starting at Phase 0 (verify the live `installs.json` shape and resolve Q1/Q2),
then the Phase 1 tracer (core `plan_case_relinks` + the `Teach`/`Synthesize`
reproducing test) before any wiring.
