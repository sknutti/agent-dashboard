# Bootstrap overlay bug — diagnosis (2026-06-16)

Import builds a primitive's `base` + per-target overlays wrongly: stale `base`
under newer overlays, or overlays conjured from sources that no longer exist on
disk.

## The three symptoms

1. **teach** — install copies were `.claude`=NEW, `.codex`=OLD. Import produced
   `base`=OLD, `targets/claude`=NEW, `targets/codex`=NEW (both overlays new,
   base stale). Should have been `base`=NEW with overlays collapsed away, since
   after a later sync both copies were identical.
2. **grill-with-docs reimport** — a reimport kept `base`=OLD and added
   `targets/claude`=NEW.
3. **grill-with-docs fresh create (smoking gun)** — after deleting the library
   primitive, the ONLY install copy on disk was `~/.claude/skills/grill-with-docs`
   (NEW). No `.codex`, no `.pi`. A fresh import produced `base`=NEW PLUS a
   phantom `targets/pi/`=OLD. A Pi overlay with OLD content appeared though no
   Pi source exists on disk.

## Confirmed root cause (file:line)

**UI-flow / stale-plan bug (H1).** The `BootstrapPlan` is a *scan-time snapshot
of source paths + target assignments*. It is computed once at scan time and then
executed verbatim against a *later, mutated* filesystem. Nothing re-scans or
re-derives the plan between scan and execute.

- `crates/core/src/bootstrap.rs:42-50` — `CreateAction { base, overlays }`
  carries `BaseAssignment`/`OverlayCandidate`, each of which is just a
  `(target, source_path, parse)` tuple (`crates/core/src/deduper.rs:73-88`). The
  plan embeds **scan-time paths**, not content, and crucially the **scan-time
  target split** (which copy is base vs overlay).
- `crates/core/src/bootstrap.rs:424-509` — `execute_one_create` re-reads each
  `source_path` from disk at execute time but **trusts the plan's base/overlay
  partition**. If pi was OLD at scan time, the plan says "pi is an overlay"; at
  execute time pi has been synced/changed/deleted, but the action still writes a
  `targets/pi/` overlay from whatever is at that path now → phantom/stale overlay.
- `ui/src/lib/components/BootstrapWizard.svelte:64,80-86,116-135` — `scanResult`
  (holding `plan`) is `$state`, set once by `runScan()` and reused verbatim by
  `filteredPlan()` → `execute()`. **The review→execute path never re-scans.** A
  user who scans, then syncs/edits their source dirs, then clicks "Import"
  executes the stale plan. (The wizard's own comment at lines 4-6 and 137-144
  even notes the plan is "held between scan and execute" — only the *resume*
  path re-scans; the normal path does not.)
- Downstream amplifier for symptom 2: `crates/core/src/reimport.rs:152-189`.
  Reimport decides base-vs-overlay purely from `metadata.allowed_targets`
  (`single_target_primitive = len()==1 && [0]==source_target`). A stale create
  that wrote a phantom second target into `metadata.allowed_targets`
  (bootstrap.rs:449-465) makes a later reimport treat the real source as an
  *overlay*, so NEW bytes land in `targets/claude/` and `base` stays OLD.

So all three symptoms chain from one defect: **the plan is a stale snapshot and
is executed without re-validating against current disk state.** Symptom 3 is the
pure form (phantom overlay at create); symptoms 1 and 2 are the same staleness
plus reimport's metadata-driven base/overlay routing carrying the phantom forward.

## Which hypothesis won, and why the others were ruled out

- **H1 stale-scan/flow — WON.** The plan carries paths + a scan-time target
  split and is executed against a later filesystem; the UI never re-scans on the
  review→execute path. The smoking-gun test shows a *fresh* re-scan after the
  sync yields the correct `base`=NEW, zero overlays (asserted, passes), while
  executing the *held* plan produces the phantom overlay (asserted, fails).
- **H2 dedupe base-assignment — RULED OUT.** `deduper.rs` is pure and correct in
  isolation: a singleton group yields `Identical{base}` with **no** overlays
  (`singleton_candidate_is_identical_with_that_target_as_base`), and identical-
  across-targets content collapses to `Identical` (no overlays). All 444 non-new
  tests pass. The deduper only misbehaves when fed a *stale* candidate set — i.e.
  the input is wrong, not the logic.
- **H3 reimport-preserves-base — RULED OUT as a standalone cause.** Reimport
  correctly writes to `base` for a genuinely single-target primitive
  (`reimport_for_single_target_writes_to_base`). It only writes to an overlay
  when `metadata.allowed_targets` already lists >1 target — which only happens
  because a *stale create* (H1) wrote the phantom target. H3 is a *symptom* of
  H1, not an independent root cause.
- **H4 phantom source (backup tarball / git tree / cache) — RULED OUT.**
  `source_backup.rs` only *writes* a tarball; nothing reads it back during
  import. `read_canonicalized_bundle`/`read_install_state` read only the live
  `source_path`. The phantom pi overlay is fully explained by the stale plan
  re-reading a pi path that still existed (with OLD content) at execute time —
  no alternate source is needed.

## Failing regression tests (left in the worktree)

`crates/core/src/bootstrap.rs`, module `bootstrap::tests`:

- `stale_plan_conjures_phantom_overlay_from_synced_source_bug` — symptom 3 (smoking gun)
- `stale_plan_leaves_redundant_overlay_teach_bug` — symptom 1 (teach)
- `reimport_with_phantom_multitarget_metadata_keeps_base_stale_bug` — symptom 2

Run:

```
CC=/usr/bin/cc cargo test -p prompt-library-core --lib bootstrap::tests
```

All three FAIL today (they assert the correct post-sync outcome). The rest of
the suite (444 tests) passes — confirming the core primitives are individually
correct and the fault is the flow that feeds them a stale plan.

## Proposed fix direction (do NOT implement here)

This is a **UI-flow fix, not a core-logic fix.** The plan must be (re)derived
from the filesystem *at execute time*, not trusted from scan time. Options, in
preference order:

1. **Re-scan before execute (smallest, matches the resume path).** In
   `BootstrapWizard.svelte`, the review→execute path should re-run
   `bootstrapScan()` and re-derive the plan immediately before
   `bootstrapExecute()`, then reconcile the user's exclusion selections by
   `(kind, name)` (the same key `filteredPlan()`/`selectionKey` already use).
   The *resume* path already re-scans (lines 137-144); make the normal path do
   the same. This kills symptom 3 directly and prevents the phantom metadata
   that drives symptoms 1 and 2.
2. **Validate-or-recompute in the bridge/core seam.** Have `bootstrap_execute`
   (or a thin wrapper) re-scan and re-classify the `(kind, name)`s named in the
   incoming plan, and recompute each action's base/overlay split against current
   disk, rejecting/replacing any action whose on-disk shape no longer matches.
   This makes the core robust even if a future caller passes a stale plan, at
   the cost of a second scan.

Either way, the load-bearing change is "the base/overlay partition must reflect
disk state at execute time, never scan time." A core-only fix (e.g. collapsing
identical overlays into base inside `execute_one_create`) would patch symptom 1
but not symptom 3 (a single live source with a phantom overlay path) — so the
flow must re-derive, not just post-process.
