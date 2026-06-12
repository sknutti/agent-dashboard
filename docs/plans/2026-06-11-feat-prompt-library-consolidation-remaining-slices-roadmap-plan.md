# Prompt Library Consolidation — Remaining Slices Roadmap — Implementation Plan

- **Date:** 2026-06-11
- **Type:** feat
- **ADR:** [docs/adr/0007-prompt-library-rust-command-bridge.md](../adr/0007-prompt-library-rust-command-bridge.md) (consolidation track) + [docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md](../adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md) (install-state ownership). This is a **roadmap**, not a single-slice plan: each slice below earns its own deepened plan doc before implementation.
- **Track doc:** [docs/library-consolidation-track.md](../library-consolidation-track.md) — "Full consolidation, staged."
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Library layer · Primitive · Kind · Target · Working copy · Version · Overlay · Install record · Drift · Reimport · Bootstrap
- **Builds on (shipped):** [read-only slice](2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md) (PR #4) and [install/drift write-flow slice](2026-06-11-feat-prompt-library-install-drift-slice-plan.md) (PR #5). Every seam those created — the bridge dispatch + envelope, `library_bridge.ts`/`library_models.ts`/`library_config.ts`/`library_routes.ts`, the `resource()` UI pattern, the Variant B Library route — is **extended, not rebuilt**, by every slice below.
- **Reference repo:** `~/side_projects/playground/prompt-library` — the standalone Tauri app is the reference implementation for every remaining feature; `src-tauri/src/commands.rs` holds the command bodies to port (minus `AppHandle`/`State`), and `crates/{core,git,secrets}` are already imported into this repo under `crates/`.

## Purpose of this document

The first two slices closed the **read** loop and the **install/drift** loop. What remains is everything that turns the Library route from a deploy console into the **authoring + sync** surface the standalone app is: editing working copies, cutting and publishing versions, per-target overlays, metadata editing, the primitive lifecycle (create/delete/rename/duplicate/import), search, reimport-from-drift, full git remote sync (the first network + secrets-bearing slice), the bootstrap discovery wizard, and the native-affordance gaps a localhost web app must redesign rather than port.

This document sequences that work into **independently shippable vertical slices**, states the **dependency order** between them, and for each slice names the reference commands to port, the new bridge/route/UI seams, the load-bearing risks, and the gate. It deliberately stops short of per-slice deepening: the established pattern (read-only, install/drift) is that each slice gets its own plan doc deepened by parallel source-reading agents before a line is written. This roadmap is the **map and the ordering rationale**, so a future reader (or `/workflows:plan` on a single slice) starts grounded instead of re-deriving the whole consolidation shape.

## Repository facts (verified at source, 2026-06-11)

### What is already imported and wired

- The crates are **already in this repo**: `crates/core`, `crates/git`, `crates/secrets`, `crates/prompt-library-bridge` (root Cargo workspace, per ADR-0007). No further crate import is needed for any slice below.
- The bridge dispatch (`crates/prompt-library-bridge/src/main.rs:103-117`) currently serves **12 commands**: read (`library_status`, `kind_info`, `target_info`, `list_primitives`, `primitive_detail`) and install/drift (`install`, `uninstall`, `scan_drift`, `scan_drift_batch`, `acknowledge_drift`, `list_installs_for_primitive`, `import_installs`). Every slice below adds dispatch arms here.
- The bridge **links `prompt-library-git`** (`crates/prompt-library-bridge/Cargo.toml:20`) but **deliberately does NOT link `prompt-library-secrets`** (`Cargo.toml:12-14`): a `SecretStore` is **unconstructible at compile time** today. That invariant is load-bearing and is broken *on purpose, once* by the git-remote-sync slice — see Slice 8.
- The TS seams are all present and tested: `scripts/library_{bridge,models,config,migration,routes}.ts` (+ `.test.ts` for each), `scripts/paths.ts` (`DATA_DIR`, `LIBRARY_INSTALLS_PATH`, `LIBRARY_HOME`), `scripts/server.ts:63-101` (Host allowlist + Origin guard on all writes).
- The UI seams: `ui/src/routes/Library.svelte` (35 KB, Variant B), `ui/src/lib/library.ts` (colorblind-safe `Cue` helpers, `library.test.ts`), `ui/src/lib/api.ts` (read + install/drift fetchers), `ui/src/lib/resource.svelte.ts` (`dataEpoch`/30s-poll auto-refetch).

### The remaining reference Tauri commands (the work, enumerated)

`prompt-library/src-tauri/src/commands.rs` exposes these beyond the 12 already ported. Each maps to a slice below:

- **Working copy / editor:** `save_working` (`:349`), `list_working_files` (`:610`), `read_working_file` (`:626`), `create_working_file` (`:645`), `save_working_file` (`:666`), `rename_working_file` (`:686`), `delete_working_file` (`:708`). Core surface: `crates/core/src/working_files.rs:62-193` (`read`/`create`/`save`/`rename`/`delete`/`list_working_file`, plus `validate_path_shape`/`validate_ref_path` containment guards at `:293,:329`).
- **Versioning / publishing:** `publish` (`:366`), `set_current_version` (`:466`), `read_primitive_version` (`:498`), `revert_to_version` (`:516`). Core: `crates/core/src/version_store.rs` (`VersionStore::{snapshot,read_current,set_current,list_versions,read_version,read_version_metadata}` at `:38-185`). Publish also commits via the git crate (`commit_publish`, `commands.rs:453`).
- **Target overlays:** `read_primitive_target` (`:536`), `write_overlay` (`:556`), `remove_overlay` (`:576`), `list_overlays` (`:594`). Core: `crates/core/src/overlay_merge.rs:11` (`merge(overlay, target)`).
- **Metadata editing:** `update_metadata` (`:755`). Core: `crates/core/src/metadata.rs:58` (`update_primitive_metadata`).
- **Primitive lifecycle:** `create_primitive` (`:282`), `delete_primitive` (`:1057`), `rename_primitive` (`:1099`), `duplicate_primitive` (`:1181`), `import_primitive_from_path` (`:1143`), `forget_primitive` (`:1036`). Core: `scaffold.rs:30,70`, `rename.rs:36`, `import_path.rs:39`, plus delete/duplicate/forget bodies in `commands.rs`.
- **Search:** `find_in_library` (`:1274`). Core: `crates/core/src/find.rs:37`.
- **Reimport-from-drift:** `reimport_install` (`:1303`). Core: `crates/core/src/reimport.rs:89` (`reimport_install_as_version`).
- **Git remote sync:** `configure_remote` (`:1596`), `set_pat`/`delete_pat` (`:1609,:1619`), `get_remote_status` (`:1626`), `scan_before_push` (`:1695`), `count_unpushed_commits` (`:1724`), `push_now` (`:1761`), `pull_now` (`:1801`), conflict flow `is_pull_paused`/`list_pull_conflicts`/`read_conflict_blob`/`resolve_conflict`/`continue_pull`/`abort_pull`/`reveal_conflict_path` (`:1919-2041`). Crates: `git/src/git_ops.rs` (`git_push`/`git_pull`/`current_branch`/…), `git/src/conflict.rs` (`list_unmerged_paths`/`read_conflict_side`/`resolve_with_side`/`rebase_continue`/`rebase_abort`), `git/src/{secret_scan,push_gate,askpass}.rs`, and `secrets/src/keychain.rs` (`KeychainStore::{set_pat,get_pat,delete_pat}`).
- **Bootstrap discovery wizard:** `bootstrap_scan` (`:1492`), `bootstrap_execute` (`:1517`), `read_bootstrap_session`/`clear_bootstrap_session` (`:1564,:1575`). Core: `crates/core/src/{bootstrap.rs,bootstrap_scan.rs,bootstrap_session.rs}` — `bootstrap_scan` is **progress-streaming** (`FnMut(ScanProgress)`, `bootstrap_scan.rs:31`); `derive_plan`/`bootstrap_execute` at `bootstrap.rs:59,149`.
- **Native affordances (no clean web port):** `pick_library_path` (native folder picker, `:167`), `reveal_working_file_path`/`reveal_install_path`/`reveal_conflict_path` (Finder reveal, `:730,:1342,:2041`), `is_install_path`/`is_library_in_icloud`/`update_recents_menu` (`:1378,:1019,:1230`), `fetch_primitive_from_url`/`url_import.rs` (network fetch — gated behind the same secrets/network posture as git sync). These need a **web redesign**, not a port — see Slice 10.

### Invariants that constrain the ordering

- **Network-free + secrets-free** is the bridge's current posture (read + install slices). It is broken **exactly once and on purpose** — by git remote sync (Slice 8), which is the first slice to construct a `reqwest`/git-network call and a `KeychainStore`. Everything that does **not** need the network (Slices 3-7, 9) is sequenced **before** Slice 8 so the secrets blast radius is introduced as late and as isolated as possible.
- **All Library writes go through the Rust core** (ADR-0007): no TS-side file mutation. Every slice's write path is a bridge command wrapping a core/git function.
- **Route-level write mutex + atomic-write** safety (established in the install slice, D1/D3/D4): every new write command inherits the serialize-at-the-route pattern and the larger write timeout + `SIGKILL`. Versioning/publish/git introduce **multi-file, multi-step** writes (a publish is snapshot + set-current + commit), raising the stakes — each such slice must state its atomicity story explicitly, as the install slice did.

## Slice dependency graph

```
[shipped] read-only (#4) ──> [shipped] install/drift (#5)
                                  │
   ┌──────────────────────────────┴───────────────────────────────┐
   │ AUTHORING (network-free, secrets-free — same invariants as #5)│
   │                                                                │
   3. Working copy / editor ──> 4. Versioning / publishing         │
   │         │                        │                            │
   │         │                        ├──> 5. Target overlays       │
   │         └──> 6. Metadata editing │                            │
   │                                  └──> 7. Reimport-from-drift   │
   │   (independent, parallelizable: ) 9. Search                    │
   │   (independent, parallelizable: ) L. Primitive lifecycle*      │
   └────────────────────────────────────────────────────────────────┘
                                  │
   ┌──────────────────────────────┴───────────────────────────────┐
   │ NETWORK + SECRETS (breaks the secrets-free invariant, once)   │
   │   8. Git remote sync (PAT + secrets crate + conflict flow)    │
   │   10b. URL import (rides Slice 8's network posture)           │
   └────────────────────────────────────────────────────────────────┘

   Cross-cutting, land alongside the slices that surface them:
   10a. Native-affordance web redesigns (folder picker, reveal, recents)
   2.  Bootstrap discovery wizard (depends on lifecycle + reimport)
```

`*` Lifecycle (create/delete/rename/duplicate/import-from-path) is foundationally independent of the editor but **deeply entangled with git** (every lifecycle op the reference commits; delete/rename touch versions + installs). It is sequenced as an authoring slice but flagged: its commit/uncommit story must align with Slice 4's publish-commit decision, so **Slice 4 lands before Lifecycle's git-commit half**.

---

## Slice 3: Working copy / editor

- **Objective:** Make the Library route's central pane an **editor**, not a viewer. Read, create, save, rename, and delete working-copy files for the selected Primitive, through the Rust core.
- **Why first among authoring:** Every other authoring slice (versioning, overlays, metadata, lifecycle) edits or snapshots the working copy. The editor is the substrate; nothing downstream is testable end-to-end without it. It is also entirely **network-free + secrets-free**, so it ships under the exact invariants the install slice already proved.
- **Reference to port:** `save_working` (`commands.rs:349`), `list_working_files` (`:610`), `read_working_file` (`:626`), `create_working_file` (`:645`), `save_working_file` (`:666`), `rename_working_file` (`:686`), `delete_working_file` (`:708`). Core: `working_files.rs:62-193`, with the **containment guards** `validate_path_shape` (`:293`) and `validate_ref_path` (`:329`) — these are the security boundary and must be a tested tripwire (a `../` working-file path is rejected in-core, never reaches the fs).
- **New seams:**
  - Bridge dispatch arms: `read_working_file`, `list_working_files`, `create_working_file`, `save_working_file`, `rename_working_file`, `delete_working_file` (port bodies; resolve the library root from config, not `AppHandle`).
  - `library_models.ts`: `WorkingFile`/`WorkingFileContent` interfaces + parsers.
  - `library_routes.ts`: `GET …/working-files`, `GET …/working-files/:path`, `POST`/`PUT`/`DELETE`/rename routes — all acquiring the **write mutex** (Slice-#5 D1 pattern) for the mutating verbs; reads skip it.
  - `Library.svelte`: a working-files tree + editable file pane (textarea-first; no rich editor this slice), dirty-state cue (reuse `dirtyCue`), save/rename/delete actions with the per-row pending-write lock pattern (#5 D2).
- **Risks:** (a) **path-traversal via file paths** — the highest-consequence new attack surface; mitigated by `validate_ref_path` in-core + a route tripwire test. (b) **Lost edits across the 30s poll** — an open editor must not be clobbered by a background refetch; the editor's local buffer is the source of truth until save (do not bind the textarea directly to `resource()` data). (c) `dirty` recomputation: saving a working file changes the Primitive's `dirty` flag — reload the detail resource after a write.
- **Gate:** `cargo test --workspace` (working-files round-trip + traversal-rejection against a temp library); `bun test scripts` (model parsers + route mapping + mutex on writes); `*.svelte.test.ts` (edit→save→dirty-clear, traversal name rejected at 422, editor buffer survives a poll tick).

---

## Slice 4: Versioning / publishing

- **Objective:** Cut a new **Version** from the working copy (snapshot), set the current version, read a historical version, and **publish** (snapshot + set-current + git commit). This is the first slice whose single user action is a **multi-step, multi-file Rust write**.
- **Depends on:** Slice 3 (publish snapshots the working copy the editor produces).
- **Reference to port:** `publish` (`commands.rs:366`, incl. `format_publish_commit_message:404` and `commit_publish:453`), `set_current_version` (`:466`), `read_primitive_version` (`:498`), `revert_to_version` (`:516`). Core: `version_store.rs` — `VersionStore::{snapshot,read_current,set_current,list_versions,read_version,read_version_metadata}` (`:38-185`).
- **New seams:** bridge arms `publish`/`set_current_version`/`read_primitive_version`/`revert_to_version`; `Version`/`PublishResult` models; routes (all mutating → write mutex); `Library.svelte` version list + publish/revert/set-current actions + a version picker in detail.
- **Decisions to settle in the slice's own plan (flagged, not decided here):**
  - **Publish atomicity.** Publish = snapshot files **then** `git commit`. A snapshot that succeeds but a commit that fails leaves an uncommitted new version (recoverable: re-publish or commit-on-next). State this explicitly the way #5 stated install-not-atomic-across-targets (D3); add a kill-mid-publish test. **This is also the decision Lifecycle (below) waits on** — the repo's commit-on-write posture is settled here.
  - **`revert_to_version` was explicitly deferred by the install slice** ("Install always deploys the current pinned version; `revert_to_version` is absent"). It returns here as a **library-content** operation (set the working copy / current pointer to an old version) — distinct from re-installing; the slice plan must keep that distinction crisp so a reviewer doesn't read it as a re-introduction of install-time version pinning.
  - **Commit identity / git config.** Publish commits as whoever the repo's git is configured as; the dashboard runs headless. Confirm the commit author story (reference uses the repo's git config) and that a repo with no `user.email` fails legibly, not silently.
- **Risks:** partial publish (above); a publish that commits secrets — **note:** the reference's secret-scan/push-gate runs at **push**, not commit, so a published-but-not-pushed secret is possible. That is acceptable (matches reference) but should be stated, since Slice 8 is where the push gate lands.
- **Gate:** `cargo test` (snapshot→list→read→set-current→revert round-trip; commit lands; kill-mid-publish leaves a recoverable state); route + UI tests for publish/revert/version-pick.

---

## Slice 5: Target overlays

- **Objective:** Read, write, list, and remove **per-target overlay** bytes — the Target-specific deltas merged over the base working copy at install time.
- **Depends on:** Slice 3 (overlays layer over working-copy files); ideally lands after Slice 4 (overlays are conceptually a version-adjacent authoring concern), but is **independently shippable** once the editor exists.
- **Reference to port:** `read_primitive_target` (`commands.rs:536`), `write_overlay` (`:556`), `remove_overlay` (`:576`), `list_overlays` (`:594`). Core: `overlay_merge.rs:11` (`merge(overlay, target)`).
- **New seams:** bridge arms; `Overlay`/`MergedTarget` models; routes (writes → mutex); `Library.svelte` per-Target overlay editor + a **merged preview** (base + overlay) so the author sees what installs.
- **Risks:** (a) overlay/base divergence confusion — the UI must make "this is an overlay delta, not the full file" unmistakable (colorblind-safe cue, not color alone). (b) **Install-path interaction:** an overlay change does not re-install; it just changes what a *future* install/reinstall deploys → existing installs read as **drift** after an overlay edit (correct, but must be explained, not surprising). (c) Targets are the closed `{Claude,Pi,Codex}` enum (no Antigravity overlay — ADR-0007).
- **Gate:** `cargo test` (write→list→merge→remove; merge output matches reference golden); UI test (overlay edit shows merged preview; post-edit drift is explained).

---

## Slice 6: Metadata editing

- **Objective:** Edit a Primitive's metadata (description, allowed targets, author, kind-specific fields) through `update_primitive_metadata`, with the same validation the reference enforces.
- **Depends on:** Slice 3 (metadata lives alongside the working copy; the detail resource is the read seam from the read-only slice).
- **Reference to port:** `update_metadata` (`commands.rs:755`). Core: `metadata.rs:58` (`update_primitive_metadata`) — note `metadata.rs` is 29 KB of validation; the slice's value is **surfacing those validation errors as typed route codes**, not reimplementing them.
- **New seams:** bridge arm `update_metadata`; a `MetadataPatch` input model + the validation-error code mapping; route (write → mutex); a metadata form in `Library.svelte` detail.
- **Risks:** (a) **changing `allowed_targets` is destructive-adjacent** — narrowing allowed targets while a Primitive is installed to a now-disallowed target creates an orphaned install; mirror the reference's behavior and surface it (don't silently strip). (b) Rich validation surface → many error variants; promote the user-actionable ones out of any catch-all (the #5 `map_core_error` pattern). (c) `dirty`/detail reload after a metadata write.
- **Gate:** `cargo test` (valid patch applies; each validation failure → its variant); route tests for the code mapping; UI form test (invalid input shows the field error, never a generic toast).

---

## Slice L: Primitive lifecycle (create / delete / rename / duplicate / import-from-path / forget)

- **Objective:** Create a new Primitive (scaffold), delete, rename, duplicate, import from a local folder, and "forget" — the structural CRUD over the Library that the explorer's "+"/context actions drive.
- **Sequencing note:** foundationally independent of the editor, but **every op the reference commits to git**, and delete/rename interact with versions **and** installs (deleting a Primitive that is installed; renaming one with install records). So: the **non-committing, install-aware half** can land early in parallel with Slices 3-6, but the **git-commit half must follow Slice 4** (which settles the commit-on-write posture). Treat this as one slice with an explicit "commit story per Slice 4" dependency, or split it.
- **Reference to port:** `create_primitive` (`commands.rs:282`), `delete_primitive` (`:1057`), `rename_primitive` (`:1099`), `duplicate_primitive` (`:1181`), `import_primitive_from_path` (`:1143`), `forget_primitive` (`:1036`). Core: `scaffold.rs:30,70`, `rename.rs:36`, `import_path.rs:39`.
- **New seams:** bridge arms for each; lifecycle input/result models; routes (all writes → mutex, **`POST`/`DELETE`/`PATCH`**); explorer-level create/duplicate/rename/delete affordances + confirm dialogs (delete is the most destructive non-git action in the whole consolidation — two-phase confirm, list what's installed/versioned, colorblind-safe).
- **Risks:** (a) **delete-with-installs / rename-with-installs:** the install records are keyed `(kind,name,target)` — a rename must migrate or invalidate them; the reference's behavior is the spec, port it faithfully and test it. (b) **import-from-path traversal + format validation** (same family as the migration importer's `format_version` guard). (c) **partial create** (scaffold writes multiple files then commits) — same atomicity story as publish (Slice 4 dependency). (d) name collisions / `PrimitiveName` validation at the boundary (already a tested invariant from the read slice — M3).
- **Gate:** `cargo test` (each op round-trips; rename migrates install records; delete-with-installs behaves per reference; traversal rejected on import); route + UI tests (delete two-phase confirm shows installs/versions; no op fires before confirm).

---

## Slice 7: Reimport-from-drift

- **Objective:** When an installed Primitive has **drifted** (modified on disk outside the Library), pull those on-disk edits **back into the Library as a new Version** — the inverse of install, closing the round-trip the install/drift slice opened.
- **Depends on:** Slice 4 (reimport *is* a version snapshot of foreign bytes) and the shipped drift slice (it operates on a drifted install record).
- **Reference to port:** `reimport_install` (`commands.rs:1303`). Core: `reimport.rs:89` (`reimport_install_as_version`).
- **New seams:** bridge arm `reimport_install`; a `ReimportResult` model; route (write → mutex); in the **drift detail** (built by #5), a "Reimport these edits" action on a `Modified` drift row, sitting beside the existing "Acknowledge"/"Reinstall" actions.
- **Risks:** (a) **semantic clarity** — three actions now sit on a drifted row: Acknowledge (adopt on-disk as the install baseline, Library unchanged), Reinstall (overwrite disk with Library, force), **Reimport (pull disk into Library as a new version)**. These are easy to confuse and one is destructive to the Library, one to the disk. The UI copy is the deliverable as much as the wiring; each needs a distinct, unambiguous label + the drift slice's colorblind cue vocabulary. (b) reimport of a `Missing` drift is nonsensical — offer it only on `Modified`.
- **Gate:** `cargo test` (drifted install → reimport → new version contains the on-disk bytes; install record re-baselined); UI test (Reimport offered only on `Modified`; the three drift actions are distinguishable by label, not color).

---

## Slice 9: Search

- **Objective:** Search across the Library (Primitive names, content) via `find_in_library`, powering an explorer search box.
- **Depends on:** only the read-only slice — **fully independent**, parallelizable with any authoring slice. A good "palate-cleanser" slice to interleave.
- **Reference to port:** `find_in_library` (`commands.rs:1274`). Core: `find.rs:37`.
- **New seams:** bridge arm `find_in_library`; a `SearchResult` model; `GET …/search?q=` route (read → no mutex); a search input + result list in the explorer.
- **Risks:** (a) **cost on large libraries** — content search hashes/reads files; the #5 batch-drift cost discipline applies (one spawn, measure with a fixture corpus, debounce client-side). Likely fine for ~120 primitives but flag the bench. (b) result→detail navigation reuses the existing selection state.
- **Gate:** `cargo test` (find returns expected hits over a fixture library); route test; UI test (debounced query, empty-state, result click selects the Primitive).

---

## Slice 8: Git remote sync (push / pull / conflict / PAT + secrets crate)

- **Objective:** The full mutating git story: configure a remote, store a PAT, see remote status + unpushed count, **push** (with the secret-scan push gate), **pull** (with rebase + the conflict-resolution flow). This is the **largest, riskiest, and most isolated** slice.
- **THE invariant break:** this is the **first and only** slice to (a) make a **network** call and (b) link **`prompt-library-secrets`** and construct a `KeychainStore`. The bridge's `Cargo.toml:12-14` comment ("the bridge deliberately does NOT depend on prompt-library-secrets") is amended **here, deliberately, with an ADR note**, exactly as #5 amended the install-state ADR. Sequenced **last among feature slices** so every network-free capability ships first and the secrets/network blast radius is introduced once, isolated, and heavily reviewed.
- **Reference to port:** `configure_remote` (`:1596`), `set_pat`/`delete_pat` (`:1609,:1619`), `get_remote_status` (`:1626`), `scan_before_push` (`:1695`), `count_unpushed_commits` (`:1724`), `push_now` (`:1761`), `pull_now` (`:1801`); conflict flow `is_pull_paused`/`list_pull_conflicts`/`read_conflict_blob`/`resolve_conflict`/`continue_pull`/`abort_pull` (`:1919-2025`). Crates already present: `git/src/git_ops.rs` (`git_push`/`git_pull`/`current_branch`/`remote_branch_exists`/…), `git/src/conflict.rs` (`list_unmerged_paths`/`read_conflict_side`/`resolve_with_side`/`rebase_continue`/`rebase_abort`), `git/src/push_gate.rs` (`scan_pending_push`/`scan_for_push`), `git/src/secret_scan.rs` (`scan`), `git/src/askpass.rs` (`init_askpass_script` — the PAT injection mechanism), `secrets/src/keychain.rs` (`KeychainStore::{set_pat,get_pat,delete_pat}`).
- **New seams:** add `prompt-library-secrets` to the bridge `Cargo.toml`; bridge arms for the full command set; **secrets handling in the TS layer** — the PAT must never be logged (the `errorResult` never-forward-`detail` rule extends to never-log-secret), and `redact_pat` (`secrets/src/lib.rs:60`) is the display form; routes (the network ones likely need a **longer timeout** than even the write timeout, and push/pull are serialized against each other); a git-sync panel in `Library.svelte` (remote status, push/pull buttons, unpushed count, a conflict-resolution sub-view).
- **Decisions to settle in the slice's own plan (do NOT decide here):**
  - **PAT storage location** in a headless localhost app: macOS Keychain via `KeychainStore` (reference) vs. a config-dir secret. The reference uses Keychain; confirm that works headless under the dashboard's process and survives the process-per-request bridge (a fresh process re-reads the keychain each call — likely fine, verify).
  - **Askpass under process-per-request:** `init_askpass_script` writes a helper the git child invokes to fetch the PAT; confirm the one-shot bridge model supports that handshake (the reference is a long-lived Tauri process).
  - **Push gate posture:** secret-scan **blocks** push on a finding (reference). Surface the findings legibly; never auto-bypass.
  - **Pull = rebase + conflict pause:** pull can leave the repo mid-rebase awaiting conflict resolution — this is **stateful across multiple HTTP requests** (pause → list → resolve → continue/abort), unlike every other command which is one-shot. The slice plan must design that multi-request stateful flow against a process-per-request bridge (the rebase state lives in the repo's `.git`, not in a process — likely the saving grace, verify).
  - **Origin/network guard:** these are the only routes that egress; reconfirm the `server.ts` guard posture and whether any new outbound allowlist is wanted.
- **Risks:** secret leakage (logs, error bodies, the wire); a half-completed push/pull; mid-rebase state surviving (or not) across bridge invocations; the network timeout vs. the write-mutex interaction. This slice **earns the most deepening** — plan for the full 6-8-agent treatment the prior two slices got, with a dedicated security agent.
- **Gate:** `cargo test` (push/pull/conflict against a temp bare-remote fixture; push gate blocks a planted secret; PAT round-trips through a stubbed store); `bun test scripts` (no PAT in any log/error body — a tripwire test; route mapping incl. the stateful conflict flow); UI tests (push-blocked-by-secret surfaces findings; conflict resolution sub-view; PAT input never echoed).

---

## Slice 2: Bootstrap discovery wizard

- **Objective:** The first-run "scan your machine for existing Primitives and import them" wizard — `bootstrap_scan` (progress-streaming) → review a derived plan → `bootstrap_execute` (creates + reimports), with a resumable session.
- **Depends on:** Slice L (lifecycle — bootstrap *creates* Primitives) and Slice 7 (reimport — bootstrap *reimports* drifted/found installs). It is numbered "2" by feature priority but **sequenced after** its dependencies; the number reflects user-facing prominence (it's the onboarding flow), not build order.
- **Reference to port:** `bootstrap_scan` (`:1492`), `bootstrap_execute` (`:1517`), `read_bootstrap_session`/`clear_bootstrap_session` (`:1564,:1575`). Core: `bootstrap_scan.rs:31` (`bootstrap_scan<F: FnMut(ScanProgress)>` — **progress callback**), `bootstrap.rs:59,149` (`derive_plan`/`bootstrap_execute`), `bootstrap_session.rs` (resumable session persistence).
- **The hard part — progress streaming over a one-shot bridge:** every command so far is request→single-response. `bootstrap_scan` emits **progress events** during a potentially long filesystem scan. The one-shot JSON-stdout bridge has no event channel (the same constraint that killed `subscribe_drift` in #5's ADR amendment). Options to weigh in the slice plan: (a) **NDJSON progress frames** on stdout before the final envelope (the bridge already drains stdout concurrently — `library_bridge.ts`), with an SSE or chunked HTTP relay to the UI; (b) **poll a session file** (`bootstrap_session.rs` already persists session state) — scan writes progress to the session, the UI polls it (consistent with the dashboard's pull-poll posture, #5/ADR-0008); (c) a coarse non-streaming scan if the corpus is small enough. **Lean (b)** — it matches the established poll-don't-push decision and reuses the resumable-session the reference already has.
- **New seams:** bridge arms; session/plan/scan-progress models; routes (scan is long → its own timeout; execute is a write → mutex); a multi-step wizard view (scan → review plan → execute → resume) — the most stateful UI in the consolidation after git conflict resolution.
- **Risks:** long scan vs. timeouts; the streaming/polling decision (above); execute is a **bulk create+reimport** — its atomicity and partial-failure recovery (a session that's half-executed must resume, not double-create). The reference's session model is the recovery mechanism; port it, don't reinvent.
- **Gate:** `cargo test` (scan finds planted primitives; derive_plan is correct; execute creates+reimports; a half-execute resumes cleanly); route + wizard component tests (each step; resume from a persisted session; progress surfaced via the chosen mechanism).

---

## Slice 10: Native-affordance web redesigns

This is **not one slice** — it is a set of cross-cutting redesigns that **land alongside whichever slice surfaces the gap**, called out together so they're not forgotten or hacked in piecemeal. Each native Tauri affordance has no localhost-web equivalent and needs a deliberate redesign decision, not a port.

- **10a — Folder/path entry (replaces `pick_library_path:167` and `import_primitive_from_path`'s native picker).** The read-only slice already chose **`config/library.yaml` + a typed path** over a native picker (ADR-0007). The remaining gap: import-from-path (Slice L) and any "open another library" flow need a **web path-entry UX** — a validated text input with existence/`.prompt-library`-marker checks server-side, not an OS dialog. **Decision posture:** typed path + server validation, consistent with the existing config approach. Lands with Slice L.
- **10b — URL import (`fetch_primitive_from_url:330`, `url_import.rs`).** Network fetch of a Primitive from a URL — **rides Slice 8's network posture** (it's the second network-egress capability). Deferred until after git sync proves the network/secrets handling; not a standalone slice.
- **10c — "Reveal in Finder" (`reveal_working_file_path:730`, `reveal_install_path:1342`, `reveal_conflict_path:2041`).** No browser equivalent. **Redesign:** show the absolute path with a copy-to-clipboard button (the dashboard is localhost, so the path is real and useful), drop the reveal action. Lands with each slice that would have offered reveal (editor, install, conflict).
- **10d — iCloud check / recents menu / `is_install_path` (`is_library_in_icloud:1019`, `update_recents_menu:1230`, `is_install_path:1378`).** iCloud check → an informational warning banner if the library path is under a sync mount (relevant: `fd-lock` is intra-machine; #5 already noted "keep `DATA_DIR` off network/sync mounts"). Recents menu → a no-op (the web app has one configured library). `is_install_path` → fold into the install-detail rendering if needed. **Mostly droppable;** decide per-affordance in the surfacing slice.
- **Gate:** no standalone gate — each redesign is tested within its host slice. The deliverable here is the **decision log** (this section) so each native affordance has a recorded web answer rather than a TODO.

---

## Cross-cutting concerns (apply to every slice)

- **Per-slice deepening is mandatory.** This roadmap is the map; each slice gets its own `docs/plans/YYYY-MM-DD-feat-...-plan.md` deepened by parallel source-reading agents (the read-only and install slices both did, and both surfaced load-bearing corrections the roadmap can't anticipate). **Do not implement directly from this doc.**
- **Inherit the install slice's write safety wholesale:** route-level write mutex (D1), captured-intent + pending-write lock for destructive UI actions (D2), larger write timeout + `SIGKILL` (D4), atomic-write-makes-a-killed-bridge-safe (D4). New multi-step writes (publish, scaffold, bootstrap-execute) each owe an explicit not-atomic-across-steps statement + a kill-mid-op test (D3 pattern).
- **Colorblind-safe cues throughout** (Scott is red/green colorblind — global memory): every new state (dirty, drifted, conflicted, push-blocked, version-stale) is a label + glyph + Okabe-Ito-safe tone, never bare red/green. Extend `library.ts`'s `Cue` vocabulary; test cue distinguishability without color.
- **No `useEffect`** (repo rule): all reload-after-write is event-handler-driven `.reload()` on the relevant `resource()`; long-lived sync (git status poll, bootstrap progress) uses the existing poll/`resource` mechanism or a named `useSyncExternalStore` hook, never a raw effect.
- **Route-local failure** (ADR-0007): every new failure stays in the Library route; a failed publish/push/scan must leave `/api/summary`, `/api/agents`, `/healthz`, and doctor at 200 — a tested assertion per slice, as #5 did.
- **Secrets-free until Slice 8:** Slices 3-7, 9, L, 2 must keep the bridge `prompt-library-secrets`-free (the `Cargo.toml` comment is the tripwire). Only Slice 8 (and 10b, riding it) links secrets. A "no `SecretStore` constructed" assertion guards the network-free slices.

## Acceptance criteria (for the roadmap, not a single slice)

- Every remaining reference Tauri command in `commands.rs` is assigned to exactly one slice above (working-copy, versioning, overlays, metadata, lifecycle, search, reimport, git-sync, bootstrap) or to the native-affordance decision log (Slice 10) with a recorded web answer.
- The dependency order is explicit and respects the two hard constraints: (1) the editor (Slice 3) precedes everything that snapshots/edits the working copy; (2) git remote sync (Slice 8) — the sole network + secrets break — is sequenced after every network-free slice.
- Each slice has a stated objective, the reference command(s) + core/git/secrets fn(s) to port, the new bridge/route/UI seams, the load-bearing risks, and a concrete `cargo`/`bun`/`vitest` gate — enough that `/workflows:plan <slice>` starts grounded.
- The roadmap names, but does not pre-decide, the open architectural questions each slice must settle in its own deepened plan (publish atomicity, PAT storage, askpass-under-one-shot-bridge, bootstrap progress streaming, lifecycle-commit posture).

## Open questions (non-blocking; resolved per-slice, not here)

1. **Lifecycle vs. publish commit posture** — does every lifecycle op commit immediately (reference) or batch? Settled in Slice 4, consumed by Slice L. (Assumption: match the reference's commit-on-write.)
2. **Bootstrap progress transport** — NDJSON-on-stdout vs. session-file-polling vs. coarse-no-stream. (Leaning: session-file poll, matching #5/ADR-0008's poll-don't-push precedent.)
3. **PAT storage + askpass under process-per-request** — does Keychain + the askpass handshake survive a one-shot bridge? Settled in Slice 8 (verify before committing to the reference's mechanism).
4. **Search cost at scale** — does content search need an index, or is one-spawn-per-query fine at ~120 primitives? Bench in Slice 9 (assumption: fine; flag if p99 regresses).
5. **Editor richness** — textarea-first (this roadmap's assumption) vs. a syntax-aware editor. A UX call deferred to Slice 3's plan; textarea ships first.

## References

- Shipped slice plans (the patterns every slice extends): `docs/plans/2026-06-11-feat-prompt-library-consolidation-readonly-slice-plan.md`, `docs/plans/2026-06-11-feat-prompt-library-install-drift-slice-plan.md`
- ADRs: `docs/adr/0007-prompt-library-rust-command-bridge.md` (consolidation track, error/contract posture), `docs/adr/0008-dashboard-replaces-standalone-app-install-state-ownership.md` (install-state ownership + the poll-don't-push / `subscribe_drift`-deferred precedent that shapes Slices 2 and 8)
- Track doc: `docs/library-consolidation-track.md`
- Reference commands to port: `prompt-library/src-tauri/src/commands.rs` (line numbers per slice above)
- Reference crates (already imported as `crates/{core,git,secrets}`): `core/src/{working_files,version_store,overlay_merge,metadata,scaffold,rename,import_path,find,reimport,bootstrap,bootstrap_scan,bootstrap_session}.rs`; `git/src/{git_ops,conflict,push_gate,secret_scan,askpass}.rs`; `secrets/src/keychain.rs`
- Dashboard seams (extend, don't rewrite): `crates/prompt-library-bridge/src/main.rs` (dispatch `:103-117`, `Cargo.toml:12-14` secrets-free invariant), `scripts/library_{bridge,models,config,migration,routes}.ts`, `scripts/paths.ts`, `scripts/server.ts:63-101`, `ui/src/lib/{api.ts,library.ts}`, `ui/src/routes/Library.svelte`

## Next step

The roadmap is the map; each slice still earns a deepened plan before code. **Recommended ordering:** start the next deepened plan with **Slice 3 (working copy / editor)** — it unblocks the whole authoring chain, is fully network-free + secrets-free (so it ships under the proven install-slice invariants), and is the substrate every other authoring slice builds on. Interleave **Slice 9 (search)** as an independent low-risk slice whenever a palate-cleanser is wanted. Hold **Slice 8 (git remote sync)** for last among features and give it the heaviest deepening (dedicated security agent) — it is the sole network + secrets break in the whole consolidation.

Recommended: `/workflows:plan` Slice 3, or `/workflows:deepen-plan docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` if you want this roadmap's slice boundaries or the open architectural questions pinned further before cutting the first per-slice plan.
