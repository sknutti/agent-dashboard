# Prompt Library Consolidation — Slice 5: Target Overlays — Implementation Plan

- **Date:** 2026-06-12
- **Type:** feat
- **Slice:** 5 of the consolidation roadmap (`docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md`, "Slice 5" section)
- **Depends on (shipped):** read-only slice (PR #4), install/drift slice (PR #5), working-copy/editor slice (Slice 3, PR #6 — `WorkingFileEditor.svelte` + the `save_working`/`*_working_file` bridge arms), versioning/publishing slice (Slice 4, commit `39933b8` — the publish/version-inspector seams this slice sits beside).
- **ADRs:** ADR-0007 (Rust command bridge, error/contract posture, secrets-free invariant), ADR-0008 (install-state ownership, poll-don't-push).
- **Planning depth:** Standard. The core (`read_primitive_for_target`, `save_primary_target`, `remove_primary_target`, `list_overlays`, `overlay_merge::merge`) is **already present and tested** in this repo's `crates/core`, and `map_core_error` already maps the one new error (`TargetNotAllowed`). The work is overwhelmingly **bridge dispatch + thin TS seams + UI** — the smallest authoring slice so far, because Slice 3 and 4 built every seam this one extends and the merge/materialize logic was imported wholesale. No new architectural decisions; the risks are UX-clarity, not infrastructure.

## Overview / problem statement

The Library editor edits the **base** working copy (Slice 3). It cannot yet edit the **per-target overlay** — the Target-specific delta files under `working/targets/<target>/` that shadow base files at install time. The materializer already merges them (`overlay_merge::merge`, base ∪ target with target winning per relative path — `crates/core/src/overlay_merge.rs:11`), and install already deploys the merged result. What's missing is the **authoring surface**: read the merged view for a `(primitive, target)`, write/update an overlay file, remove it, and list which targets carry overlays — so an author can craft "Claude gets this body, Pi gets that one" without hand-editing `working/targets/`.

This slice ports the reference's four overlay commands and makes the editor target-aware. It is **network-free and secrets-free** — it ships under the exact invariants Slices 3–5 (working-copy, versioning) already proved: write-mutex-free working-copy writes (overlays live under gitignored `working/`, like base edits), atomic per-file writes in core, and route-local failure.

## Repository facts (verified at source, 2026-06-12)

### Core is fully present and tested — no core work this slice

The dashboard's `crates/core` already carries every function the reference's four commands call, with passing unit tests:

- **`crates/core/src/detail.rs:129` — `read_primitive_for_target(layout, kind, name, target) -> Result<TargetView, Error>`.** Loads the primitive's `OverlayBytes` via `WorkingCopy::load`, materializes for the target (`materialize`, which calls `overlay_merge::merge`), decodes the primary file per kind (MD frontmatter+body, or TOML text), and returns `TargetView { working: WorkingContent, has_overlay: bool }` (`detail.rs:118-125`). `has_overlay` is **true iff `working/targets/<target>/<primary>` exists** (`:147-151`) — the editor's signal for "this is a real overlay delta vs. just the base shown through this target."
- **Critical wrinkle — `read_primitive_for_target` REJECTS a disallowed target.** `materialize` errors `Error::TargetNotAllowed` when `target ∉ metadata.allowed_targets` (`materializer.rs:43-48`; tested at `detail.rs:550-559`). So a target tab is only readable if the primitive's metadata allows that target. This shapes the UI: **only render overlay tabs for `allowed_targets`**, never the full `{Claude,Pi,Codex}` enum.
- **`crates/core/src/working_copy.rs:80` — `WorkingCopy::save_primary_target(kind, name, target, bytes)`.** Parse-validates the bytes for the kind (`validate_primary_bytes` — MD via `MdPrimitive`, codex via `CodexAgentFile`) **before** the atomic write; bad bytes never reach disk. Writes `working/targets/<target>/<primary>` via `atomic_write`.
- **`crates/core/src/working_copy.rs:93` — `WorkingCopy::remove_primary_target(kind, name, target)`.** Idempotent (no-op if absent) `remove_file` of the primary overlay file.
- **`crates/core/src/detail.rs:190` — `list_overlays(layout, kind, name) -> Result<Vec<OverlayList>, Error>`.** Returns one `OverlayList { target: Target, paths: Vec<String> }` per target that has ≥1 overlay file (empty targets omitted; paths sorted — `:198-207`). Tested at `detail.rs:561-588`.
- **`crates/core/src/overlay_merge.rs:11` — `merge(overlay, target)`** — pure, infallible, base-then-target-shadow. **Already has the reference golden tests** (`overlay_merge.rs:46-87`: base-only, shadow-on-conflict, target-introduces-new-file, empty, no-mutation). The roadmap's "merge output matches reference golden" gate is **already satisfied in-tree** — this slice does not re-port merge; it asserts the bridge wiring threads through it via `read_primitive_for_target`.

### The bridge is the only Rust work — four dispatch arms + four command bodies

- **`crates/prompt-library-bridge/src/main.rs:103-145` — `dispatch`.** Currently serves the 12 read/install + 7 working-file + 4 versioning arms. Add a fourth block: `read_primitive_target`, `write_overlay`, `remove_overlay`, `list_overlays`. **All four are sync** (`std::fs` only — no git, no `.await`), exactly like the working-file commands (`:120-131`) — overlays write under gitignored `working/`, so unlike publish there is **no commit step**.
- **`map_core_error` (`main.rs:1017-1085`) already maps every error these commands can raise.** `CoreError::TargetNotAllowed { .. }` → `("library_target_not_allowed", …)` is present (`:1042-1044`); the parse failures (`MdFrontmatter`/`CodexAgentParse`/`NotUtf8`/`MetadataParse`) → `library_parse_error` (`:1025-1030`); `Io`/`NotALibrary`/`PrimitiveNotFound` are all mapped. **No new `map_core_error` arm is needed** — verified against all four core fns' error surfaces. (Contrast Slice 4, which had to add `VersionExists`/`VersionNotFound`.)
- **Parse helpers exist:** `require_library` (`:723`), `parse_kind`, `parse_name` (`:771`), `parse_target` (single-target enum, `:817`), `parse_required_str` (`:828` — used for `content`). The overlay bodies need **zero new parse helpers** — `parse_target` + `parse_required_str("content")` cover them. (Note: `parse_target` reads `args.target` as the `claude|pi|codex` serde enum and returns `library_invalid_target` on a bad value — already 422-mapped.)
- **No new bridge dependency.** No git, no secrets, no network — the `Cargo.toml:12-14` secrets-free comment is untouched; the "no `SecretStore` constructed" invariant holds.

### The TS seams to extend (thin — mirror the working-file builders)

- **`scripts/library_models.ts:46-48` — `WorkingContent`** (the md/toml tagged union) already exists; `read_primitive_target` reuses it inside a new `TargetView`. Add `TargetView { working: WorkingContent; has_overlay: boolean }` + `OverlayList { target: TargetName; paths: string[] }` interfaces and their `parse*` validators (mirror the existing `parsePrimitiveVersionView` shape, `models.test.ts` covers the family).
- **`scripts/library_routes.ts`** — the working-file builders (`buildReadWorkingFile:413`, `buildSaveWorking:432`, `buildDeleteWorkingFile:504`) are the exact template. Add `buildReadPrimitiveTarget` (read, no lock, default timeout), `buildWriteOverlay`/`buildRemoveOverlay` (writes — `WRITE_TIMEOUT_MS`, **no `withWriteLock`**, per the working-file precedent at `:714-733`: overlays never touch `installs.json`), `buildListOverlays` (read).
- **`statusForCode` (`library_routes.ts:73-117`) needs NO new arm.** `library_target_not_allowed` already → 422 (`:102`); `library_parse_error`/`primitive_not_found`/`library_invalid_target` are all mapped. Verified against the four commands' error codes.
- **Route registration (`library_routes.ts:644-758`).** The `:target` segment slots cleanly: `GET …/primitives/:kind/:name/targets/:target` (read merged view), `PUT …/targets/:target/overlay` (write), `DELETE …/targets/:target/overlay` (remove), `GET …/primitives/:kind/:name/overlays` (list). `:target` carries no `/`, so it's a safe path segment (unlike the working-file ref path, which needed `?path=`). Mount **after** the `/working-files*` and `/versions*` routes; `/targets` and `/overlays` are distinct prefixes — no collision.
- **`server.ts:63-101`** loopback Host + Origin write-guard already covers the new `PUT`/`DELETE` (it guards all non-GET on `/api/library/*`) — reconfirm with the existing guard test pattern, add the new verbs to it.

### The UI seams to extend

- **`ui/src/lib/components/WorkingFileEditor.svelte`** is the per-primitive editor, keyed on `(kind/name)` so it remounts per primitive (Slice 3's no-`useEffect` state reset). It currently edits **base** files only: `buffer`/`baseline` plain `$state`, hydrated by event handlers (never tracking the `working` prop — the W5 lost-edits-across-poll guard). The overlay editor extends this component (or sits beside it as a sibling pane) with a **target dimension**.
- **`ui/src/routes/Library.svelte:147-155` — `targetRows`** already derives one row per `metadata.allowed_targets` (folding install + drift). The overlay UI reuses `allowed_targets` as the tab/row source — **never the full `Target::ALL` enum** (the disallowed-target rejection above makes that mandatory, not just tidy).
- **`ui/src/routes/Library.svelte:665` — `.doc-tabs`** is where the base/ref editor tabs render; a per-target overlay tab strip is the natural extension point.
- **`ui/src/lib/library.ts:73-113` — `Cue`** vocabulary (`label`+`glyph`+`tone ∈ {amber,cyan,default}`, never bare red/green; `dirtyCue`/`editorDirtyCue`/`publishStateCue`/`currentVersionCue`). Add an **`overlayCue`** to make "overlay delta vs. base passthrough" unmistakable without color (risk-a). Unit-test cue distinguishability (the `library.test.ts` cue-without-color pattern already exists).
- **`ui/src/lib/api.ts:620-699`** — the working-file + version fetchers are the shape template. Add `readPrimitiveTarget`, `writeOverlay`, `removeOverlay`, `listOverlays` fetchers + the `TargetView`/`OverlayList` TS interfaces.

## Decisions to settle (the roadmap flagged these; settled here)

### Decision 1 — Overlay editing is a Target DIMENSION on the base editor; the merged view is read-through, the overlay is the only writable layer.

The reference's `read_primitive_target` returns the **merged** primary (`TargetView.working` = base ∪ target overlay), plus `has_overlay`. The author edits the **overlay** (`write_overlay` saves `working/targets/<target>/<primary>` only — never base). So the UI has two distinct states per target tab:

- **`has_overlay: false`** — the merged view IS the base. Show it **read-only** with an **"Add overlay for <target>"** affordance (the reference's exact intent — `commands.rs:530-533` doc: the flag "decides whether to show the 'Add overlay' affordance or to allow editing"). "Add overlay" seeds the overlay editor from the current base bytes (`write_overlay` with the base content as the starting point) so the author edits a delta, not a blank file.
- **`has_overlay: true`** — the overlay file exists; the tab is **editable** (the buffer is the overlay's effective bytes, i.e. the merged primary, which for the primary file = the overlay file since it shadows base). Saving calls `write_overlay`; a **"Remove overlay"** action calls `remove_overlay` and the tab reverts to the read-only base passthrough.

**Scope note:** the reference's `write_overlay`/`remove_overlay` act on the **PRIMARY** file only (`save_primary_target`/`remove_primary_target` — `working_copy.rs:80,93`). Overlay **ref** files exist in the data model (`OverlayBytes.targets[t]` is a map, and `list_overlays` enumerates all of them) but the reference exposes no per-ref overlay write command — only the primary. **This slice ports exactly that surface: primary-file overlays only.** `list_overlays` still lists every overlay file (primary + any refs that landed via publish/revert/import), and the UI surfaces that list, but the **write/remove affordances are primary-only**, matching the reference. Per-ref overlay editing is explicitly out of scope (no reference command for it; flag it as a future extension if wanted).

### Decision 2 — Overlay writes do NOT commit. WRITE_TIMEOUT + SIGKILL, no ledger mutex, no git.

Overlays live under `working/targets/<target>/`, which the library `.gitignore` excludes (same as `working/base/`). A commit after an overlay write would be a no-op. So overlay writes are **pure-fs, single-file-atomic** (core's `atomic_write`), exactly like the base working-file editor writes (Slice 3) and `revert_to_version` (Slice 4, Decision 2 — no commit). **Decision: `write_overlay`/`remove_overlay` are sync bridge commands, get `WRITE_TIMEOUT_MS` + SIGKILL at the route, and skip `withWriteLock`** (no `installs.json` touch). This is the established working-copy-write posture — no new safety story to invent.

### Decision 3 — Overlay edits make existing installs read as DRIFT. This is correct; the UI must explain it, not hide it.

(Roadmap risk-b.) An overlay edit changes what a **future** install/reinstall deploys; it does **not** re-install. An already-installed `(kind, name, target)` will, on the next drift scan, read as **drifted** (the on-disk install no longer matches the now-edited merged source). This is correct behavior — but surprising if silent. **Decision: when an overlay is written/removed for a target that has an existing install record, surface an inline, route-local note** ("This overlay change won't reach the installed copy until you reinstall — the install will show as drifted") next to the affected target's install row. The drift itself is detected by the existing drift scan (no new wiring); the slice's deliverable is the **explanatory copy + the cross-link** to the existing reinstall action, not new drift logic. Colorblind-safe (label + glyph, amber tone — the existing drift cue vocabulary).

### Decision 4 — Only `allowed_targets` get overlay tabs. The closed enum is the data model; the metadata is the gate.

Targets are the closed `{Claude, Pi, Codex}` enum (no Antigravity overlay — ADR-0007; `Target::ALL` is the source). But `read_primitive_for_target` errors `TargetNotAllowed` for a target not in the primitive's `metadata.allowed_targets` (Fact above). **Decision: the overlay tab strip is driven by `metadata.allowed_targets`, not `Target::ALL`.** A target the primitive doesn't allow gets no overlay tab — attempting it would 422, so the UI never offers it. This also means **changing `allowed_targets` (Slice 6, metadata editing) changes which overlay tabs appear** — a forward dependency to note, not resolve here. If `allowed_targets` is empty (fresh scaffold), there are no overlay tabs and the base editor is the whole story.

## Implementation phases (test-first within each)

### Phase 1 — Bridge: four overlay commands

- **Objective:** Wire `read_primitive_target`, `write_overlay`, `remove_overlay`, `list_overlays` into the dispatch — all sync, no commit, reusing existing parse helpers and `map_core_error`.
- **Changes:**
  1. Four `cmd_*` fns mirroring the working-file command bodies (`main.rs:508-627`):
     - `cmd_read_primitive_target`: `require_library` → `parse_kind`/`parse_name`/`parse_target` → `read_primitive_for_target(...)` → `serde_json::to_value(view)`. Read-only.
     - `cmd_write_overlay`: `... parse_target` → `parse_required_str(args, "content")` → `WorkingCopy::new(layout).save_primary_target(kind, &name, target, content.as_bytes())` → `Ok(json!({}))`.
     - `cmd_remove_overlay`: `... parse_target` → `WorkingCopy::new(layout).remove_primary_target(kind, &name, target)` → `Ok(json!({}))`. Idempotent (core no-ops on absent).
     - `cmd_list_overlays`: `... parse_name` → `detail::list_overlays(layout, kind, &name)` → `serde_json::to_value(list)`. Read-only.
  2. Dispatch arms (`main.rs:140`, a new "Target overlays slice" block after the versioning block): four entries, **none `.await`** (all sync — comment that overlays are gitignored-`working/` writes with no commit, like the working-file arms).
  3. Confirm `map_core_error` needs **no new arm** (verified — `TargetNotAllowed`, `library_parse_error`, `Io`, `PrimitiveNotFound` all mapped). Add a one-line comment at the overlay block noting the reuse.
- **Affected:** `crates/prompt-library-bridge/src/main.rs` (dispatch + four `cmd_*` fns + the bridge's `#[cfg(test)]` module). No `Cargo.toml` change.
- **Risks:** the `content` arg name must match what the TS route sends (`content`, per `parse_required_str(args, "content")` — same as `save_working`); `parse_target` reads `args.target` (singular) — the route must send `target`, not `targets`.
- **Validation (`cargo test --workspace`):** against a temp library scaffolded with `allowed_targets: [Claude, Pi]` —
  - `write_overlay(Claude, body)` → `list_overlays` shows Claude with `["SKILL.md"]`; `read_primitive_target(Claude)` returns `has_overlay: true` and the overlay body (the **merge** is exercised end-to-end through the bridge — satisfies "merge output matches reference golden" via the in-tree `overlay_merge` goldens + this integration assertion).
  - `read_primitive_target(Pi)` with no Pi overlay → `has_overlay: false`, body = base.
  - `read_primitive_target(Codex)` (not in `allowed_targets`) → `library_target_not_allowed`.
  - `write_overlay` with malformed md → `library_parse_error`, **disk unchanged** (the overlay file is not created — assert `list_overlays` still empty).
  - `remove_overlay(Claude)` → `list_overlays` drops Claude; `read_primitive_target(Claude)` → `has_overlay: false`, body back to base. Re-`remove_overlay` (idempotent) → still `Ok`.

### Phase 2 — TS: routes, models, status mapping

- **Objective:** Expose the four commands as HTTP routes with the working-file write-safety + error-mapping discipline.
- **Changes:**
  1. `library_models.ts`: add `TargetView { working: WorkingContent; has_overlay: boolean }` + `parseTargetView`; `OverlayList { target: TargetName; paths: string[] }` + `parseOverlayList` (+ `parseOverlayLists` for the array). Mirror the `parsePrimitiveVersionView` validator shape.
  2. `library_routes.ts`: `buildReadPrimitiveTarget` (read — `parseTargetView`, default timeout, no lock), `buildWriteOverlay` (`PUT`, body `{ content }`, `WRITE_TIMEOUT_MS`, no `withWriteLock`, 200 `{}`), `buildRemoveOverlay` (`DELETE`, `WRITE_TIMEOUT_MS`, no lock, 200 `{}`), `buildListOverlays` (read — `parseOverlayLists`). The bridge args: `{ path, kind, name, target, content? }`.
  3. `statusForCode`: **no new arm** (verified — `library_target_not_allowed`→422, `library_parse_error`→502-via-default? — confirm: `library_parse_error` is in the `library_parse_error` family; check it maps as intended — it falls to the 502 default today, which is correct for an unreadable file, but a **parse-on-write** failure is a 422-class user error. **Action item:** verify whether `library_parse_error` on a write should be 422; if the working-file editor already treats it as a user-facing inline error (it does — `WorkingFileEditor.svelte:122`), confirm the status is acceptable as-is and do NOT silently change a shared code's status without checking the Slice 3 routes that depend on it.)
  4. Route registration (`library_routes.ts:644+`): `GET …/targets/:target`, `PUT …/targets/:target/overlay`, `DELETE …/targets/:target/overlay`, `GET …/overlays`. Mount after `/working-files*` and `/versions*`.
- **Affected:** `scripts/library_models.ts`, `scripts/library_routes.ts`, route registration, `scripts/library_models.test.ts`, `scripts/library_routes.test.ts`.
- **Risks:** the `library_parse_error` status question above; forgetting the Origin guard on the new `PUT`/`DELETE` (extend the existing guard test); the `:target` segment validation rides the bridge's `parse_target` (a bad `:target` → `library_invalid_target` → 422) — assert it.
- **Validation (`bun test scripts`):** model parsers (valid + malformed `TargetView`/`OverlayList`); route mapping for all four; `read …/targets/:target` for a disallowed target → 422 `library_target_not_allowed`; a bad `:target` value → 422 `library_invalid_target`; write/remove skip the lock but take `WRITE_TIMEOUT_MS`; a write `PUT` without the Origin header is rejected (extend the existing guard test); **route-local failure assertion** — a failed overlay op leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.

### Phase 3 — UI: target-aware editor + merged preview + drift explanation

- **Objective:** Make the editor target-aware — a per-`allowed_target` overlay tab showing the merged primary, with Add/Edit/Remove overlay actions, colorblind-safe "delta vs. base" cues, the post-edit drift explanation, and no `useEffect`.
- **Changes:**
  1. `ui/src/lib/api.ts`: add `readPrimitiveTarget`, `writeOverlay`, `removeOverlay`, `listOverlays` fetchers + `LibraryTargetView`/`LibraryOverlayList` interfaces (follow the working-file fetcher shape, `:620-645`).
  2. `ui/src/lib/library.ts`: add `overlayCue(hasOverlay)` → `hasOverlay ? { label: "overlay", tone: "cyan", glyph: "◆" } : { label: "base (no overlay)", tone: "default", glyph: "○" }` (cyan is CVD-safe; never red/green) so "this target carries a delta" is a label+glyph, not a color. Unit-test distinguishability without color.
  3. `WorkingFileEditor.svelte` (or a sibling `TargetOverlayPane.svelte` — **prefer extending the existing component** with a target dimension to reuse the buffer/baseline/poll-safety machinery, but a sibling is acceptable if the target buffer state would tangle the base buffer): add a target tab strip driven by `detail.metadata.allowed_targets`. Selecting a target:
     - fetches `readPrimitiveTarget(kind, name, target)` → shows the **merged primary** (read-through). The buffer for an overlay tab is plain `$state`, hydrated by the fetch event handler (the same W5 poll-safety pattern — never bind the textarea to a `resource()` that the poll refetches).
     - `has_overlay: false` → render read-only + an **"Add overlay for <target>"** button (seeds the overlay editor from the merged/base bytes, then `writeOverlay`).
     - `has_overlay: true` → editable; **Save** → `writeOverlay`; **Remove overlay** (destructive-adjacent — discards the delta) → inline confirm → `removeOverlay`, then re-fetch the target view (reverts to base passthrough).
     - after any overlay write/remove, `.reload()` the detail resource + the overlays list (event-handler-driven, no effect) so the tab cues and `list_overlays` refresh.
  4. Overlay tabs show `overlayCue` (delta vs. base) per target; the base tab keeps the Slice 3 `editorDirtyCue`.
  5. **Drift explanation (Decision 3):** if the edited target has an existing install record (already in `targetRows`, `Library.svelte:147-155`), render an inline amber note next to that target's install row after a successful overlay write — "won't reach the installed copy until you reinstall; it'll show as drifted" — cross-linking the existing reinstall action. No new drift wiring; reuse the drift cue vocabulary.
  6. Per-action pending lock (the Slice 3 W7 / install-slice D2 captured-intent pattern) so a double-click can't double-submit; **no `useEffect`** anywhere (reload is `.reload()` in the success handler).
- **Affected:** `ui/src/lib/api.ts`, `ui/src/lib/library.ts`, `ui/src/lib/library.test.ts`, `ui/src/lib/components/WorkingFileEditor.svelte` (or a new sibling) + its `.svelte.test.ts`, `ui/src/routes/Library.svelte` (+ `Library.svelte.test.ts`).
- **Risks:** (a) **buffer tangle** — a target tab's buffer must not clobber the base buffer; keep them separate `$state` (or remount the pane on target change via a `{#key target}` block — the cheapest no-`useEffect` reset, matching how the editor already keys on primitive). (b) the "Add overlay" seed must use the **current base bytes** so the author edits a delta, not a blank primary that would parse-fail or wipe content. (c) only `allowed_targets` tabs — a primitive with empty `allowed_targets` shows no overlay tabs (assert the empty-state). (d) the merged preview is **read-through for the base file under a target with an overlay** — for the primary, the overlay shadows base entirely, so "merged primary" == "overlay bytes"; the preview is honest about showing the effective installed bytes.
- **Validation (`*.svelte.test.ts` + `library.test.ts`):** a target with no overlay shows read-only + "Add overlay"; adding seeds from base, saves, flips to editable with the overlay cue; editing+save round-trips; "Remove overlay" confirms then reverts the tab to base passthrough; only `allowed_targets` render tabs (a disallowed target is absent, never a 422-toast); the overlay cue distinguishes delta vs. base **without color**; after an overlay edit on an installed target, the drift-explanation note renders next to that install row; pending-lock blocks double-submit; the base editor buffer is unaffected by target-tab switches.

## Acceptance criteria

- [x] The bridge serves `read_primitive_target`, `write_overlay`, `remove_overlay`, `list_overlays` — all sync, no commit — reusing the existing parse helpers and `map_core_error` (no new error arm; `TargetNotAllowed` already mapped).
- [x] `read_primitive_target` returns `{ working: WorkingContent, has_overlay }`; the merged primary is exercised end-to-end through `overlay_merge::merge` (the in-tree golden tests at `overlay_merge.rs:46-87` plus the Phase-1 integration round-trip satisfy "merge matches reference golden").
- [x] `write_overlay` parse-validates before writing (malformed → `library_parse_error`, disk unchanged); `remove_overlay` is idempotent; both write only `working/targets/<target>/<primary>` and **do not commit**.
- [x] A disallowed target (`∉ allowed_targets`) → `library_target_not_allowed` (422); the UI never offers an overlay tab for it (tabs driven by `allowed_targets`, not `Target::ALL`).
- [x] The overlay UI makes "overlay delta vs. base passthrough" unmistakable via a colorblind-safe cue (label + glyph + CVD-safe cyan, never bare red/green), with distinct Add / Edit / Remove affordances and a per-target `loadTarget` reseed (separate-`$state` buffer) — no `useEffect`.
- [x] After an overlay write on an installed target, the UI explains the resulting drift ("won't reach the installed copy until you reinstall") inline, cross-linking the existing reinstall (Update) action — drift detection itself is unchanged (Decision 3).
- [x] **Route-local failure:** a failed overlay op leaves `/api/summary`, `/api/agents`, `/healthz`, and doctor at 200.
- [x] **Secrets-free + network-free invariant intact:** the bridge still does NOT link `prompt-library-secrets`; no network call; the "no `SecretStore` constructed" assertion still passes; no new bridge dependency.

## Dependencies and risks

- **Depends on:** Slice 3 (the `WorkingFileEditor` + `WorkingContent` model the overlay editor extends; the merged primary decodes to the same `WorkingContent` union). Conceptually version-adjacent to Slice 4 but **independently shippable** — no versioning seam is required.
- **Forward dependency (note, don't resolve):** Slice 6 (metadata editing) changes `allowed_targets`, which changes which overlay tabs appear. No coupling to build now, but the two slices share the `allowed_targets` source-of-truth.
- **Risk — primary-only overlay scope:** the reference exposes write/remove for the **primary** overlay only; per-ref overlay editing has no reference command and is out of scope (Decision 1). Don't let the UI imply ref overlays are editable.
- **Risk — `library_parse_error` write status:** confirm the parse-on-write status is acceptable (the working-file editor already surfaces it inline — Slice 3); do not change a shared code's status without checking the Slice 3 routes (Phase 2 action item).
- **Risk — buffer tangle in a shared editor component:** keep the target-overlay buffer separate from the base buffer (separate `$state` or `{#key target}` remount) so the W5 poll-safety guarantee holds per layer.
- **Risk — drift-explanation is copy, not logic:** the deliverable is the explanatory note + cross-link, not new drift wiring; resist re-implementing drift detection.

## References

- Reference commands: `prompt-library/src-tauri/src/commands.rs` — `read_primitive_target:536`, `write_overlay:556`, `remove_overlay:576`, `list_overlays:594`
- Core (dashboard, present + tested): `crates/core/src/detail.rs:118` (`TargetView`), `:129` (`read_primitive_for_target`, rejects disallowed target at `:550` test), `:183` (`OverlayList`), `:190` (`list_overlays`); `crates/core/src/working_copy.rs:80` (`save_primary_target`), `:93` (`remove_primary_target`); `crates/core/src/overlay_merge.rs:11` (`merge`, goldens `:46-87`); `crates/core/src/materializer.rs:36` (`materialize`, `TargetNotAllowed` at `:43`)
- Bridge seam: `crates/prompt-library-bridge/src/main.rs` — dispatch `:103-145`, working-file command bodies `:508-627` (the template), `parse_target:817`, `parse_required_str:828`, `map_core_error:1017` (`TargetNotAllowed` already mapped `:1042`), `Cargo.toml:12-14` secrets-free comment
- TS seams: `scripts/library_routes.ts` — working-file builders `:413-514`, version builders `:550-633`, `statusForCode:73` (`library_target_not_allowed`→422 at `:102`), registration `:644-758`; `scripts/library_models.ts:46` (`WorkingContent`), `:112` (`PrimitiveVersionView` parser shape to mirror)
- UI seams: `ui/src/lib/components/WorkingFileEditor.svelte` (per-primitive editor to extend), `ui/src/routes/Library.svelte:147-155` (`targetRows` from `allowed_targets`), `:665` (`.doc-tabs`); `ui/src/lib/library.ts:73-113` (`Cue` vocabulary); `ui/src/lib/api.ts:620-699` (fetcher shape)
- Roadmap: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` (Slice 5)
- Shipped slice plans (patterns extended): `docs/plans/2026-06-11-feat-prompt-library-working-copy-editor-slice-plan.md` (Slice 3), `docs/plans/2026-06-12-feat-prompt-library-versioning-publishing-slice-plan.md` (Slice 4)

## Next step

The plan is detailed enough to execute — the core is already in-tree and tested, `map_core_error` already covers the one new error, and Slices 3/4 built every seam this extends. Recommended: `/workflows:work docs/plans/2026-06-12-feat-prompt-library-target-overlays-slice-plan.md`, starting Phase 1 (bridge). The one item worth confirming before Phase 2 code is the `library_parse_error`-on-write status question (Phase 2, item 3) — a 2-minute check of how the Slice 3 working-file routes already treat it, so the overlay routes stay consistent.
