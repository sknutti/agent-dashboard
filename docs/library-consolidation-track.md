# Library Consolidation Track

Prompt Library is being consolidated into Agent Dashboard as a separate **Library layer**. This is not Phase 5 and does not renumber the existing Observability/Operations phases.

## Direction

- Full consolidation, staged.
- The standalone Prompt Library app remains the reference implementation until dashboard parity.
- The dashboard keeps its Bun/Hono/Svelte shell.
- Prompt Library `core`, `git`, and `secrets` Rust crates move into this repo under a root Cargo workspace.
- The file-backed **Library** remains the source of truth; dashboard SQLite may cache or index derived data only.

## Architecture

- Svelte UI calls dashboard HTTP APIs.
- Hono routes under `/api/library/*` call a TypeScript bridge wrapper.
- The wrapper invokes a Rust command bridge over JSON stdin/stdout.
- The bridge uses the imported Prompt Library crates.
- Native bindings or a long-running Rust service are deferred until there is measured need.

## First Backend Slice

Read-only only:

- Configure/open a **Library** from `config/library.yaml`.
- Validate the `.prompt-library` marker.
- Read the Rust-projected **Kind** / **Target** capability table so the dashboard does not maintain a second install matrix.
- List **Primitives** across all **Kinds**.
- Read **Primitive** metadata and structure.
- Load file bytes on demand only.
- Inspect **Working copy**, **Versions**, and metadata-declared allowed **Targets**.
- Include lightweight read-only git status where already available.
- Provide read-only cross-links to Observability data where identity is reliable, especially `Kind=Skill` usage by Skill name.

Out of scope:

- Save, install, publish, uninstall, reset, reimport, import, or URL/**Folder import** flows.
- Pull, push, conflict resolution, or other mutating git flows.
- Native folder picker.
- SQLite ownership of Library state.
- Per-target **Install records** and live **Drift**. They return with the write/install slice, once the dashboard owns `DATA_DIR/installs.json`.
- Full editor UI.

## First UI Slice

- Add a top-level Library route.
- Use the selected **Variant B - Explorer detail** information architecture from the throwaway `/library-prototype` route: grouped Primitive explorer, central read-only Working copy/detail surface, and right-side status rail.
- Show all **Kinds** equally: `Skill`, `Agent`, `Command`, and `CodexAgent`.
- Keep Prompt Library **Target** values (`Claude`, `Pi`, `Codex`) instead of normalizing them to dashboard **Agent** ids.
- Antigravity is an observed dashboard **Agent**, but it is not a Prompt Library **Target** until the Rust install matrix defines concrete Antigravity install semantics.
- Prototype verdict: Variant B won because it best matches the future editor flow without requiring mutating controls in the read-only slice.

## Contracts

- Bridge commands are coarse read models, not one command per Rust function.
- First commands likely include `library_status`, `kind_info`, `target_info`, `list_primitives`, and `primitive_detail`; `scan_drift` is deferred to the write/install slice.
- TypeScript interfaces are hand-written for the first read models and protected by fixtures/tests.
- `/api/library/*` exposes dashboard-normalized error codes wrapping Rust details.
- Library read failures are route-local states, not global dashboard health failures.

## Completion Gates

Backend slice:

- `cargo test --workspace` passes.
- `bun test scripts` covers Library config loading, bridge invocation, error mapping, and `/api/library/*` route behavior using fixture bridge output.
- At least one fixture Library from the Prompt Library test corpus verifies kind-info/target-info/list/detail read models.

UI slice:

- Prototype pass for the overview/detail information architecture.
- Browser verification across desktop and mobile.
- Focused component tests for filtering, empty/error states, and selected **Primitive** detail rendering.
