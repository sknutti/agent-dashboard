# Phase 0 — Foundation

> Status: Planned · Depends on: — · Master refs: §10.1, §10.4, §10.5, §13, §14, §21, §22 · Decisions: [ADR-0001](../adr/0001-typescript-svelte-bun-stack.md), [ADR-0002](../adr/0002-uniform-rack-rate-estimated-cost.md)

## Goal

Stand up the agent-agnostic substrate every later phase rides on — and prove it runs — **without any agent-specific logic**. Phase 0 ends as a *runnable-but-empty skeleton*: the server is up under launchd, the full observability schema exists, the OTEL endpoints persist a synthetic event, and the Svelte shell renders empty states. No adapter, no real data.

## In scope

- **Stack scaffolding (ADR-0001):** Bun + Hono server, `bun:sqlite` (WAL) connection, Svelte 5 SPA built by Vite and served by Hono, single always-on process, ingest worker-thread harness.
- **Full observability schema** (`db.ts`), all `CREATE TABLE IF NOT EXISTS` + idempotent `migrateAddColumn(table, col, type)`:
  - `sessions` — incl. `agent`, `fidelity` (**token fidelity only** — cost fidelity is implicit by which cost column is populated; [ADR-0003 gap #1](../adr/0003-agent-first-ui-with-drilldowns.md)), `cost_usd` (native, nullable), `cost_estimated_usd` (rack-rate, nullable), token columns **incl. `reasoning_tokens`** (nullable — Codex `reasoning_output`, Antigravity f9; gap #2), `cwd`, `model`, `started_at`/`ended_at`, etc. (master §14 + ADR-0002 columns).
  - `token_usage` — rollup key `(date, agent, model, source)`.
  - `tool_calls` — incl. `agent`; index `(agent, tool_name, ts)`.
  - `burn_daily` — `(date, agent)` PK, `tokens`, `cost_usd`, `cost_estimated_usd`, `fidelity`, `driver`, `evidence` (master §11.2 + estimated col).
  - `otel_events`, `otel_metrics` (+ optional `otel_spans`).
- **`AgentAdapter` contract** (`adapters/base.ts`) — the TypeScript interface (not yet implemented), **designed against all four field maps** (master §10.2). Must express: `agentId`, `displayName`, `fidelity`, `enabled`, `sessionGlob()`, `parseSession(path)` → normalized events, `supportsOtel()`. Normalized event shape must accommodate **optional cost, tree/branch metadata, and tokens sourced from a non-JSONL file** — even though no Phase 0 code uses them.
- **Orchestrator shell** (`sync_agents.ts`) — runs every 120s over an **empty** adapter registry (no-op), in the worker thread, proving the worker + WAL write path with a heartbeat row.
- **OTEL ingest endpoints** — `POST /v1/logs`, `/v1/metrics`, `/v1/traces`; OTLP/HTTP JSON; per-row try/except; **always return 200**; persist to `otel_events`/`otel_metrics`. Accept both bare and `claude_code.`-namespaced `event.name` (master §12, §15).
- **Config** — `config/agents.yaml` (empty/auto-detect scaffold) + **stub `config/prices.yaml`** (price-table structure, no rates wired yet) per ADR-0002.
- **Svelte shell** — 3-route nav (`/`, `/activity`, `/skills`), AppShell, theme tokens (master §22 palette), shared primitives (`CollapsibleSection`, `Sheet`, `Card*`, `Badge`, `StatePill`, `Tooltip`, `CommandPalette` ⌘K; plus — validated in `/prototype` — an inline **`<details>` accordion** for row expansion, an **info-modal** affordance reusing `Sheet`, and an **icon-only fidelity badge** + **OTEL on/off indicator**). Panels are deliberate **empty states** ("no data yet"). **Drill-down is a first-class pattern** ([ADR-0003](../adr/0003-agent-first-ui-with-drilldowns.md)): a clickable card cell → filtered detail (`Sheet`/route over a filtered session list → session detail). Build the empty `Sheet`-detail plumbing now so Phase 1 only fills it.
- **Minimal SystemHealthStrip** + `GET /api/system/health` (uptime, last-OTEL-event age, last-sync-tick age, tzname) + `GET /api/health`.
- **launchd** user LaunchAgent (`RunAtLoad`, `KeepAlive`, `ThrottleInterval`) + `cc` shim (`start`/`stop`/`restart`/`doctor`/`sync`/`logs`) + `cc doctor` (zero-LLM health checks).

## Out of scope

- Any concrete adapter or real log parsing (Phase 1+).
- The rack-rate cost *computation* (Phase 1 — only the column + stub config here).
- Any panel showing real data; any `ops_*` table or operations feature (Phase 6).

## Dependencies

None. This is the root.

## Deliverables

`scripts/server.ts`, `scripts/db.ts`, `scripts/sync_agents.ts` (shell), `scripts/adapters/base.ts`, `config/agents.yaml`, `config/prices.yaml` (stub), `ui/` (Svelte shell + primitives + empty panels), `templates/launchd/com.commandcentre.server.plist.template`, `cc` shim, `scripts/doctor.ts`, `install.sh` (skeleton).

## Key decisions

- Schema is built **complete for observability now** so phases 1–4 never re-migrate (invariant #1).
- Interface designed against all four field maps now, finalized with Claude in Phase 1 (invariant #2; ADR rationale: we already have all four real shapes, so this isn't speculative).
- Single always-on process + worker-thread ingest (ADR-0001) — proven here with the no-op orchestrator.

## Interface / schema / API detail

See master §14 (schema columns), §10.1 (adapter interface — port the `Protocol` to a TS `interface`), §10.5 (orchestration), §13 (project layout — translate Python paths to TS), §15 (OTEL ingest semantics), §22 (visual tokens). ADR-0002 adds `cost_estimated_usd` to `sessions` and `burn_daily`.

## Stop conditions

1. `./install.sh` runs clean on a fresh dir; launchd service loads.
2. Kill the server process → launchd restarts it within seconds.
3. `curl` a hand-crafted OTLP/JSON event to `/v1/logs` → row appears in `otel_events`; endpoint returns 200.
4. `localhost:8765` loads; all three routes render; panels show proper empty states (no spinners-only, no layout jumps).
5. The 120s orchestrator tick writes a heartbeat row from the worker thread (proves worker + WAL).
6. `cc doctor` exits 0, all green; `/api/system/health` renders.

## Verification (demo)

`cc doctor` green → kill the process, watch launchd revive it → `curl` a synthetic OTEL event and see it in SQLite → open the empty shell at `localhost:8765`. No agent involved.

## Risks & open questions

- **Interface over-fitting:** designing `AgentAdapter` before a running implementation risks baking in wrong assumptions. Mitigation: it's a *contract* here, *finalized* against the real Claude adapter in Phase 1 (decision (ii)).
- **`bun:sqlite` in a worker thread + WAL** — confirm the worker opens its own connection and concurrent main-thread reads don't block. Validate early.
- Svelte ⌘K palette + `CollapsibleSection` are React-component ports from the master spec — confirm Svelte equivalents (transitions vs framer-motion) match the §22 motion spec.
