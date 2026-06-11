# Prompt Library Rust command bridge

Prompt Library will be consolidated into the dashboard in stages: first by bringing the Prompt Library Rust crates into this repo and preserving them as the source of truth for **Primitive**, **KindTarget**, materialization, **Install record**, **Drift**, bootstrap, git, and secrets behavior; then by rebuilding the UI in Svelte inside the dashboard shell. The dashboard's Bun/Hono backend will call a small Rust command bridge over JSON stdin/stdout and expose dashboard-local HTTP APIs to the Svelte UI. The file-backed **Library** format remains authoritative; dashboard SQLite may cache or index Library data but does not own it.

This work is a separate **Library consolidation track**, not Phase 5 and not a rewrite of the existing Observability/Operations phase sequence.

The actionable staging plan lives in [Library Consolidation Track](../library-consolidation-track.md).

## Status

accepted

Amended by [ADR-0008](0008-dashboard-replaces-standalone-app-install-state-ownership.md): the dashboard replaces (does not coexist with) the standalone app, and **Install records** and **Drift** are deferred out of the first read-only slice because the read-only dashboard owns no install state. The first-slice read-model gate is kind-info/target-info/list/detail; everything else in this ADR stands.

## Context

Prompt Library already encodes the difficult filesystem and install invariants in tested Rust crates. The dashboard already has a Bun/Hono/Svelte architecture and its own SQLite database for observability data, so the integration problem is how to reuse that core without making the dashboard UI talk to Rust directly, rewriting the domain model in TypeScript, or moving Library ownership into dashboard SQLite. Runtime dependency on a sibling `prompt-library` checkout is rejected; the standalone app remains a reference implementation until dashboard parity, not a required dependency.

## Decision

Import the Prompt Library `core`, `git`, and `secrets` Rust crates into `agent-dashboard`, create a root Cargo workspace with `crates/` and `Cargo.toml`, create a small Rust bridge binary around them, and call it from the existing TypeScript backend. Do not import the Tauri shell or React app. Prefer short-lived command invocations first; consider a native binding or long-running service only if bridge startup cost or interaction latency becomes a measured problem.

The TypeScript backend resolves the bridge binary from config, with a sensible local default of `target/debug/prompt-library-bridge` in this repo.

Bridge and route errors are normalized into dashboard Library error codes wrapping Rust details, rather than exposing Rust-native error text as the UI contract.

TypeScript contracts for the first coarse read models are hand-written and protected by tests/fixtures. Generated bindings are deferred unless the bridge grows into a broader Rust API surface.

The first read-only backend slice is complete when `cargo test --workspace` passes for the imported crates and bridge, `bun test scripts` covers Library config loading, bridge invocation, error mapping, and `/api/library/*` route behavior with fixture bridge output, and at least one fixture Library from the Prompt Library test corpus verifies kind-info/target-info/list/detail read models. Svelte UI completion is separate unless the slice explicitly includes the route.

The first Svelte Library route is complete only after a prototype pass for the overview/detail information architecture, in-browser verification across desktop/mobile, and focused component tests for filtering, empty/error states, and selected Primitive detail rendering.

Keep the existing file-backed **Library** layout as the source of truth. Dashboard SQLite can hold derived indexes or caches for performance and observability joins, but it must not own authored Library content. The existing `skills` table remains an Observability/discovery table for installed `SKILL.md` files, not a Library content store. All Library writes go through the Rust core and land in the Library directory, dashboard-owned install state, or install roots as appropriate.

Keep the imported Rust crates' existing names initially (`prompt_library_core`, `prompt_library_git`, `prompt_library_secrets`) to avoid mixing consolidation with rename churn. The bridge exposes coarse dashboard read-model commands for the first slice, not a raw RPC mirror of every Rust core function.

The first bridge/API slice is read-only: configure/open a **Library**, read the Rust-projected **Kind** / **Target** capability table, list **Primitives**, read **Primitive** detail, inspect **Working copy**, **Versions**, metadata-declared allowed **Targets**, and lightweight git status. **Primitive detail** returns metadata and structure first; file bytes are loaded on demand when the user opens a file/tab. Save/install/publish flows come only after this read path proves the bridge contracts, path handling, and Svelte information architecture. Sourcing/import flows, including **Folder import** and URL import, are deferred because they create or alter **Primitives**. Per-target **Install records** and **Drift** are deferred to the write/install slice per ADR-0008, when the dashboard owns `DATA_DIR/installs.json`; they are not read from the standalone app and not synthesized from empty state. Git status is informational only: branch, remote configured, unpushed count, and dirty/untracked summary if already available through the imported crates; pull/push/conflict flows wait for later write stages. The first Svelte UI is dashboard-native overview/detail, not a direct recreation of Prompt Library's three-pane editor shell; prototype that route before committing the production UI. The route is Primitive-first and shows all **Kinds** equally rather than prioritizing `Skill`. Bridge/API contracts keep Prompt Library **Target** values (`Claude`, `Pi`, `Codex`) rather than normalizing them to dashboard **Agent** ids. Antigravity is an observed dashboard **Agent**, but it is not a Prompt Library **Target** until the Rust install matrix defines concrete Antigravity install semantics. Prompt Library's explicit folder-selection model remains, but the dashboard starts with a Library path in `config/library.yaml` rather than a native folder picker because it runs as a localhost web app, not a Tauri shell. Environment variables may override the configured path for development, but they are not the primary persisted setting.

Library read failures are Library-route-local states. Missing config, invalid path, missing `.prompt-library`, unreadable Library, and bridge command failure should surface under `/api/library/*` and the Library route, while the Observability layer remains usable.

The first slice may include read-only cross-links from Library **Primitives** to Observability data where identity is reliable. `Kind=Skill` can link to existing skill invocation/economics surfaces by Skill name; other **Kinds** should not claim usage data until adapters or logs expose trustworthy identities. Observability metrics remain derived usage data, not Library state.

## Considered and rejected

- Port the Prompt Library core to TypeScript. Rejected because it duplicates tested install-path, materialization, drift, and git/secrets semantics before consolidation reaches parity.
- Call the sibling `~/side_projects/playground/prompt-library` checkout at runtime. Rejected because full consolidation should not depend on a second local repo being present or in lockstep.
- Import only `crates/core` first. Rejected because lightweight git status and later write parity already depend on the existing `git` and `secrets` crate boundaries.
- Import the Tauri shell or React app. Rejected because the dashboard keeps its Bun/Hono/Svelte shell and only imports the Rust domain/backend crates.
- Put the imported crates under a nested Rust workspace. Rejected because a root Cargo workspace keeps `cargo test --workspace` and bridge builds conventional.
- Hardcode the bridge binary path to one build output. Rejected because dev and packaged environments may differ; config provides the escape hatch while the repo-local debug binary remains the default.
- Expose Rust-native error strings as the dashboard API contract. Rejected because the Svelte UI needs stable Library error codes while Rust details remain diagnostic context.
- Rename imported Rust crates during the first import. Rejected because crate names can be cleaned up later, while the first step needs low-churn parity with the reference implementation.
- Mirror every Rust core function as a bridge command. Rejected because the bridge is an integration boundary with dashboard-shaped JSON, not an internal Rust API exposure mechanism.
- Generate TypeScript bindings for the first bridge contracts. Rejected for now because the initial surface is deliberately small and dashboard-shaped; fixtures/tests are enough to hold the JSON contract.
- Move Prompt Library state into dashboard SQLite. Rejected because the existing Library format is versioned on disk, git-friendly, and owns authored working copies and versions; install state remains file-backed state owned by the Rust core once write flows arrive. SQLite may hold only derived indexes/caches.
- Use the existing `skills` table as the Prompt Library store. Rejected because it is an Observability/discovery table populated by scanning installed `SKILL.md` files, not a source-of-truth model for authored **Primitives** across **Kinds** and **Targets**.
- Cache or synthesize Drift before the dashboard owns install state. Rejected because Drift is a filesystem comparison against **Install records**; premature caching or empty-state synthesis would add invalidation semantics and misleading UI before write/install flows exist.
- Include all Working copy and Version file bytes in every Primitive detail payload. Rejected because the first route is an overview/detail read model; file bytes are loaded on demand and later become editor data.
- Start with mutating Library flows. Rejected because the first consolidation slice should prove the bridge and UI contracts before the dashboard can write to Library files or install roots.
- Include Folder import or URL import in the first slice. Rejected because sourcing/import flows create or alter Primitives and belong with later write stages.
- Include pull/push/conflict git flows in the first slice. Rejected because lightweight status is useful read-only context, but mutating git belongs with later write stages.
- Recreate the full Prompt Library editor shell as the first Svelte UI. Rejected because overview/detail fits the read-only slice and the dashboard shell; full editor ergonomics belong with write flows.
- Prioritize `Skill` in the Library route because the dashboard already has a Skills page. Rejected because the Library layer is Primitive-first across `Skill`, `Agent`, `Command`, and `CodexAgent`.
- Normalize Target names into dashboard Agent ids. Rejected because **Targets** are install destinations and **Agents** are log-ingested CLIs; cross-links can map between them explicitly when needed.
- Start with a native folder picker. Rejected because the dashboard is not a Tauri app; first slice validates a configured Library path instead.
- Store the active Library path only in an environment variable or in SQLite. Rejected because environment-only is too invisible for a persistent local app setting, and SQLite would imply ownership by the observability database rather than dashboard config.
- Put the Library path in `agents.yaml` or `prices.yaml`. Rejected because those files own Agent registry and rack-rate cost concerns; the Library layer gets `config/library.yaml`.
- Treat Library configuration or bridge failures as global dashboard health failures. Rejected because the Observability layer should remain usable when the Library layer is unconfigured or broken.
- Attach observability usage metrics directly to Library state. Rejected because usage is derived Observability data; Library Primitives may cross-link to it only where identity is reliable.
- Start with N-API, FFI, or Bun native bindings. Rejected because the value is not worth the integration complexity while the API shape is still settling.
- Start with a long-running Rust sidecar service. Rejected until there is measured need; a command bridge is simpler to test, debug, and replace.

## Consequences

- The Svelte dashboard UI talks only to dashboard HTTP APIs.
- Rust remains the source of truth for Library-layer invariants during consolidation.
- The process boundary must have explicit typed JSON contracts and good error mapping so backend routes do not depend on ad hoc stdout parsing.
