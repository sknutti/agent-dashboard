# Prompt Library Consolidation — Slice 10b: URL Import — Implementation Plan

- **Date:** 2026-06-12
- **Type:** feat
- **Roadmap:** [2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md](2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md) (Slice 10 section, item **10b**, `:217`)
- **Rides:** [2026-06-12-feat-prompt-library-git-remote-sync-slice-plan.md](2026-06-12-feat-prompt-library-git-remote-sync-slice-plan.md) (Slice 8) — the **first** network-egress capability. 10b is the **second** egress capability and inherits Slice 8's proven network posture (the `127.0.0.1`-bound server, the `withWriteLock` serialization for writers, the route-local-failure contract). It is **NOT secrets-bearing** — no PAT, no `SecretStore` on this path.
- **ADRs:** [0007-prompt-library-rust-command-bridge.md](../adr/0007-prompt-library-rust-command-bridge.md) (error/contract posture, code→HTTP), [0005-folder-import-uses-github-contents-api.md] (reference repo — the SKILL.md folder-import GitHub Contents API tradeoff, ported in-core).
- **Reference:** `~/side_projects/playground/prompt-library/src-tauri/src/commands.rs:330` (`fetch_primitive_from_url`) + `crates/core/src/url_import.rs` (the whole fetch/normalize/walk machinery). Core is **already imported** into this repo.
- **Planning depth:** Standard. The hard security work is **already done in-core** (host allowlist, size caps, path containment, timeout, UTF-8 validation — all unit-tested). This slice is bridge wiring + TS route/model + a "fetch by URL" affordance on the existing create flow. The standout concern is SSRF surface, which is mitigated in-core but must be re-stated and tripwire-tested at the dashboard boundary.

## Overview / problem statement

Slice L (lifecycle) shipped `create_primitive` end to end (bridge `cmd_create_primitive` `:1059`, route `buildCreatePrimitive` `:956`, UI `createPrimitive` in `Library.svelte:810-831`) — but the dashboard's create path passes **no `imported` payload**: it always scaffolds an empty primitive (`scaffold_primitive(..., None)` at `main.rs:1065`). The reference, by contrast, lets a user **paste a GitHub URL**, previews the fetched primitive (name/author/content + any Skill folder ref-files), and submits it through `create_primitive`'s `imported` argument so the new primitive is seeded with real content + provenance in a single scaffold.

Slice 10b ports that. Two pieces:

1. **`fetch_primitive_from_url`** — a new bridge command that calls the already-imported `core::fetch_from_url(url)`, returning a `FetchedPrimitive` (`{content, suggested_name, author, source_url, ref_files}`). This is the **network fetch** — `reqwest`-backed, GitHub-only, of **untrusted remote bytes**. It is a **read** (no library write, no commit, no secrets).
2. **Seeded create** — extend `cmd_create_primitive` + `buildCreatePrimitive` + the create UI to accept an optional `imported: ImportedPrimitive` payload, so a fetched preview can be written as the new primitive's content + `metadata.yaml` provenance (`source_url`, `author`). This is the **write** (scaffold + commit, already built — we thread one new optional arg through it).

The split matters: **fetch ≠ create.** The user fetches (network read, previews), then optionally creates (library write). A failed fetch never touches the library; a create with a stale/empty fetch is just the existing empty-or-seeded scaffold.

## Repository facts (verified at source, 2026-06-12)

### What is already present (extend, don't rebuild)

- **`url_import.rs` is already vendored into the dashboard's core crate** (`crates/core/src/lib.rs:37` `pub mod url_import`, `:63` re-exports `fetch_from_url, is_skill_md_url, FetchedPrimitive, RefFile`). **`reqwest` (with `json`) + `futures` are already in `crates/core/Cargo.toml:21,23`.** So `fetch_from_url` **compiles into the dashboard today** — it has simply never been *called* by the bridge, so no dashboard code path has ever made this network call. This slice flips that switch.
- **The bridge already links the network-capable core** and acknowledges it: `crates/prompt-library-bridge/Cargo.toml` comment (post-Slice-8) — "core links reqwest transitively, but only the git-sync push/pull egress (Phase 2) makes a network call — every other path stays network-free (code-discipline)." **This slice's wiring requires updating that comment**: url_import becomes the second deliberate egress path.
- **The security work lives in-core and is unit-tested** (`url_import.rs`, 30+ tests in the file): 
  - **Host allowlist via `normalize_url` (`:417`)** — https-only, **github.com / raw.githubusercontent.com only**; gists rejected; every other host rejected; `http://` rejected; blob URLs rewritten to raw, tree URLs rejected. This is the **SSRF defense**: a user cannot point the fetch at `http://169.254.169.254/…`, `file://`, an internal host, or a redirect target outside GitHub (reqwest follows redirects by default, but the *initial* host is allowlisted; **see Open Question 1 on redirect-following**).
  - **Size caps** — `MAX_BYTES = 1 MiB` (`:33`, per-file), `MAX_BUNDLE_BYTES = 4 MiB` (`:34`, whole Skill folder), `MAX_BUNDLE_FILES = 200` (`:35`). The bundle caps are **pre-flighted before any byte fetch** (`:268-285`) so a 100 MiB folder fails in milliseconds.
  - **Path containment** — every Skill ref-file path runs through `validate_ref_path` (`:299`) before it's accepted, so a malicious Contents API listing cannot smuggle a `../` rel-path.
  - **Timeout** — `TIMEOUT = 10s` (`:36`) on the reqwest client.
  - **UTF-8 validation** of the primary file at fetch time (`:129`) so the frontend never handles byte-level errors. Ref-files are NOT UTF-8-validated (binary assets like PNGs allowed), matching the disk-import path.
  - **Rate-limit handling** — GitHub Contents API 403-with-`x-ratelimit-remaining: 0` → a distinct `Error::GitHubRateLimited` (`:355-360`) the UI can surface as "you've hit GitHub's 60/hr anonymous limit," not a generic failure.
- **The `Error` variants are already in the dashboard core** (`crates/core/src/error.rs`): `UnsupportedSourceUrl{reason}` (`:113`), `FetchFailed{url,message}` (`:116`), `BundleInvalid{reason}` (`:122`), `GitHubRateLimited` (`:128`). **`map_core_error` (`main.rs:2318`) does NOT yet map these four** — they currently fall into the catch-all (→ a generic `library_*`/502). This slice promotes them out (the value-add pattern every prior slice used: surface the actionable error as a typed route code).
- **The create seam to extend (Slice L, shipped):**
  - Bridge `cmd_create_primitive` (`main.rs:1059`) — reads `path`/`kind`/`name`/`created_at`, calls `scaffold_primitive(..., None)`, commits. **The `None` is the seam**: the reference passes `Some(ScaffoldSource{content, source_url, author, ref_files})` built from the `ImportedPrimitive`. The dashboard's `scaffold_primitive` signature already accepts that arg (it's the same vendored core).
  - Route `buildCreatePrimitive` (`library_routes.ts:956`) — builds `{path, kind, name, created_at}`; registered `POST /api/library/primitives` (`:1621`); takes `WRITE_TIMEOUT_MS`. **NOT write-locked** (create touches no `installs.json` — confirmed by Slice L: "create/duplicate unlocked").
  - UI `createPrimitive(kind, name)` (`api.ts:885` → `sendJson("/api/library/primitives", "POST", {kind, name})`); the create form is `Library.svelte:810-831` (`createKind`/`createName` state, `createNotice` for validation).
- **The reference `ImportedPrimitive` shape** (`commands.rs:267`): `{content: String, source_url: String, author: Option<String>, ref_files: Vec<RefFile>}`. Note `FetchedPrimitive` has `suggested_name` (a fetch-time convenience) but `ImportedPrimitive` does NOT — the name comes from the user (pre-filled from `suggested_name`, editable). The frontend maps fetch→create by dropping `suggested_name` and supplying the final `name` separately.
- **Server egress posture:** `server.ts:3` — bound to `127.0.0.1` ONLY; `:64-101` Host allowlist + Origin guard on writes. The fetch route is a **read (GET-shaped)**, but it **egresses** — like Slice 8's status reads, it is one of the very few routes that talk to a non-loopback host. No new outbound allowlist is needed at the server layer (the allowlist lives in-core: `normalize_url`).

### The reference command to port (the AppState→bridge translation)

| Reference cmd (`commands.rs`) | Bridge arm | Secrets? | Network? | Library write? | Notes |
|---|---|---|---|---|---|
| `fetch_primitive_from_url` `:330` | `fetch_primitive_from_url` | **no** | **YES (egress)** | **no** | `core::fetch_from_url(&url).await` → `FetchedPrimitive`. No `require_library` (a fetch needs no library). No commit, no lock. Maps the 4 url_import errors to typed codes. |
| `create_primitive` `:282` (the `imported` arm) | `create_primitive` (EXTEND) | no | no | **YES (scaffold + commit)** | Already shipped without `imported`; this slice threads the optional `imported: ImportedPrimitive` through to `scaffold_primitive(..., Some(source))`. |

## Decisions (settled here)

- **D1 — `fetch` and `create` stay two separate operations** (matches the reference). The fetch route returns a preview; the user reviews + edits the name; a separate create call writes it. Rationale: a network read of untrusted content must NOT be coupled to a library write — the user must see what was fetched before it lands on disk, and a fetch failure must never leave a half-scaffolded primitive. This also keeps `fetch` lock-free and write-free.
- **D2 — `fetch_primitive_from_url` is a READ route, but it EGRESSES.** It takes **no write lock** (it touches neither the library tree nor `installs.json` — it reads the network into memory and returns). It uses a **network timeout**, not the read timeout: reuse Slice 8's `NETWORK_TIMEOUT_MS` (90s at the TS layer) so a slow-but-healthy GitHub fetch isn't SIGKILL'd. The in-core 10s reqwest timeout fires first on a hung connection; the TS network timeout is the outer backstop (same layering as Slice 8's pull: inner-core-timeout < outer-TS-timeout). **Confirm the constant is exported/reusable from `library_routes.ts`** (Slice 8 added it).
- **D3 — The URL is a request-body field, NOT a config-injected path.** Unlike `library_path`/`installs_path`/`askpass_dir` (config-injected, never from the body — the containment boundary), the URL is **inherently user-supplied** and must come from the request body — there is no other source. The containment that makes this safe is **in-core**: `normalize_url`'s host allowlist is the boundary, exactly as `validate_ref_path` is the boundary for working-file paths. State this explicitly: *this is the one user-supplied "where to read from" on a network path, and the allowlist is what makes it safe* — it is not a regression of the never-trust-the-body posture, because the trust boundary moved into `normalize_url`.
- **D4 — Four new error codes, promoted out of the catch-all** (the established pattern):
  - `UnsupportedSourceUrl{reason}` → `library_unsupported_source_url` → **422** (the URL is malformed/disallowed — a user-fixable input error; the `reason` is detail-only, m4).
  - `FetchFailed{url,message}` → `library_fetch_failed` → **502** (the upstream fetch failed — network/HTTP/oversize/non-UTF-8; `url` + `message` stay server-side detail, m4 — **the URL could carry a private token in a path; never echo it**).
  - `BundleInvalid{reason}` → `library_bundle_invalid` → **422** (the Skill folder violated a cap or path rule — a property of the source, surfaced as "this folder is too big / has an invalid layout").
  - `GitHubRateLimited` → `library_github_rate_limited` → **429** (distinct, actionable — "GitHub's 60/hr anonymous limit; wait and retry"). **`statusForCode` has no 429 today — confirm adding it (Slice 8 only added 409/422/502); 429 is the correct semantic.** If 429 is undesired, fall back to 502 with a distinct *code* so the UI still distinguishes it.
- **D5 — `create_primitive` gains an OPTIONAL `imported` arg; the empty-create path is byte-for-byte unchanged.** When `imported` is absent → `scaffold_primitive(..., None)` (today's behavior, no regression). When present → build `ScaffoldSource` and pass `Some(...)`. The `ref_files` (binary-tolerant `Vec<RefFile>`) cross the bridge as base64 or a byte-array in JSON — **settle the wire encoding in impl** (the reference uses serde's default `Vec<u8>` → a JSON number array; the dashboard's existing `WorkingFileBytes` model already faces this `Vec<u8>`-over-JSON question — reuse that convention so a Skill's PNG ref-file round-trips). The `source_url`/`author` land in `metadata.yaml` provenance (core does this in `scaffold_primitive`).
- **D6 — No SSRF beyond the in-core allowlist, but a route-layer tripwire proves the body can't bypass it.** The defense is `normalize_url`. The dashboard adds a **tripwire test**: a `fetch` body with `http://169.254.169.254/`, `file:///etc/passwd`, `https://internal.host/x`, and a non-github `https://` host each returns `library_unsupported_source_url` (422), never an egress to that host. This mirrors Slice 8's "the PAT never leaks" and the working-file slice's "`../` is rejected" tripwires — the security property is a *tested assertion*, not a comment.

## Implementation phases

Test-first within each phase. Each phase is independently gate-able. The network/egress surface lands in Phase 1 (the bridge fetch), reviewed, before any UI.

### Phase 1: Bridge — `fetch_primitive_from_url` + the `imported` create arm — ✅ DONE (2026-06-12)
> **Status:** Shipped. **Decision 1 (settled):** core `url_import` now builds its reqwest client via a new `http_client()` helper with `.redirect(Policy::none())` — the SSRF redirect gap is closed (an inline `#[tokio::test]` with httpmock proves a 302 is returned, not chased, and the internal target gets 0 hits). `cmd_fetch_primitive_from_url` (async, no library/commit/lock/SecretStore) calls `fetch_from_url` + maps the 4 errors; `cmd_create_primitive` gained the optional `imported` arm (builds `ScaffoldSource` from an `ImportedPrimitive` DTO — `ref_files` converted to the `(Utf8PathBuf, Vec<u8>)` pairs core wants; absent → the empty scaffold, byte-for-byte unchanged). New `map_core_error` arms: `UnsupportedSourceUrl`→`library_unsupported_source_url`, `FetchFailed`→`library_fetch_failed`, `BundleInvalid`→`library_bundle_invalid`, `GitHubRateLimited`→`library_github_rate_limited` (+ `library_invalid_import_payload` for a malformed seed). Cargo.toml + module-doc egress invariant amended (two egress paths now; url_import is NOT secrets-bearing). Tests: the **D6 SSRF tripwire** (6 disallowed hosts/schemes → one code, no egress — normalize_url rejects before the client builds), empty-url rejection, seeded-create (content + `metadata.yaml` provenance), ref-files written, and the empty-create regression guard. Gate: `cargo test --workspace` **704 pass**; my code clippy-clean (2 pre-existing warnings in find.rs/folder_import.rs untouched).

### Phase 1 (original plan): Bridge — `fetch_primitive_from_url` + the `imported` create arm

- **Objective:** Add the network fetch command and extend create to seed from a fetched payload.
- **Changes:**
  - `main.rs`: 
    - New `async fn cmd_fetch_primitive_from_url(args)` — parse `url` (a non-empty string from the body; reject missing/empty with a typed code BEFORE any network call), call `core::fetch_from_url(&url).await`, map errors via the new `map_core_error` arms (D4), serialize `FetchedPrimitive` to JSON. **No `require_library`** (fetch needs no library). No commit, no lock, no `SecretStore`.
    - Dispatch arm `"fetch_primitive_from_url" => cmd_fetch_primitive_from_url(args).await` (`.await` — it's async network).
    - Extend `cmd_create_primitive` (`:1059`): parse an OPTIONAL `imported` from args (`ImportedPrimitive`-shaped); when present, build `ScaffoldSource{content, source_url, author, ref_files}` and call `scaffold_primitive(..., Some(source))`; when absent, keep `None` (D5 — no regression). Reuse the reference's `ImportedPrimitive` struct (`commands.rs:267`) — define it locally in the bridge (the bridge owns its DTOs).
    - `map_core_error` (`:2318`): add the 4 arms (D4). The `reason`/`url`/`message` payloads are the `detail` (logged server-side, never forwarded — m4); the `(code, message)` pair is the only client-facing content.
  - `crates/prompt-library-bridge/Cargo.toml`: update the post-Slice-8 comment — url_import is now the **second** deliberate egress path; "two network paths: git-sync push/pull (Slice 8) and url_import fetch (Slice 10b); every other path stays network-free; neither url_import path is secrets-bearing."
  - `main.rs` module doc (`:31` neighborhood): amend the network-invariant note to name url_import alongside git-sync as the egress paths, and assert url_import is **secrets-free** (it constructs no `SecretStore`).
- **Affected areas:** `crates/prompt-library-bridge/{src/main.rs, Cargo.toml}`. Core unchanged (already linked + tested).
- **Dependencies:** none beyond the shipped Slice L create path.
- **Risks:** the egress break (second one) — contained by the in-core allowlist; the new arm constructs no `SecretStore` (assert the secrets-free posture holds on this path). `Vec<u8>` ref-file wire encoding (D5) — settle against the existing `WorkingFileBytes` convention.
- **Validation:** `cargo test --workspace`:
  - `cmd_fetch_primitive_from_url` against a **local mock** (the core already has `fetch_from_url_for_tests`/`walk_skill_folder_for_tests` with an injectable `api_base` — but the *primary* fetch hits `raw.githubusercontent.com` hardcoded, so a single-file fetch test needs either a network stub or a unit test at the `normalize_url`/error-mapping layer; **lean on testing the error-mapping + the normalize allowlist at the bridge boundary** rather than a live fetch — the core's own tests already cover the happy fetch path with httpmock per its `tests/folder_import.rs`).
  - **D6 SSRF tripwire:** each disallowed host/scheme → `library_unsupported_source_url`, no panic, no hang.
  - `cmd_create_primitive` with `imported` present → primary file seeded + `metadata.yaml` has `source_url`/`author`; with a Skill `ref_files` payload → ref-files written under `working/base/`; with `imported` absent → byte-identical to today's empty scaffold (regression guard).
  - **Secrets-free assertion:** the fetch + create paths construct no `SecretStore` (the existing "non-git-sync constructs none" assertion extends to cover the new arm).

### Phase 2: TS routes + models — the fetch route + the seeded create body — ✅ DONE (2026-06-12)
> **Status:** Shipped. `parseFetchedPrimitive` (`{content, suggested_name, author?, source_url, ref_files: [{rel_path, content: number[]}]}` — `ref_files` content via the `asByteArray` Vec<u8> convention). `buildFetchPrimitiveFromUrl` (no write lock, `NETWORK_TIMEOUT_MS`, no library gate — a fetch precedes any write, Open Q4); `buildCreatePrimitive` forwards the optional `imported` (undefined → dropped → empty scaffold). `POST /api/library/import/fetch` (own prefix off `:kind/:name`, mirroring `/search`; POST so the egress earns server.ts's Origin guard). **Decision 2 (settled):** `HttpStatus` union extended with 429; `statusForCode` maps `library_unsupported_source_url`/`library_bundle_invalid`/`library_invalid_import_payload`→422, `library_github_rate_limited`→429, `library_fetch_failed`→502. Tests: the new code→HTTP mappings, fetch-arg forwarding, the **m4 URL-leak tripwire** (a FetchFailed detail embedding `?token=SUPERSECRET` → the response body is `{code, message}` only, no URL/token), create-forwards-imported (+ omits-when-absent), and route-local failure. Gate: tsc 0, `bun test scripts` **438 pass** (9 new).

### Phase 2 (original plan): TS routes + models — the fetch route + the seeded create body

- **Objective:** Expose `fetch_primitive_from_url` as a route; extend `buildCreatePrimitive` to forward an optional `imported` payload; add the model parsers + error-code HTTP mapping.
- **Changes:**
  - `library_models.ts`: `FetchedPrimitive` interface + `parseFetchedPrimitive` (`{content, suggested_name, author?, source_url, ref_files: RefFile[]}`); `RefFile` (`{rel_path, content}` — the `content` byte encoding matching D5); an `ImportedPrimitive` input shape for the create body. (Reuse the existing `Vec<u8>`-over-JSON convention from `WorkingFileBytes`/`source_url` already present at `:92`.)
  - `library_routes.ts`:
    - `buildFetchPrimitiveFromUrl(config, body, run)` — requires `config.libraryPath`? **No** — a fetch needs no library; but the route family is library-scoped, so decide whether to gate on `configured` (lean: allow fetch even when the library is unconfigured, since the user may be fetching *before* setting up — but the subsequent create needs the library; settle in impl, lean ungated). Forward `{url}` to the bridge; `NETWORK_TIMEOUT_MS` (D2); **no write lock** (D2). Validate the response with `parseFetchedPrimitive`.
    - Extend `buildCreatePrimitive` (`:956`) to accept an optional `imported` in the body and forward it to the bridge args (alongside `path/kind/name/created_at`). Absent → unchanged.
    - Register `POST /api/library/import/fetch` (or `/api/library/primitives/fetch` — settle the path; lean `/api/library/import/fetch` to keep it off the `:kind/:name` primitive namespace, mirroring how `/search` got its own prefix). **POST not GET** — it carries a URL body and egresses (a write-shaped Origin-guarded verb is correct for an egress action even though it's read-semantics; this also gets the `server.ts` Origin check for free, defending the egress trigger against drive-by CSRF).
    - `statusForCode`: add `library_unsupported_source_url`→422, `library_fetch_failed`→502, `library_bundle_invalid`→422, `library_github_rate_limited`→429 (D4 — confirm 429 is acceptable in the map).
  - `NETWORK_TIMEOUT_MS`: reuse Slice 8's constant (confirm it's exported / hoist it if route-local).
- **Affected areas:** `scripts/{library_routes, library_models}.ts`. (No `library_config`/`paths` change — fetch needs no new config; the URL is body-borne, D3.)
- **Dependencies:** Phase 1.
- **Risks:** the URL-in-body posture (D3) — a route test asserts the body URL reaches the bridge `url` arg and that disallowed URLs surface as 422 (the in-core allowlist does the work; the route just forwards). m4: the `FetchFailed` detail (which embeds the URL) is **never** forwarded to the client body (the URL could carry a token in its path) — assert the response body is `{code, message}` only.
- **Validation:** `bun test scripts`:
  - route→bridge arg mapping (`url` forwarded; `imported` forwarded on create when present, omitted when absent);
  - each error code → correct HTTP (incl. 429 if added);
  - **m4 tripwire:** a `FetchFailed` whose detail contains the URL → the response body carries neither the URL nor the detail;
  - **route-local failure:** a bridge fetch failure leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.

### Phase 3: UI — "Import from URL" on the create flow — ✅ DONE (2026-06-12, pending browser QA)
> **Status:** Built. `api.ts`: `fetchPrimitiveFromUrl(url)` (POST `/api/library/import/fetch` via `sendJson` → typed `LibraryApiError`) + `createPrimitive` gains an optional `imported` arg (passed only when present, so the empty-create call stays the unchanged 2-arg form — the existing create test is preserved untouched). `Library.svelte` create modal gains a "From URL (optional)" input + Fetch button → a preview (author / source / content excerpt / "+ N supporting files") → seeded Create. **Stale-fetch guard:** `onUrlInput` clears the stashed preview on every URL edit, so a fetch of URL A then an edit to B never seeds A's content — event-driven, no effect (repo rule). Fetch errors reuse `noticeFor` (the bridge's `message` is already actionable — "unsupported source URL", "GitHub rate limit reached — wait and retry") shown as the inline amber `createNotice`, never a toast; CVD-safe (label-based + amber/cyan, no bare red/green). Tests (`Library.svelte.test.ts`): fetch pre-fills the name + shows the preview + ref-file count, unsupported URL → inline notice (no preview), rate-limited → distinct message, create forwards the seed, and editing the URL invalidates the stash (2-arg create, no stale seed). Gate: `bun run check` fully green — tsc 0, scripts 438, svelte-check 442/0, ui vitest **199 pass** (+5). **Remaining: browser QA** — paste a real public GitHub blob URL + a real SKILL.md folder URL (needs Scott; Claude can't drive the real network fetch or restart the session).

### Phase 3 (original plan): UI — "Import from URL" on the create flow

- **Objective:** Add a URL-paste affordance to the existing create form: fetch → preview (name/author/content + ref-file count) → edit the name → create (seeded).
- **Changes:**
  - `api.ts`: `fetchPrimitiveFromUrl(url)` fetcher (POST `/api/library/import/fetch`, via `sendJson` so the typed error codes surface as `LibraryApiError`); extend `createPrimitive` to accept an optional `imported` payload.
  - `library.ts`: a CVD-safe `Cue` for the fetch states if any state needs a glyph (fetching / fetched-ok / unsupported-url / rate-limited / fetch-failed) — label+glyph+Okabe-Ito tone, **never bare red/green** (Scott is colorblind — global memory). The rate-limited and fetch-failed states are the ones most likely to be color-coded; give them distinct labels + glyphs.
  - `Library.svelte` (the create form `:810-831`): add a URL input + "Fetch" button. On fetch:
    - success → pre-fill `createName` from `suggested_name` (editable), show a read-only preview (author, source_url, content excerpt, and "+ N supporting files" when `ref_files.length > 0`), and stash the `FetchedPrimitive` so create can forward it as `imported`.
    - `library_unsupported_source_url` → an inline field error ("only github.com / raw.githubusercontent.com URLs are supported"), not a toast.
    - `library_github_rate_limited` → a distinct inline notice ("GitHub's anonymous limit — wait and retry").
    - `library_fetch_failed`/`library_bundle_invalid` → the route-wide `EmptyState` error mode (amber + Retry) or an inline notice; **never** echo a raw URL/detail (the body doesn't carry it anyway — m4).
    - On create, if a fetched payload is stashed AND the name is unchanged-or-edited, forward `imported`; if the user cleared the URL/preview, fall back to the empty scaffold (D5).
  - **No `useEffect`** (repo rule): fetch is an event handler (button click); the preview is derived state from the stashed `FetchedPrimitive`; the name pre-fill is set in the fetch handler. No effect-driven sync.
- **Affected areas:** `ui/src/routes/Library.svelte`, `ui/src/lib/{api.ts, library.ts}`.
- **Dependencies:** Phase 2.
- **Risks:** stale-fetch-vs-create coupling — if the user fetches URL A, then edits the URL to B without re-fetching, create must NOT send A's content. Guard: clear the stashed payload when the URL input changes (a derived "preview is stale" state, not an effect). CVD safety on the fetch states.
- **Validation:** `*.svelte.test.ts`:
  - fetch success pre-fills the name + shows the preview + the ref-file count;
  - an unsupported URL shows the inline field error (not a generic toast);
  - rate-limited shows its distinct notice;
  - create forwards `imported` when a fresh preview is stashed, and the empty scaffold when it isn't;
  - editing the URL after a fetch invalidates the stashed payload (no stale content on create);
  - every fetch state is distinguishable by label+glyph, not color.
  - **Browser QA (Scott runs):** `bun start` + paste a real public GitHub blob URL (single-file) AND a real `SKILL.md` URL (folder import) → preview renders, create writes the seeded primitive with provenance. Claude can't restart the CC session or drive the real network fetch.

## Acceptance criteria

- `fetch_primitive_from_url` is ported as a bridge arm + `POST /api/library/import/fetch` route + a create-form affordance; it calls the already-imported `core::fetch_from_url`, makes the network fetch, and returns a `FetchedPrimitive` preview.
- `create_primitive` accepts an optional `imported` payload and seeds the new primitive's content + `metadata.yaml` provenance; the **empty-create path is byte-for-byte unchanged** (regression guard).
- **SSRF boundary:** the in-core `normalize_url` host allowlist (github.com / raw.githubusercontent.com, https-only) is the trust boundary; a tripwire test asserts disallowed hosts/schemes (`http://`, `file://`, link-local `169.254.169.254`, internal hosts, non-github https) → `library_unsupported_source_url` (422) with **no egress** to them.
- **Size/containment limits hold** (in-core, re-stated): per-file 1 MiB, bundle 4 MiB / 200 files (pre-flighted), Skill ref-paths `validate_ref_path`-checked, 10s fetch timeout.
- **No secrets on this path:** the fetch + seeded-create paths construct **no `SecretStore`** (tested assertion); 10b stays off the PAT/keychain path entirely.
- **Where fetched bytes land:** untrusted remote bytes are held in memory during fetch (capped), returned as the preview, and only written to the library *if the user creates* — through the existing `scaffold_primitive` write path (atomic, committed), under the create route's existing posture. A fetch never writes to disk.
- **m4 / no detail leak:** the `FetchFailed` detail embeds the source URL (which could carry a token); it stays server-side — the client body is `{code, message}` only (tripwire test).
- **Route-local failure:** a failed fetch leaves `/api/summary`, `/api/agents`, `/healthz`, doctor at 200.
- Every new UI state is CVD-safe (label+glyph+Okabe-Ito tone, no bare red/green).
- Gates green: `cargo test --workspace` (error mapping + SSRF tripwire + seeded-create + empty-create regression + secrets-free assertion), `bun test scripts` (route mapping + m4 tripwire + new HTTP codes + route-local failure), `*.svelte.test.ts` (fetch-preview-create flow, stale-fetch invalidation, CVD states), `bun run check` / svelte-check / clippy clean.

## Dependencies and risks

- **Depends on:** Slice L (the shipped create path it extends) and Slice 8 (the `NETWORK_TIMEOUT_MS` constant + the proven network-egress + route-local-failure posture). Nothing new must be imported — `url_import.rs` + `reqwest` are already in the dashboard's core.
- **Top risks (ranked):**
  1. **SSRF surface** — mitigated in-core by `normalize_url`'s allowlist; the residual risk is **redirect-following** (Open Q1) — verify reqwest's default redirect policy can't be steered off-allowlist after the initial GitHub response. Even so, GitHub's raw/contents hosts are the only initial targets; a malicious redirect would have to originate from GitHub itself.
  2. **Untrusted-content write** — fetched bytes become a library file on create; they're UTF-8-validated (primary) + size-capped + path-contained (ref-files), but they're still attacker-influenced *content*. They flow through the same `scaffold_primitive` path as any create; no new code interprets them as anything but bytes. The provenance (`source_url`) in `metadata.yaml` records where they came from.
  3. **GitHub rate limit (60/hr anonymous)** — the folder-import path hits the Contents API and can rate-limit; surfaced as the distinct `library_github_rate_limited` code so the UI explains it rather than reading as a generic failure.
  4. **Detail/URL leak** — the `FetchFailed` detail embeds the URL; m4 keeps it server-side. A tripwire guards it.

## Open questions (resolve during impl, non-blocking)

1. **reqwest redirect policy.** Does `core::fetch_from_url`'s reqwest client follow redirects, and if so, can a GitHub response redirect the fetch to a non-allowlisted host (defeating `normalize_url`, which only checks the *initial* URL)? Inspect `reqwest::Client::builder()` in `url_import.rs:96` (no explicit `.redirect(...)` → it uses the default `Policy::limited(10)`). **If redirects are followed, consider `.redirect(Policy::none())` or re-validating each hop's host** — but this is a *core* change, and the dashboard vendored core verbatim; flag it to Scott as a possible upstream hardening rather than forking core here. (The reference app has shipped this as-is; the risk is GitHub-internal-redirect only.)
2. **429 in `statusForCode`.** Slice 8 added 409/422/502; `GitHubRateLimited` wants 429. Confirm adding 429 to the map (correct semantic) vs. folding it into 502 with a distinct code. Lean: add 429.
3. **`Vec<u8>` ref-file wire encoding** — JSON number-array (serde default) vs. base64. Match the existing `WorkingFileBytes` convention so a Skill's binary asset (PNG) round-trips; settle by reading how `WorkingFileBytes` encodes today.
4. **Fetch when library is unconfigured** — allow a fetch/preview before the library is set up (the create afterward needs the library)? Lean: allow the fetch ungated, gate only the create. Settle in Phase 2.
5. **Route path** — `/api/library/import/fetch` (own prefix, off the `:kind/:name` namespace, mirroring `/search`) vs. `/api/library/primitives/fetch`. Lean: `/api/library/import/fetch`.

## References

- Reference command: `~/side_projects/playground/prompt-library/src-tauri/src/commands.rs:330` (`fetch_primitive_from_url`), `:267` (`ImportedPrimitive`), `:282` (`create_primitive` with the `imported` arm).
- Reference core (already vendored): `crates/core/src/url_import.rs` (`fetch_from_url:74`, `normalize_url:417`, `walk_skill_folder:232`, the caps at `:33-36`, `validate_ref_path` use at `:299`), `crates/core/src/error.rs:113-128` (the 4 variants), `crates/core/src/lib.rs:37,63` (module + re-exports), `crates/core/Cargo.toml:21,23` (reqwest + futures already present).
- Dashboard seams to extend: `crates/prompt-library-bridge/src/main.rs` (`cmd_create_primitive:1059`, `map_core_error:2318`, dispatch `:226`, module doc `:31`), `crates/prompt-library-bridge/Cargo.toml` (the egress comment), `scripts/library_routes.ts` (`buildCreatePrimitive:956`, registration `:1621`, `statusForCode`, `NETWORK_TIMEOUT_MS` from Slice 8), `scripts/library_models.ts` (`WorkingFileBytes` convention, `source_url:92`), `ui/src/lib/api.ts` (`createPrimitive:885`), `ui/src/routes/Library.svelte` (create form `:810-831`), `scripts/server.ts:3,64-101` (egress posture).
- Slice 8 (the network posture this rides): `docs/plans/2026-06-12-feat-prompt-library-git-remote-sync-slice-plan.md`.
- Roadmap Slice 10b: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md:217`.

## Next step

`/workflows:work docs/plans/2026-06-12-feat-prompt-library-url-import-slice-10b-plan.md` starting at Phase 1. The plan is standard-depth (the hard security work is already in-core + tested) — the load-bearing additions are the four error-code arms, the SSRF/m4 tripwire tests, and the create-form fetch affordance. Resolve Open Q1 (reqwest redirect policy) early with Scott, since it's the one residual SSRF question the in-core allowlist doesn't fully close on its own.
