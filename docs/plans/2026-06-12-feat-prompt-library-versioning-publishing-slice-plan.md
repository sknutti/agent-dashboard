# Prompt Library Consolidation — Slice 4: Versioning / Publishing — Implementation Plan

- **Date:** 2026-06-12
- **Type:** feat
- **Slice:** 4 of the consolidation roadmap (`docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md`, "Slice 4" section)
- **Depends on (shipped):** read-only slice (PR #4), install/drift slice (PR #5), working-copy/editor slice (Slice 3 — `save_working` + `*_working_file` bridge arms are already wired, `main.rs:124-130`)
- **ADRs:** ADR-0007 (Rust command bridge, error/contract posture, secrets-free invariant), ADR-0008 (install-state ownership, poll-don't-push)
- **Planning depth:** Comprehensive — this is the first dashboard write that touches **git** and the first **multi-step, multi-file** mutation (snapshot + set-current + commit).

## Overview / problem statement

The Library route can read versions but not produce them. The detail read-model already exposes `versions: string[]` and `current_version: string | null` (`library_models.ts:89-90`, surfaced read-only in `Library.svelte:529-538`), but there is no way to **cut a version**, **set the current pointer**, **inspect a frozen version**, or **revert the working copy** to one. This slice ports the reference's four versioning commands and makes the Library route an authoring surface for the version lifecycle.

It is also the slice that settles the **commit-on-write posture** for the whole consolidation. Today **no dashboard bridge command commits to git** — `cmd_install` and the working-file commands are pure-fs (verified: the bridge has zero `git_commit`/`git_add_all` usage outside test helpers, `main.rs:977-1056`). Publish is the first to stage-and-commit. Slice L (lifecycle) explicitly waits on the decision made here.

## Repository facts (verified at source, 2026-06-12)

### Core is ready; the bridge is not

- **`crates/core/src/version_store.rs:38-197`** — `VersionStore::{snapshot, read_current, set_current, list_versions, read_version, read_version_metadata}` are present, tested (12 unit tests, `:229-400`), and enforce the invariants this slice relies on:
  - `snapshot` is **immutable**: it errors `Error::VersionExists` if `versions/<label>/` already exists (`:46-48`).
  - `snapshot` writes every base + target-overlay file via `atomic_write`, then `version.yaml`, **then** `set_current` (`:53-79`) — so a kill mid-snapshot leaves partial version files but does NOT advance `current.txt` until the very end.
  - `set_current` errors `Error::VersionNotFound` if the label dir is absent (`:114-117`).
- **`crates/core/src/detail.rs:213,245`** — `read_primitive_version_view` (returns `PrimitiveVersionView { working, metadata }`, `:111-114`) and `revert_primitive_to_version` are present and tested (`:466,:591`). Revert is a **true rewind**: it writes every snapshot file into `working/` AND deletes working files the snapshot doesn't contain (`:241-244` doc + body).
- **`crates/core/src/version_label.rs`** — `VersionLabel` validates on every deserialize (`#[serde(try_from = "String")]`, `:7-9`): must be `v<digits>` with optional `[A-Za-z0-9._-]` dash-suffix. A bad label is rejected at the wire boundary before any command body runs.
- **`VersionMetadata { created_at: String, notes: Option<String> }`** (`version_store.rs:13-18`). `created_at` is an RFC3339 string the **caller supplies** — core does not read the clock. The reference injects it via `now_rfc3339()` (`commands.rs:374`); the dashboard core uses the same dependency-injected pattern elsewhere (`duplicate.rs:24` takes `now_rfc3339: &str`). **The bridge must produce the timestamp.**

### The git commit path

- **`crates/git/src/git_ops.rs:214,235`** — `git_add_all` (`git add -A`) and `git_commit` (`git commit -F -`, message piped on **stdin**, never argv). `git_commit` returns `Ok(false)` (not an error) when nothing is staged — "nothing to commit" is a no-op, not a failure (`:250-259`).
- The reference's `commit_change` (`commands.rs:439-451`) **silently skips** the commit if `.git/` is missing (`:440-442`) and relies on the library `.gitignore` excluding `*/working/` so `git add -A` never commits working-copy autosave noise — only the new `versions/<label>/` tree and `current.txt`.
- The bridge **already links `prompt-library-git`** and uses `TokioProcessRunner` for `cmd_library_status` (`main.rs:50-53, 209-243`). The async runner pattern to copy is right there. No new dependency, no secrets, no network.
- `git_commit` surfaces a missing-identity failure (`user.email`/`user.name` unset) as `RunnerError::Failed { status, stderr }` — git exits non-zero with a legible stderr. **This is the headless legibility hook** (see Decision 3).

### The dashboard seams to extend (not rebuild)

- **Bridge dispatch** — `main.rs:102-137`. Add four arms in a new "Versioning / publishing slice" block after the working-copy block (`:130`).
- **`map_core_error`** — `main.rs:840+`. **Gap found:** `CoreError::VersionExists` and `CoreError::VersionNotFound` are NOT in the match — they fall through to the catch-all. They must be promoted to dashboard-stable codes (`library_version_exists`, `library_version_not_found`), exactly as the working-copy slice promoted its variants (`:874-894`).
- **No git-error mapping exists in the bridge** (verified: zero `RunnerError` references in `main.rs`). Publish introduces the first one — a `git_commit` failure needs a dashboard-stable code (`library_commit_failed`), not the JSON catch-all.
- **`scripts/library_routes.ts`** — `WRITE_TIMEOUT_MS = 30_000` + `withWriteLock` (`:43-63`). The working-file write builders (`buildSaveWorking` et al., `:426-514`) are the exact template. Note: working-file writes use `WRITE_TIMEOUT_MS` but **skip `withWriteLock`** (the ledger mutex is for `installs.json` writers; working-file writes don't touch the ledger, `:375-376`). Versioning writes also don't touch `installs.json` — see Decision 4 for the mutex question.
- **`statusForCode`** — `library_routes.ts:71+`. `library_invalid_version` already maps to 422 (`:93`). New codes need arms.
- **`scripts/library_models.ts:84-90`** — `PrimitiveDetail` already carries `versions`/`current_version`. Add `PrimitiveVersionView` (mirrors core's `{ working: WorkingContent, metadata: { created_at, notes? } }`).
- **`ui/src/lib/api.ts:462-463`** — detail fetcher already parses `versions`/`current_version`. Add publish/revert/set-current/read-version fetchers.
- **`ui/src/routes/Library.svelte:529-538, 601-602`** — a **read-only** version strip + "Current version" line already render. This slice makes them interactive.
- **`ui/src/lib/library.ts:73-92`** — `Cue` vocabulary (`label`+`glyph`+`tone ∈ {amber,cyan,default}`, never bare red/green). Extend for version-state cues.

## Decisions to settle (the roadmap flagged these; settled here)

### Decision 1 — Publish atomicity: snapshot-then-commit, NOT atomic. Recoverable.

Publish is **two phases**: (1) `VersionStore::snapshot` (atomic per-file via `atomic_write`, but `current.txt` advances only after all version files land, `version_store.rs:53-79`), then (2) `git add -A && git commit`. **These are not atomic together**, mirroring the install slice's "not atomic across targets" (D3) statement.

Failure modes and recovery:
- **Kill mid-snapshot (before `current.txt` advances):** partial `versions/<label>/` files exist; `current.txt` unchanged; the version is **not** listed as current. Re-publish to the **same label** errors `VersionExists` (immutability) — recovery is re-publish to a *new* label, or the partial dir is harmless uncommitted noise (a future "Initialize git" / cleanup affordance, out of scope). **State this; it matches the reference's immutability contract.**
- **Snapshot succeeds, commit fails (e.g. no git identity):** the version exists on disk and `current.txt` points at it — the library is **correct**, only uncommitted. Recovery: the next publish/set-current commits everything (`git add -A` sweeps it up), or a future commit affordance. **The publish command must surface the commit failure as a non-fatal, legible warning, not swallow it** — see Decision 3.
- **`.git/` missing entirely:** commit is silently skipped (reference behavior, `commands.rs:440-442`). The snapshot still succeeded. This is correct for a non-git library.

**Test:** a kill-mid-publish integration test (snapshot lands, simulated commit failure) asserts the version is readable and `current.txt` is advanced — the library is usable, recovery is a no-op re-`set_current` or next-publish sweep.

### Decision 2 — `revert_to_version` is a LIBRARY-CONTENT op, distinct from install pinning.

The install slice deferred `revert_to_version` and stated "install always deploys the current pinned version." It returns here meaning **exactly one thing**: copy a frozen version's tree back into `working/` (`revert_primitive_to_version`, `detail.rs:245`). It is a **true rewind** of the working copy (overwrites + deletes orphans), NOT a re-install and NOT a change to any install record. After a revert, the working copy is dirty against `current.txt` until the author re-publishes.

The UI copy and the route name must keep this crisp so a reviewer never reads it as re-introducing install-time version pinning:
- Route verb: `POST …/revert` with body `{ version_label }`, labelled in the UI as **"Restore working copy from <label>"**, never "revert install" or "pin version."
- It is offered in the **version inspector / working-copy pane**, never in the install/target pane.
- **`set_current_version`** is the separate, install-relevant op: it moves the pointer that a *future* install reads, without touching `working/`. These are two distinct buttons with distinct copy.

**Whether revert commits:** revert mutates only `working/`, which the library `.gitignore` excludes — so a commit after revert would be a **no-op** (`git_commit` returns `Ok(false)`, `git_ops.rs:250-259`). **Decision: revert does NOT commit** (matches the reference — `revert_to_version` at `commands.rs:516` has no `commit_change` call, unlike `publish`/`set_current_version`). This keeps revert a pure working-copy edit, consistent with the working-file editor commands that also don't commit.

### Decision 3 — Commit identity / headless git config: fail legibly, never silently.

Publish commits as **whoever the library repo's git is configured as** (the reference's posture — no `-c user.email` override, `commands.rs:447`). The dashboard runs headless under the user's account, so git resolves identity from the library repo's local config or the user's global `~/.gitconfig`. There is **no dashboard-injected author**.

The risk: a library repo with **no `user.email`** makes `git commit` exit non-zero. The reference would surface that as an `AppError`. In the dashboard:
- The snapshot has **already succeeded** when the commit runs (Decision 1), so a commit failure must NOT fail the whole publish — the version exists and is usable.
- **Decision: publish returns a structured result** `{ committed: bool, commit_error: string | null }` rather than `{}`. A commit failure populates `commit_error` with the git stderr (the legible "Author identity unknown / please tell me who you are" message), `committed: false`, and the route returns **200** (the publish succeeded; the commit is advisory). The UI shows a colorblind-safe **"published, not committed"** cue with the git message and a one-line remediation ("set git user.email in the library repo"). This is strictly more legible than the reference's all-or-nothing.
- `git_commit` returning `Ok(false)` (nothing staged) → `committed: false`, `commit_error: null` (not an error — e.g. re-publishing identical content, or `.git/` missing). The UI distinguishes "nothing to commit" from "commit failed."

This makes the headless commit-identity story a **first-class, visible state**, not a silent swallow — satisfying the roadmap's "fails legibly, not silently" requirement.

### Decision 4 — Write safety: WRITE_TIMEOUT + SIGKILL yes; ledger mutex no.

Versioning writes touch `versions/<label>/`, `current.txt`, and the git index — **never `installs.json`**. The `withWriteLock` mutex exists specifically to serialize `installs.json` load→mutate→save cycles (`library_routes.ts:45-54`); versioning has no such read-modify-write on a shared ledger file. **Decision: versioning write routes use `WRITE_TIMEOUT_MS` + SIGKILL (inherited atomic-write safety) but skip `withWriteLock`** — matching the working-file editor routes (`:375-376`).

**One caveat to verify in implementation:** two concurrent publishes of the *same* `(kind, name)` to *different* labels both run `git add -A` — git's index lock (`.git/index.lock`) serializes the commits at the git layer, and `set_current` last-write-wins is benign (both labels are valid versions). Two publishes of the *same label* are caught by `VersionExists` immutability. So no app-level mutex is needed; the test should confirm the git-index-lock contention surfaces as a retryable `library_commit_failed`, not corruption. If contention proves flaky in CI, a **git-only** write lock (narrower than the ledger mutex) is the fallback — flagged, not pre-adopted.

### Decision 5 — Published-but-not-pushed secrets are possible and acceptable (matches reference).

The reference's secret-scan / push-gate runs at **push**, not commit (roadmap risk note; gate lands in Slice 8). A publish that commits a secret is therefore possible and stays **local** until Slice 8's push gate. This is acceptable and matches the reference — but the publish UI must not imply the commit is "shared." Copy: "committed locally" — Slice 8 owns push.

## Implementation phases (test-first within each)

### Phase 1 — Bridge: four versioning commands + error mapping

- **Objective:** Wire `publish`, `set_current_version`, `read_primitive_version`, `revert_to_version` into the bridge dispatch, with the snapshot-then-commit publish and the structured publish result.
- **Changes:**
  1. `map_core_error` (`main.rs:840+`): add arms for `CoreError::VersionExists` → `("library_version_exists", "a version with that label already exists")` and `CoreError::VersionNotFound` → `("library_version_not_found", "no such version")`. (Verify the exact variant names against the dashboard core's `Error` enum during implementation — the reference uses `VersionExists(String)` / `VersionNotFound(String)`.)
  2. Add a git-commit helper in the bridge mirroring the reference's `commit_change` (`commands.rs:439-451`): skip if `.git/` absent; else `TokioProcessRunner` → `git_add_all` → `git_commit`; return a `{ committed, commit_error }` shape instead of erroring. Map `RunnerError::Failed.stderr` into `commit_error` (server-side detail discipline still applies — the stderr is user-facing *git* output, not a library path, so it's safe to forward as the remediation message; confirm no path leak).
  3. Add a timestamp helper (`now_rfc3339()`) in the bridge — the bridge owns the clock (core takes `created_at` as a string). Reuse `time_helpers.rs` pattern from the reference or a `std::time` + format equivalent; verify no `chrono` dep is silently added (check workspace deps).
  4. `cmd_publish`: parse `kind`/`name`/`version_label`/`notes?` → build `VersionMetadata { created_at: now, notes }` → `VersionStore::snapshot` (map_core_error) → commit helper with `format_publish_commit_message` (port verbatim, `commands.rs:404-420`) → return `json!({ "committed": …, "commit_error": … })`.
  5. `cmd_set_current_version`: `VersionStore::set_current` → commit helper with `current(<dir>/<name>): <label>` message (`commands.rs:485-491`) → return commit result.
  6. `cmd_read_primitive_version`: `read_primitive_version_view` → serialize the `PrimitiveVersionView`. Read-only.
  7. `cmd_revert_to_version`: `revert_primitive_to_version` → **no commit** (Decision 2) → `json!({})`. Working-copy-only.
  8. Dispatch arms (`main.rs:130`): four new entries. `publish`/`set_current_version` are `.await` (they call the async runner); `read_primitive_version`/`revert_to_version` are sync.
- **Affected:** `crates/prompt-library-bridge/src/main.rs` (dispatch, `map_core_error`, two new helpers, four `cmd_*` fns), bridge `Cargo.toml` (no new deps expected — `git` already linked; confirm `tokio` features suffice for the runner).
- **Risks:** the `VersionExists`/`VersionNotFound` variant names; the timestamp helper sneaking in a dep; the commit helper accidentally forwarding a path in `commit_error`.
- **Validation (`cargo test --workspace`):** snapshot→list→read→set-current→revert round-trip against a temp library; `publish` returns `committed:true` when `.git` + identity present; `committed:false,commit_error:<msg>` when identity unset (test sets a temp repo with no `user.email`); `committed:false,commit_error:null` when `.git` absent; re-publish same label → `library_version_exists`; set-current unknown label → `library_version_not_found`; revert leaves no commit (HEAD unchanged) and rewinds working (orphan deleted); **kill-mid-publish** (snapshot done, commit injected-fail) leaves a usable, current version (Decision 1).

### Phase 2 — TS: routes, models, status mapping

- **Objective:** Expose the four commands as HTTP routes with the established write-safety + error-mapping discipline.
- **Changes:**
  1. `library_models.ts`: add `PrimitiveVersionView` interface + `parsePrimitiveVersionView` (mirror `{ working: WorkingContent, metadata: { created_at: string; notes?: string } }`); add `PublishResult { committed: boolean; commit_error: string | null }` + parser.
  2. `library_routes.ts`: `buildPublish` (POST, body `{ version_label, notes? }`, `WRITE_TIMEOUT_MS`, no `withWriteLock`, returns 200 + `PublishResult`), `buildSetCurrentVersion` (POST, `{ version_label }`, returns 200 + commit result), `buildReadPrimitiveVersion` (GET `…/versions/:label`, read — 10s default timeout, no lock), `buildRevertToVersion` (POST `…/revert`, `{ version_label }`, `WRITE_TIMEOUT_MS`, no lock, 200 `{}`). Template: the working-file builders (`:426-514`).
  3. `statusForCode`: add `library_version_exists` → 409 (immutability conflict, "use a new label"), `library_version_not_found` → 404, `library_commit_failed` → **only if a commit failure is ever surfaced as an error** — under Decision 3 it is NOT (it rides the 200 `PublishResult`), so this code is reserved, not wired, unless a hard commit-path transport fault occurs (then it's a 502 via the existing catch-all).
  4. Route registration in the server (wherever the working-file routes register — follow that pattern); reconfirm the `server.ts:63-101` Host/Origin write-guard covers the new POSTs.
- **Affected:** `scripts/library_models.ts`, `scripts/library_routes.ts`, route registration, `scripts/library_models.test.ts`, `scripts/library_routes.test.ts`.
- **Risks:** forgetting the Origin guard on the new POSTs; the `notes` field round-tripping (it travels in the JSON body, not argv — core handles newlines, but verify the TS body parse preserves them).
- **Validation (`bun test scripts`):** model parsers (valid + malformed `PrimitiveVersionView`/`PublishResult`); route mapping for all four; `library_version_exists`→409, `library_version_not_found`→404; publish 200 carries `committed`/`commit_error`; the read route skips the write timeout/lock; a write POST without the Origin header is rejected (existing guard test extended); **route-local failure assertion** — a failed publish leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.

### Phase 3 — UI: interactive version pane (publish / set-current / revert / inspect)

- **Objective:** Turn the read-only version strip into the authoring surface, with colorblind-safe state cues and event-handler-driven reload (no `useEffect`).
- **Changes:**
  1. `ui/src/lib/api.ts`: add `publishVersion`, `setCurrentVersion`, `revertToVersion`, `readPrimitiveVersion` fetchers (follow the install/working-file fetcher shape, `:462+`).
  2. `ui/src/lib/library.ts`: extend `Cue` vocabulary — `publishStateCue(committed, commit_error)` → `{committed:true}` "committed locally" (default tone, glyph ○-equiv), `{committed:false, error}` "published · not committed" (amber, glyph ●), `{committed:false, error:null}` "no changes to commit" (default). Add `currentVersionCue(label, current)` to distinguish "this is current" from "this is a past version" by **label + glyph**, never color (reuse the dirtyCue idiom, `:80-92`). Unit-test cue distinguishability without color.
  3. `ui/src/routes/Library.svelte`: 
     - Make the version strip (`:529-538`) interactive: each version chip → click opens the **inspector** (calls `readPrimitiveVersion`, shows frozen content + `created_at`/`notes`), with **"Set as current"** and **"Restore working copy"** actions per Decision 2's distinct labels.
     - Add a **"Publish version"** action on the working-copy pane: a small form (label input — client-side `v<digits>` hint mirroring `VersionLabel`, optional notes textarea) → `publishVersion` → on success show the `publishStateCue`, then `.reload()` the detail resource (event-handler-driven, no effect) so `versions`/`current_version`/`dirty` refresh.
     - Per-action **pending-write lock** (the #5 D2 captured-intent pattern) so a double-click can't double-submit; destructive-adjacent "Restore working copy" gets a confirm (it discards uncommitted working edits).
     - Surface `commit_error` inline (the legible git remediation), not a generic toast.
  4. Reload-after-write everywhere is `.reload()` on the relevant `resource()` in the success handler — **no `useEffect`** (repo rule); the 30s detail poll already exists, the manual reload just makes the post-write refresh immediate.
- **Affected:** `ui/src/lib/api.ts`, `ui/src/lib/library.ts`, `ui/src/lib/library.test.ts`, `ui/src/routes/Library.svelte` (+ its `.svelte.test.ts`).
- **Risks:** the editor-buffer-survives-poll concern from Slice 3 — publishing snapshots the **saved** working copy, so the publish form must act on persisted state; if there are unsaved editor edits, prompt to save first (don't silently publish stale bytes). "Restore working copy" must reload the open editor buffer afterward (it just rewrote `working/`).
- **Validation (`*.svelte.test.ts` + `library.test.ts`):** publish form submits → success cue + detail reload; `commit_error` renders inline; "Set as current" vs "Restore working copy" are distinct, distinctly-labelled actions hitting distinct routes; version inspector shows frozen content; cues distinguishable without color; pending-lock blocks double-submit; restore prompts a confirm; revert reloads the editor buffer.

## Acceptance criteria

- [ ] `publish` snapshots the working copy to `versions/<label>/`, sets `current.txt`, and commits (`git add -A && git commit -F -`) — returning `{ committed, commit_error }`; a commit failure (no git identity) yields `committed:false` + the legible git message at **HTTP 200**, with the version still on disk and current (Decision 1 + 3).
- [ ] Re-publishing an existing label returns `library_version_exists` (409) — immutability holds (Decision 1).
- [ ] `set_current_version` moves the pointer and commits a `current(...)` message; unknown label → `library_version_not_found` (404).
- [ ] `read_primitive_version` returns the frozen `{ working, metadata }` view; `revert_to_version` rewinds `working/` (overwrites + deletes orphans) and does **not** create a commit (Decision 2).
- [ ] The version pane offers four distinct, distinctly-labelled actions — Publish, Set-as-current, Restore-working-copy, Inspect — with colorblind-safe cues (label + glyph, never bare red/green) and no `useEffect` (reload is event-handler `.reload()`).
- [ ] **Route-local failure:** a failed publish/revert leaves `/api/summary`, `/api/agents`, `/healthz`, and doctor at 200.
- [ ] **Secrets-free invariant intact:** the bridge still does NOT link `prompt-library-secrets`; no network call; the "no SecretStore constructed" assertion still passes.
- [ ] A kill-mid-publish test demonstrates recoverable state (version usable, re-publish-to-new-label or next-commit-sweep recovers).

## Dependencies and risks

- **Depends on:** Slice 3 (working-copy editor — publish snapshots what it produces; the editor-save-before-publish flow assumes the save path exists, which it does, `main.rs:124-130`).
- **Blocks / is consumed by:** Slice L (lifecycle) — the commit-on-write posture (Decisions 1 + 3) is the spec Slice L's scaffold/rename/delete commits must follow. Slice 7 (reimport) — reimport is a version snapshot, reusing this slice's publish-result + commit machinery.
- **Risk — `VersionExists`/`VersionNotFound` variant names** in the dashboard core's `Error` enum: verify before writing the `map_core_error` arms (the reference uses those names; the dashboard core may differ).
- **Risk — timestamp dependency:** the bridge needs an RFC3339 `now`; ensure no `chrono` creeps in unexamined (prefer the reference's `time_helpers.rs` approach or `std::time` formatting).
- **Risk — git-index contention** on concurrent same-primitive publishes (Decision 4): mitigated by git's own `index.lock`; fallback is a narrow git-only mutex, not the ledger mutex.
- **Risk — published secrets stay local** until Slice 8's push gate (Decision 5): acceptable, matches reference; the UI copy must say "committed locally," not "shared."

## References

- Reference commands: `prompt-library/src-tauri/src/commands.rs` — `publish:366`, `format_publish_commit_message:404`, `commit_change:439`, `commit_publish:453`, `set_current_version:466`, `read_primitive_version:498`, `revert_to_version:516`
- Core (dashboard, ready): `crates/core/src/version_store.rs:38-197`, `crates/core/src/detail.rs:213,245` (`read_primitive_version_view`, `revert_primitive_to_version`), `crates/core/src/version_label.rs`
- Git: `crates/git/src/git_ops.rs:214` (`git_add_all`), `:235` (`git_commit`)
- Bridge seam: `crates/prompt-library-bridge/src/main.rs` (dispatch `:102-137`, `map_core_error` `:840+` — **missing `VersionExists`/`VersionNotFound` arms**, async git pattern `:209-243`, `Cargo.toml` secrets-free comment)
- TS seams: `scripts/library_routes.ts` (`WRITE_TIMEOUT_MS:43`, `withWriteLock:56`, working-file builders `:426-514`, `statusForCode:71`), `scripts/library_models.ts:84-90`
- UI seams: `ui/src/lib/api.ts:462-463`, `ui/src/lib/library.ts:73-92` (Cue), `ui/src/routes/Library.svelte:529-538,601-602` (read-only version strip to make interactive)
- Roadmap: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` (Slice 4)

## Next step

The plan is detailed enough to execute. Recommended: `/workflows:work docs/plans/2026-06-12-feat-prompt-library-versioning-publishing-slice-plan.md`, starting Phase 1 (bridge). The one item worth confirming before code is the exact `VersionExists`/`VersionNotFound` variant names in the dashboard core's `Error` enum — a 30-second grep, but it drives the `map_core_error` arms.
