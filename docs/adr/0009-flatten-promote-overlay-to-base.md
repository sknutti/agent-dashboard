# Flatten: promote an Overlay to the Base, reinstall converging targets, snapshot (don't reset)

A **Primitive** installed to multiple **Targets** with divergent content accumulates **Overlays** while its **Base** stays frozen — the bootstrap-drift fix exposed `improve` carrying a frozen v1 base under four versions of claude overlay. **Flatten** is the escape hatch: a user picks one **Target**'s **Overlay** and promotes it into the **Base**. This ADR records what that does to the *other* targets, how it interacts with the immutable-**Version** model, and that it reaches all the way to the installed files on disk rather than stopping at the library.

The short version: flatten makes `base := the chosen target's effective content`, drops that overlay, **preserves** every other target that has its own overlay (rebased against the new base) while **base-follower targets converge** to the new base; it then **snapshots a new Version** (never a reset), **reinstalls** the converging targets, and **re-baselines `installs.json`** so the primitive shows zero **Drift** in either drift view. A hand-edited install on a converging target **aborts** the flatten with a conflict list unless the user forces.

## Status

proposed

## Context

The Prompt Library models a **Primitive** as a **Base** plus zero-or-more per-**Target** **Overlays**; a target's installed content is `overlay_merge::merge(base, target)` = base shadowed/extended by that target's overlay (`crates/core/src/overlay_merge.rs`, `materializer.rs`). A target with no overlay therefore receives the base verbatim — a **base-follower target**.

Two facts make divergent multi-target primitives awkward. First, there is **one Version per primitive** (`current.txt` holds a single label); `installs.json` records an `installed_version` per target, but installing always installs the current version. So "all targets on the same version" is about the recorded label, not the bytes — two targets on `v4` can hold different content (base vs base∪overlay). Second, reimport-on-drift keeps the existing base and layers the diverging target as an overlay (`reimport.rs`), so over time the base content can freeze while overlays carry the "real" per-target content and the version label climbs (`improve`: base byte-identical across v1→v4, claude overlay holding the live content). The just-shipped drift fix (ADR-pending; `cross_reference.rs` per-target overlay-merge comparison) made classification correct, but there was no way to *collapse* an accumulated overlay back into the base.

The user asked for "push a specific overlay back to base and reset the version number." Grilling separated the genuine want from the proxy: the goal is "**after flatten, nothing shows as drifted**," not literally resetting the number. "Reset to v1" fights two invariants — `VersionStore::snapshot` errors (`VersionExists`) rather than rewrite a label, and wiping `versions/v1..v4` would orphan every `installs.json` record pinned to a now-deleted label, breaking drift scanning and reinstall.

There are also **two distinct drift surfaces** (the thing that prompted this whole investigation): skills-list drift (`drift.rs`: installed copy vs `installs.json` baseline) and bootstrap-scan drift (`cross_reference.rs`: installed copy vs library effective content). A library-only flatten clears neither for a converging target — the library would say a base-follower should now hold the promoted content while its on-disk file still holds the old base, which bootstrap-scan correctly flags as drifted.

## Decision

**Flatten** is a user-invoked operation on a single **Primitive**, triggered from the primitive-detail view by choosing a **Target** that *has* an **Overlay** (base-followers are not offered — promoting one is a no-op). It does the following, as one transactional unit:

1. **Gate** on a clean **Working copy** (reimport's `WorkingCopyDirty` rule) — refuse if there are un-snapshotted edits.
2. **Pre-scan** the converging **base-follower targets'** installed files for hand-edits (skills-list drift). If any are dirty, **abort with a conflict list and require an explicit force** to proceed; absent force, nothing is written. (Mirrors install's `CollidingContent` + `force`.)
3. **Mutate the library:** `base := effective(X)` (= `merge(base, X-overlay)`); drop X's overlay; for every *other* **Target** that has an **Overlay**, recompute that overlay as a delta against the new base so its **Materialized** bytes are unchanged; **base-follower targets** (no overlay) now follow the new base and so converge to X's content.
4. **Snapshot a new Version** (vN+1) and commit to the library git, consistent with reimport/publish commit-on-write. **The version number is never reset and history is never wiped.**
5. **Reinstall** the converging base-follower targets to disk (force per step 2's confirm). The promoted target and preserved-overlay targets are unchanged on disk, so only converging base-followers are rewritten.
6. **Re-baseline `installs.json`** for the affected targets (new `installed_version`, fresh hashes/mtimes) so both drift surfaces read clean.

The single unifying rule for step 3: **targets without an overlay follow base and converge; targets with an overlay are independent and are preserved.** "Converge everyone" (when the promoted target was the only overlay) and "rebase the deltas" (when multiple targets have overlays) are not modes the user selects — they fall out of who has an overlay.

## Considered and rejected

- **Reset the version number to v1 (wipe history).** Rejected: fights `Version` immutability and orphans `installs.json` records pinned to deleted labels, breaking drift/reinstall. The user's real goal ("no drift after flatten") is met by snapshotting + re-baselining, with the prior version preserved as the natural undo.
- **Library-only flatten (don't touch installed files).** Rejected: leaves a converging base-follower's on-disk file out of sync with the library, which bootstrap-scan drift correctly flags — violating the success criterion. Convergence is only real once it reaches disk.
- **Let the user pick "converge everyone" vs "rebase deltas" as a mode.** Rejected as redundant: the behavior is fully determined by which targets have overlays. A mode toggle would let the user request an incoherent state (e.g. "preserve a target that has no overlay to preserve").
- **Always force the reinstall.** Rejected: silently clobbering a hand-edited install is the kind of surprise that erodes trust; every other write path here guards content collisions. Detect → confirm → clobber instead.
- **Skip dirty (hand-edited) targets during reinstall.** Rejected: leaves those targets drifted, defeating the whole point; better to abort and make the user decide explicitly.
- **Line-level overlay merging / overlay deletes.** Out of scope: overlays remain additive whole-file shadows, so `effective(X)` always covers the base file set and there is no deletion semantics to design.
- **Bulk flatten across many primitives.** Out of scope: single-primitive, manual, deliberate.

## Consequences

- Flatten **writes to real install directories** (`~/.claude/...`, `~/.codex/...`, `~/.pi/...`) for converging targets — the first library operation besides install/reimport to mutate downstream homes, and it does so as a side effect of a library edit. The force/collision guard and clean-working-copy gate exist to keep that safe.
- Promoting an overlay **silently changes the content of base-follower targets** (intended). A target that deliberately rode the generic base will be rebased onto the promoted target's content; the operation must surface which targets will change before the user confirms.
- The new variant data and reinstall path touch the same Rust core seams as reimport (`reimport.rs`, `installer.rs`, `version_store.rs`) and flow through the bridge → `library_models.ts` → `api.ts` → UI, like the bootstrap-drift work.
- Undo is "revert to the previous Version" — history is preserved precisely so the pre-flatten state stays recoverable.
