# Phase 1 — Claude Code

> Status: Planned · Depends on: 0 · Master refs: §8, §10.1, §10.2 (claude_code), §11, §12.2, §12.3, §15, §16, §17 · Decisions: [ADR-0001](../adr/0001-typescript-svelte-bun-stack.md), [ADR-0002](../adr/0002-uniform-rack-rate-estimated-cost.md)

## Goal

Ship the first real, useful dashboard: a complete **read-only observability view for Claude Code** across the **core panels**, with **Burn** (single-agent) and the **rack-rate cost engine** live. This is also where the `AgentAdapter` interface is **finalized** against a running implementation.

## In scope

- **Claude Code adapter** (`adapters/claude_code.ts`) — the reference JSONL parser, implementing the Phase 0 `AgentAdapter` contract; glob `~/.claude/projects/*/*.jsonl`. Stash `tool_use` by id, pair `tool_result` (cap duration at 10 min), roll up tokens by model with `DATE(timestamp,'localtime')` bucketing, upsert `sessions` on end / re-parse while `ended_at IS NULL` or mtime > `synced_at` (master §15). Native cost from `result.total_cost_usd`.
- **Finalize the `AgentAdapter` interface** — adjust the Phase 0 contract against this running adapter; re-confirm it still cleanly admits the Codex/Pi/Antigravity shapes on paper (master §10.2).
- **Rack-rate cost engine** (ADR-0002) — wire `config/prices.yaml` with real per-model rates; compute `cost_estimated_usd = Σ(tokens × list price)` per session/day for Claude. Claude carries **both** `cost_usd` (native) and `cost_estimated_usd` (rack-rate) → enables the subscription-savings delta.
- **Claude OTEL** — `setup_otel.ts` wizard (back up `settings.json`, add only the 6 missing env keys; master §8); ingest `claude_code.*` metrics/logs/traces; apply the **OTEL-first / JSONL-fallback** coalescing rule per dimension (master §12.3). MCP attribution from `mcp_server.name`/`mcp_tool.name` with JSONL `mcp__server__tool` fallback.
- **Core panels** (master §17), Claude data only:
  - **Live sessions** (`/api/sessions/live`, 5-min window) + detail drawer.
  - **Token usage** (`/api/usage/tokens`) — stacked daily, today/7d/30d; per-agent series scaffolded (one agent now).
  - **Tool latency** (`/api/tools/latency`) — p50/p95/max/error, sort by p95.
  - **MCP drill-down** (`/api/mcp`, `/api/mcp/{server}/tools`) — **the centerpiece**; per-server → per-tool p50/p95/max/err; make it excellent.
  - **Session outcomes** (`/api/sessions/outcomes`) — mutually-exclusive daily buckets summing to total.
  - **Cache efficiency** (`/api/usage/cache`) — hit rate, 70% target, low-sample badge.
  - **Burn** (`/api/burn`) — single-agent: daily heatmap (log scale), trend, drivers, scale-equivalents (with visible math), moving-average table. Tokens exact; shows native + `estimated`-badged rack-rate.
- **KpiRow** (`/api/summary`) — today's sessions/tokens/tools/errors.

### Information architecture (from the `/prototype` exploration — [ADR-0003](../adr/0003-agent-first-ui-with-drilldowns.md))

- **Agent-first command page.** The primary grid is **per-agent cards** (Phase 1 = one card: Claude; the layout already takes four). Each card: tokens (with a **reasoning** segment in the mix bar, gap #2), cost (native + estimated, gap #1 — each figure badged by its own fidelity), sessions/tools/**errors**, cache, OTEL status. Shared **Burn** + **Live sessions** below.
- **Grafted panels:** full **Tool latency** panel (from prototype variant A) and **Subscription savings** panel (native − estimated, from variant C).
- **Click-through drill-downs (read-only):** card cells link to filtered detail — errors → `GET /api/sessions?agent=claude_code&outcome=errored` → list → `GET /api/sessions/{id}/details` (the errors, to go address them yourself); tokens → that agent's session list; tools → tool breakdown. Opens via the Phase 0 `Sheet`/route plumbing.
- **Boundary:** drill-down only *shows*; acting on findings (re-run/dispatch) is **Phase 6**. Leave room in the cell affordance for a Phase 6 "act" button — don't wire one now.
- **Fidelity per figure:** badge tokens by `sessions.fidelity` (exact) and cost by which column is populated (native=exact, estimated=estimated) — never a single per-card badge.

### Validated affordances (from the `/prototype` iterations)

These are the concrete panel behaviors confirmed in the prototype — build to them:

- **Fidelity badge = icon only** (`✓` exact / `~` estimated), a small chip with a hover tooltip; never inline text.
- **Token-mix composition is a hover tooltip** on the bar (input·output·**reasoning**·cacheR·cacheC), not always-on text. The bar shows the segments; the breakdown is on hover.
- **Every Activity item drills down** — sessions, tools, errors, **and** Pi `branches` (the branches drill explains the sum-all-branches rule). Read-only (Phase 6 adds "act").
- **Cache panel has an info affordance** — an `ⓘ` opening a short explainer (hit-rate = `cache_read/(input+cache_read+cache_create)`, 70% target, why `n/a` for Antigravity). Use the `Sheet` as a light modal.
- **OTEL is a compact on/off indicator** next to the model name in the card header (reflects detected config: built-in / opt-in-enabled / plugin / none), not a verbose line.
- **Burn panel:** an **agent dropdown** (All / per-agent) that rescales the heatmap + receipts; a **caption + weekly date axis + per-cell date tooltip** so each box is unambiguously one local-day (`burn_daily` is keyed `(date, agent)`, master §11.2).
- **Live sessions is full-width**, each row a **`<details>` accordion** expanding to a **scrollable raw-JSONL line feed (`max-height: 300px`)** — refines master §17's right-drawer; backed by `/api/sessions/live/{sid}/stream`. The follow-up/reply box stays **Phase 6** (ops boundary).

### Tracked UI affordances (cite master, not re-specified here)

Range toggle `today/7d/30d` + local-time bucketing (master §16) · low-sample badges for Pi/Antigravity (master §17) · per-day Burn driver override `PATCH /api/burn/{date}` (master §11.3) — surfaced by the prototype as not-yet-built; build with their panels.

## Out of scope

- Any second agent (Phases 2–4) — though the interface must already admit them.
- Long-tail panels (Phase 5) and all operations features (Phase 6).
- Cross-agent Burn comparison (only one agent exists; the table/series are built to take more).

## Dependencies

Phase 0 (schema, contract, orchestrator shell, OTEL endpoints, shell, launchd).

## Deliverables

`adapters/claude_code.ts`, finalized `adapters/base.ts`, `config/prices.yaml` (rates), cost engine module, `setup_otel.ts`, core-panel API routes (master §16) + Svelte panels, KpiRow.

## Key decisions

- Breadth-first: **core panels only** here; long-tail deferred to Phase 5 (INDEX invariant).
- Rack-rate engine debuts now (ADR-0002) so the `estimated` cost path exists before any second agent.
- OTEL-first/JSONL-fallback (master §12.3) is implemented as a coalescing query pattern, established here for reuse.

## Interface / schema / API detail

Master §10.2 (`claude_code` map), §15 (JSONL + OTEL ingest), §12.2 (full CC OTEL surface — metrics/log-events/traces, delta temporality → `SUM(value)`), §16 (endpoints), §17 (panel specs), §11 (Burn sub-views). ADR-0002 (cost columns + engine).

## Stop conditions

1. Claude adapter parses real `~/.claude/projects/*.jsonl` and populates `sessions`/`token_usage`/`tool_calls`.
2. After OTEL wizard + Claude restart, new events appear within ~30s; OTEL-sourced MCP names show without `mcp__` string-parsing.
3. All seven core panels render **real Claude data** or proper empty states — no placeholders.
4. MCP panel: click a server → per-tool breakdown animates in; a known-slow MCP shows a high p95.
5. Token usage and Burn show Claude with correct `exact` token fidelity; Burn shows **native $ and `estimated`-badged rack-rate $**, never merged.
6. `AgentAdapter` interface is finalized and documented; a written check confirms it admits the Codex/Pi/Antigravity field maps.

## Verification (demo)

Open `localhost:8765` after a few real Claude sessions: KpiRow populated, MCP drill-down reveals a slow server, Burn shows today's tokens + native + estimated cost with the savings delta. Toggle OTEL on, run a prompt, watch the firehose-backed panels update within 30s.

## Risks & open questions

- **Interface finalization may force a Phase 0 schema/contract tweak** — acceptable; that's why we finalize here. Keep changes idempotent.
- **Price-table accuracy** — Claude rates must be current; stale rates skew the rack-rate (and the savings delta). Note source/date in `prices.yaml`.
- **MCP centerpiece quality bar** is high (master §17) — budget time; it's the panel that justifies the project.
- **Live-session detection** semantics for Claude (mtime + `ended_at IS NULL`) — confirm against real in-flight sessions.
