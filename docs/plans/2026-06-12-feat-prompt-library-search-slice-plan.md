# Prompt Library Consolidation — Slice 9: Search — Implementation Plan

> **Status: ✅ SHIPPED (2026-06-12)** on branch `feat/library-search`. Pure wiring across 4 seams (core was already done). Gates green: `cargo test --workspace` 648, `bun test scripts` 204, Library vitest 44, svelte-check 0. **A1 discharged** — benched ~50–80ms full spawn against the real 117-primitive library vs the 10s read timeout (>100× headroom), no index needed (open-question #4 closed). One plan correction: `library_unconfigured` maps to **409**, not 502. Manual browser QA (debounce/click/empty/error) still owed — flagged for Scott.

- **Date:** 2026-06-12
- **Type:** feat
- **Roadmap:** [docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md](2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md) — Slice 9 section (lines 166–173)
- **ADR:** [docs/adr/0007-prompt-library-rust-command-bridge.md](../adr/0007-prompt-library-rust-command-bridge.md) (bridge contract, error/HTTP posture)
- **Builds on (shipped):** the read-only slice (PR #4) and every authoring slice since. This slice **extends** the dispatch + envelope, `library_{bridge,models,routes}.ts`, `ui/src/lib/{api.ts,library.ts}`, and `ui/src/routes/Library.svelte` — it **rebuilds nothing**.

## Planning summary

- **Request type:** feature (port one reference command into the dashboard).
- **Planning depth:** minimal-to-standard. This is the roadmap's designated "palate-cleanser": one read-only command, four seams, all established patterns, and the Rust core is **already imported and fully tested** (`crates/core/src/find.rs` ships 10 unit tests). The slice is pure bridge/TS/UI wiring plus one client-side debounce and a result-list UI.
- **Scope:** add `find_in_library` to the dashboard as a **read-only** path — one bridge dispatch arm, a `SearchResult`/`FindHit` model + parser, a `GET /api/library/search?q=` route (NO write mutex), a fetcher in `api.ts`, and a debounced explorer search box in `Library.svelte` whose result rows reuse the existing `selectPrimitive(selectionKey(kind, name))` navigation seam.

## Current state

### Facts (verified at source)

- **The core is done and tested.** `crates/core/src/find.rs:37` exports `find_in_library(layout, query, opts) -> Result<Vec<FindHit>, Error>`, re-exported from `crates/core/src/lib.rs:103` as `pub use find::{find_in_library, FindHit, FindOptions};`. It already ships 10 unit tests (empty-query→empty, line numbers, case-(in)sensitive, sort order, non-UTF-8 skip, **ref-file content excluded** (primary-file-only), long-line truncation). **No core work is needed.**
- **`FindHit` shape** (`find.rs:14-20`): `{ kind: PrimitiveKind, name: PrimitiveName, line_number: u32, line_text: String }`. `FindOptions` (`find.rs:23-26`): `{ case_sensitive: bool }`, `Default` = `false`.
- **Cost discipline is built in:** `MAX_HITS = 500` and `MAX_LINE_LEN = 500` (`find.rs:28-29`) cap output; `line_text` is truncated with `…`. Empty query short-circuits to `Ok(vec![])` (no walk). The walk reads the **working-copy primary file only** (`find.rs:93-94`), never ref files — content cost is one `fs::read` per primitive.
- **Bridge dispatch** (`crates/prompt-library-bridge/src/main.rs:108-177`): currently serves 24 commands across the read/install/working-file/version/overlay/metadata/reimport slices. New arms are added in the `match command` block. Sync read commands take `args: &Value` and return `Result<Value, LibraryError>` with no `.await` (the current_thread runtime is only needed by the async git calls).
- **Arg helpers** exist: `require_library(args)` (`main.rs:920`) resolves + canonicalizes the library root and asserts the `.prompt-library` marker, returning `library_unconfigured` / `library_invalid_path` / `library_marker_missing` on failure. A free-text string arg is read with `args.get("...").and_then(Value::as_str).unwrap_or("")` (the `rel`/`content` pattern, e.g. `main.rs:921`).
- **`map_core_error`** (`main.rs:1295`) already maps `CoreError::Io` → `library_unreadable` and `CoreError::InvalidPrimitiveName` → `library_invalid_name`. `find_in_library` can only surface `Error::Io` (a kind-dir or primary-file read error) — already mapped. **No new error variant is needed.**
- **Route builder pattern** (`scripts/library_routes.ts`): a read builder calls `run(config.bridgePath, "<cmd>", { path: config.libraryPath, ... }, { validate: <parser> })` and returns `r.ok ? { status: 200, body: r.data } : errorResult(r.error)`. Unconfigured short-circuits to `errorResult(UNCONFIGURED)` before the bridge call (`buildLibraryPrimitives`, `:156`). A query param is read in the handler via `c.req.query("...") ?? ""` and threaded as a fn arg (`buildReadWorkingFile` + its registration at `:905-915`).
- **`statusForCode`** (`scripts/library_routes.ts:77`) already maps every code this slice can produce: `library_invalid_kind`→422, `library_unreadable`→502, transport faults / `library_unconfigured`→502. **No mapping change is needed.**
- **Route registration** is in `registerLibraryRoutes` (`scripts/library_routes.ts:864`); reads are `app.get(...)` with NO write lock (the lock lives only in the write handlers).
- **Model parser pattern** (`scripts/library_models.ts`): hand-written parsers from real serde shapes, using `asString`/`asNumber`/`asStringArray` (`:306+`) helpers, a per-element parser, and a list wrapper (`parsePrimitiveSummaries`, `:390`; `parseWorkingFileEntries`, `:685`). Validation failures throw `bridge_bad_output`.
- **UI fetcher pattern** (`ui/src/lib/api.ts`): reads use `getJson<T>(path)` (`getLibraryPrimitives`, `:484`); a query param is `?q=${encodeURIComponent(q)}` (`readWorkingFile`, `:653`).
- **The navigation seam exists.** `selectionKey(kind, name)` (`ui/src/lib/library.ts:58`) → `"kind/name"`; `parseSelection` (`:62`) is the inverse; `selectPrimitive(key)` (`Library.svelte:288`) sets `selected` and resets per-primitive UI state. A search-result click is exactly `selectPrimitive(selectionKey(hit.kind, hit.name))`.
- **There is already a `query` state in the explorer** (`Library.svelte:81`) — but it is a **client-side NAME filter** (`filterPrimitives`, `library.ts:37`), not content search. The new content search is a **separate** input/state; do not overload the existing name filter.
- **`resource()`** (`ui/src/lib/resource.svelte.ts`) keys on a string and refetches on key change + the 30s `dataEpoch` poll. It has no built-in debounce — debounce is the caller's job (a `setTimeout`-backed derived key or a small named hook).

### Assumptions (labeled, non-blocking)

- **A1 — Content search at ~120 primitives is fine without an index.** `find.rs` does one `fs::read` of the primary file per primitive per query, capped at 500 hits. At ~120 primitives that is ~120 small reads per spawn; with a client debounce (≥250ms) the spawn rate is bounded. **Assumption: p99 stays well under the read timeout.** Mitigation: bench against the fixture library before merge; flag if it regresses (roadmap open-question #4).
- **A2 — Case-insensitive is the right interactive default.** `FindOptions::default()` is `case_sensitive: false`; matches the reference's interactive use. The slice ships case-insensitive; a case-sensitive toggle is **out of scope** unless trivially free (the bridge can accept an optional `case_sensitive` arg defaulting false so a future toggle needs no bridge change — cheap, include it).
- **A3 — Results are primary-file-only by design.** `find.rs` deliberately excludes ref-file content (tested at `find.rs:272`). The UI copy should not imply "searches everything" — it searches each primitive's primary working file.
- **A4 — Result→detail navigation reuses selection state.** Clicking a result selects the primitive (loads detail/installs/drift via the existing resources); it does **not** scroll to or highlight the matched line in the editor this slice (line-jump is a nice-to-have, deferred).

### Open questions

- **None blocking.** The one architectural question the roadmap flagged — search cost at scale (#4) — is an A1 assumption with a concrete bench gate, not a design fork. If the bench surfaces a regression, that is a follow-up (an index or a result cap tightening), not a reason to hold this slice.

## Proposed plan

Test-first within each phase. Three thin vertical layers; each is independently testable and the slice is shippable only when all three are green.

### Phase 1 — Bridge dispatch arm (`find_in_library`)

- **Objective:** Expose the already-built core `find_in_library` over the JSON bridge as a sync, read-only command.
- **Changes:**
  - Add `find_in_library` to the core `use` block at `main.rs:43-55` (`FindHit`/`FindOptions` if the bridge constructs them; `find_in_library` is the fn).
  - Add a dispatch arm in the `match command` block (`main.rs:108-177`), grouped with the read commands and commented as read-only/sync: `"find_in_library" => cmd_find_in_library(args),` (no `.await` — pure `std::fs`).
  - Implement `cmd_find_in_library(args: &Value) -> Result<Value, LibraryError>`:
    - `let root = require_library(args)?;`
    - read `query` via `args.get("query").and_then(Value::as_str).unwrap_or("")` (empty → core returns `[]`, so no special-casing).
    - read optional `case_sensitive` via `args.get("case_sensitive").and_then(Value::as_bool).unwrap_or(false)` (A2 — forward-compatible toggle).
    - `let hits = find_in_library(LibraryLayout::new(&root), query, FindOptions { case_sensitive }).map_err(map_core_error)?;`
    - `serde_json::to_value(hits).map_err(serialize_err)`.
  - Add a Rust unit test beside the other `cmd_*` tests in `main.rs`: build a temp library (reuse the existing test scaffolding pattern — `scaffold_skill` + `WorkingCopy::save_base_file`, as `find.rs`'s own tests do), dispatch `find_in_library` with a needle, assert the envelope is `ok:true` with the expected hit shape; assert an empty query yields `ok:true` + `[]`; assert a missing/empty `path` yields `ok:false` + `library_unconfigured`.
- **Affected areas:** `crates/prompt-library-bridge/src/main.rs` (the `use` block, the dispatch match, one new `cmd_find_in_library`, one new test module entry).
- **Dependencies:** none — core is shipped.
- **Risks:** trivially low. The only failure mode is `Error::Io` (already mapped). No write path, no commit, no mutex, no secrets — the secrets-free invariant (`Cargo.toml:12-14`) is untouched.
- **Validation:** `cargo test --workspace` (the new bridge test + the existing `find.rs` tests stay green; assert the no-`SecretStore`-constructed invariant still holds — nothing new links secrets).

### Phase 2 — TS model + route (`GET /api/library/search?q=`)

- **Objective:** Surface the bridge command as a read-only HTTP route returning a typed, validated `SearchResult[]`.
- **Changes:**
  - **`scripts/library_models.ts`:** add the wire model + parser in a new commented section ("Search wire models (search slice)"):
    - `export interface SearchResult { kind: Kind; name: string; line_number: number; line_text: string; }` (mirror `FindHit` exactly — `Kind` is the existing TS kind type used by `PrimitiveSummary`).
    - `function parseSearchResult(v: unknown): SearchResult` using `asString`/`asNumber` (kind via the same path `PrimitiveSummary` uses; `line_number` via `asNumber`).
    - `export function parseSearchResults(v: unknown): SearchResult[]` (array wrapper, mirroring `parsePrimitiveSummaries`/`parseWorkingFileEntries`).
  - **`scripts/library_routes.ts`:**
    - `export async function buildSearch(config: LibraryConfig, query: string, run: Run = runBridge): Promise<LibraryRouteResult>` — short-circuit `if (!config.libraryPath) return errorResult(UNCONFIGURED);`, then `run(config.bridgePath, "find_in_library", { path: config.libraryPath, query }, { validate: parseSearchResults })`, return `r.ok ? { status: 200, body: r.data } : errorResult(r.error)`. **No write lock, no WRITE_TIMEOUT** — this is a read; it uses the default read timeout exactly like `buildLibraryPrimitives`.
    - Register in `registerLibraryRoutes` with the **reads**, before the `:kind/:name` routes to avoid any path-segment ambiguity (it is `/api/library/search`, a distinct prefix, so collision is not actually possible — but keep it grouped with the other `app.get` reads, near `:885`): `app.get("/api/library/search", async (c) => json(c, await buildSearch(loadConfig(), c.req.query("q") ?? "")));`. An absent `q` forwards `""` → core returns `[]` (empty result, 200), never an error.
  - **`scripts/library_models.test.ts`:** parser tests — a valid `FindHit` array round-trips; a malformed element (missing `line_number`, wrong type) throws `bridge_bad_output`; an empty array parses to `[]`.
  - **`scripts/library_routes.test.ts`:** with a stubbed `run`, assert `buildSearch` returns 200 + the parsed results for a happy path; returns `errorResult(UNCONFIGURED)` (→502 via `statusForCode`) when `libraryPath` is null; maps a bridge `library_unreadable` error to a 502 body `{code,message}` (detail not forwarded — m4). Assert the route is a **GET with no lock** (it does not call `withWriteLock`).
  - **Route-local failure assertion:** add/extend the existing tripwire that an erroring library route leaves `/api/summary`, `/healthz` at 200 (the read-only slice's pattern) — a failed search must not bleed into Observability.
- **Affected areas:** `scripts/library_models.ts`, `scripts/library_routes.ts`, `scripts/library_models.test.ts`, `scripts/library_routes.test.ts`.
- **Dependencies:** Phase 1 (the bridge command must exist for an end-to-end smoke, though the route tests stub `run`).
- **Risks:** low. The only subtlety is keeping the route a **read** — no mutex, no write timeout. Stated explicitly so a reviewer doesn't reflexively add the write-safety boilerplate that every recent slice carried.
- **Validation:** `bun test scripts` (model parser + route mapping + no-lock + route-local-failure).

### Phase 3 — UI: debounced explorer search box + result list

- **Objective:** Add a content-search input to the explorer whose debounced query drives a result list; clicking a result selects the matched primitive via the existing navigation seam.
- **Changes:**
  - **`ui/src/lib/api.ts`:** `export const searchLibrary = (q: string) => getJson<SearchResult[]>(`/api/library/search?q=${encodeURIComponent(q)}`);` (the `getJson` read pattern; `SearchResult` imported from the api.ts model mirror, consistent with how the other library models are mirrored UI-side).
  - **`ui/src/routes/Library.svelte`:**
    - A new, **separate** state from the existing name `query` (`:81`) — e.g. `let searchTerm = $state("")` and a **debounced** derived key. Because the repo forbids raw `useEffect`/effects (CLAUDE.md), debounce via a small named helper, NOT a bare effect: a `$state` `debouncedTerm` updated from an input `oninput` handler that schedules a `setTimeout` (clearing the prior timer), or a tiny `useDebounced`-style hook in `ui/src/lib/` wrapping the timer. The `resource()` key is `() => debouncedTerm.trim() === "" ? "library:search:idle" : `library:search:${debouncedTerm}`` so an empty term short-circuits to no fetch.
    - `const searchRes = resource(() => /* keyed as above */, (k) => k.endsWith(":idle") ? Promise.resolve([]) : searchLibrary(debouncedTerm));` — gated on `status` like the other library resources (only fetch when the library is configured/valid; reuse the existing `gate(...)` helper pattern).
    - A result list rendered below the search box (or in a dedicated panel region): each row shows `kind` (with the existing `kindTone` cue), `name`, `line_number`, and the truncated `line_text` (mono). An empty-state when the (non-idle) result set is empty ("No matches"), and the shared `EmptyState` error mode on a fetch error (consistent with the rest of the route). Rows are `onclick={() => selectPrimitive(selectionKey(hit.kind, hit.name))}` — reuse `selectionKey` (already imported, `:44`).
    - **No useEffect** for any of it — the debounce is timer-in-an-event-handler; the refetch is `resource()` key-driven; reset-on-blur/clear is an event handler.
    - **CVD-safe** (Scott is red/green colorblind, global memory): result rows reuse the existing `kindTone` (accent/cyan/amber/default — no red/green pairing); the matched-line emphasis is weight/glyph, not color.
  - **`ui/src/routes/Library.svelte.test.ts`:** component tests — (a) typing a term debounces (only one fetch fires after the wait, not per keystroke — use fake timers); (b) an empty/whitespace term fetches nothing and shows no result list; (c) results render with kind/name/line; (d) clicking a result calls `selectPrimitive` with the right key (assert `selected` becomes `"kind/name"`); (e) the empty-state shows on a non-idle empty result; (f) a fetch error shows the error EmptyState, not a blank panel.
  - **`ui/src/lib/library.test.ts`:** if a `useDebounced`-style helper lands in `library.ts` (pure), unit-test its timer coalescing; otherwise the debounce is tested via the component test above.
- **Affected areas:** `ui/src/lib/api.ts`, `ui/src/routes/Library.svelte`, optionally `ui/src/lib/library.ts` (+ its test), `ui/src/routes/Library.svelte.test.ts`.
- **Dependencies:** Phase 2 (the route + fetcher).
- **Risks:** (a) **debounce correctness without an effect** — the timer must be cleared on each keystroke and on unmount; prefer a small named hook so the lifecycle is explicit and testable. (b) **not overloading the existing name filter** — keep the content search a distinct input/state so the explorer's name-filter behavior is unchanged. (c) **selection side-effects** — `selectPrimitive` resets publish/overlay/reimport surfaces (`:288-303`); that is the desired behavior on a result click (a fresh primitive), so reuse it as-is.
- **Validation:** `bun run check` (tsc + svelte-check + vitest) green; the Library component tests above pass; manual browser QA (typed query debounces, results render, click selects, empty + error states) — flagged for Scott since I can't restart the CC session to drive a live `bun start`.

### Phase 4 — Cost bench + sign-off (A1)

- **Objective:** Discharge the one labeled assumption (A1) with a measurement, per the roadmap's cost-discipline note.
- **Changes:** No production code. Run `find_in_library` against the fixture library (the committed `seed_fixture_library` example / fixture corpus the read-only slice established) at a realistic primitive count, measure single-spawn wall time, and record it (a one-line note in MEMORY.md or the slice's "verified" entry). If p99 per query (including spawn) is comfortably under the read timeout at ~120 primitives, A1 holds and the slice ships. If it regresses, file a follow-up (tighten `MAX_HITS`, add a result cap, or an index) — do not block the slice on a non-regression.
- **Affected areas:** none (measurement only).
- **Dependencies:** Phase 1 (the bridge command to spawn).
- **Risks:** none — this is a measurement gate.
- **Validation:** recorded bench number; assumption A1 marked discharged or a follow-up filed.

## Acceptance criteria

- `find_in_library` is dispatched by the bridge as a sync, read-only command; `cargo test --workspace` passes including a new bridge round-trip test (needle→hit, empty-query→`[]`, unconfigured→`library_unconfigured`), and the existing `crates/core/src/find.rs` tests stay green.
- `GET /api/library/search?q=<term>` returns `200` + a validated `SearchResult[]`; an absent/empty `q` returns `200` + `[]`; an unconfigured library returns the `UNCONFIGURED` error (→502); a bridge read fault returns `502` with a `{code,message}` body (no `detail` forwarded). The route takes **no write lock** and uses the **read** timeout.
- A malformed bridge payload throws `bridge_bad_output` in the parser (tested).
- The explorer has a **content** search box, distinct from the existing name filter; its query is client-side **debounced**; results render kind/name/line_number/line_text with CVD-safe cues; clicking a result selects the matched primitive (`selected === "kind/name"`).
- No `useEffect` is introduced; debounce is timer-in-event-handler (or a named hook); refetch is `resource()`-key-driven.
- A failed search leaves `/api/summary` and `/healthz` at 200 (route-local failure, tested).
- The bridge remains `prompt-library-secrets`-free and network-free (no new link, no `SecretStore` constructed).
- `bun run check` (tsc + test + svelte-check) is green; A1 (cost at ~120 primitives) is benched and discharged or followed up.

## Risks and dependencies

- **Cost at scale (A1):** the only real risk, and it is bounded — capped output (`MAX_HITS=500`), primary-file-only reads, a client debounce, and a measurement gate (Phase 4). Likely fine at ~120 primitives; flagged, not assumed-away.
- **Debounce without an effect:** repo rule forbids raw effects; the mitigation (named timer hook / event-handler timer) is explicit in Phase 3 and unit-tested.
- **Don't conflate with the existing name filter:** the explorer already has a `query` name-filter; the content search is a separate input/state. Stated so a reviewer doesn't read it as a rewrite of the filter.
- **Dependencies:** only the read-only slice's seams (all shipped). Fully independent of and parallelizable with Slice L (lifecycle) and Slice 8 (git sync). No core, no schema, no secrets, no network.

## References

- Reference command to port: `prompt-library/src-tauri/src/commands.rs:1274` (`find_in_library`) — strip `State`/`blocking`, resolve the root from `require_library(args)`.
- Core (shipped, tested): `crates/core/src/find.rs:37` (`find_in_library`), re-exported `crates/core/src/lib.rs:103`.
- Bridge seams to extend: `crates/prompt-library-bridge/src/main.rs` — dispatch match `:108-177`, `require_library` `:920`, `map_core_error` `:1295`.
- TS seams to extend: `scripts/library_models.ts` (parsers `:380-695`), `scripts/library_routes.ts` (read builders `:146-181`, `registerLibraryRoutes` `:864`, `statusForCode` `:77`), `scripts/library_models.test.ts`, `scripts/library_routes.test.ts`.
- UI seams to extend: `ui/src/lib/api.ts` (read fetchers `:481-489`, query-param read `:653`), `ui/src/lib/library.ts` (`selectionKey` `:58`, `parseSelection` `:62`), `ui/src/routes/Library.svelte` (explorer `:777+`, `selectPrimitive` `:288`, `resource` usage `:62+`), `ui/src/routes/Library.svelte.test.ts`.
- Roadmap: `docs/plans/2026-06-11-feat-prompt-library-consolidation-remaining-slices-roadmap-plan.md` (Slice 9, lines 166–173; open-question #4 on search cost, line 239).

## Next step

This plan is detailed enough to execute directly — the core is shipped, all four seams are established patterns, and there is no unresolved architectural fork. Recommended: `/workflows:work docs/plans/2026-06-12-feat-prompt-library-search-slice-plan.md`. Deepening is optional and would mostly confirm the exact line-text mirroring of `find.rs` — already captured here.
