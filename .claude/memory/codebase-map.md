# Codebase map

## Backend (`scripts/`, Bun + Hono + bun:sqlite)
- `server.ts` — single always-on process (127.0.0.1 only). Spawns the worker, mounts
  OTLP `/v1/*` ingest, calls `registerApiRoutes(app)`, serves `ui/dist` static + SPA fallback.
- `db.ts` — full observability schema. `getDb()` opens + `initSchema()` (thread-local
  singleton); `openDb()` does NOT init. See [[gotchas]].
- `paths.ts` — env-overridable filesystem/port config; `tzName()`.
- `cost.ts` (Phase 1) — rack-rate cost engine. `estimateCostUsd(model, tokens)` →
  `{usd|null, priced, resolvedModel}`; reads `config/prices.yaml` synchronously, resolves
  aliases, unpriced model → null (never guesses). cache_read 0.1×, cache_write 1.25× input.
- `adapters/base.ts` — `AgentAdapter` interface (finalized Phase 1; added session-level
  `nativeCostUsd`). `NormalizedEvent` = session | tokens | tool.
- `adapters/claude_code.ts` (Phase 1) — reference JSONL parser. Globs
  `~/.claude/projects/*/*.jsonl`, streams lines, pairs tool_use/tool_result (10-min cap),
  emits normalized events. Parses only — orchestrator owns DB writes + live/ended decision.
- `sync_agents.ts` (Phase 1) — worker-thread orchestrator. Owns ALL DB writes: upserts
  `sessions` (totals = Σ token events, est cost via cost.ts), replaces `tool_calls`,
  re-derives `token_usage` (DELETE+INSERT…SELECT) + `burn_daily` (UPSERT preserving
  user driver/evidence). Re-parse gate: new file | `ended_at IS NULL` | mtime > synced_at.
- `routes.ts` (Phase 1) — all `/api/*` reads (master §16): summary, agents, sessions(+detail),
  live(+SSE stream), usage/tokens, usage/cache, tools/latency, sessions/outcomes,
  mcp(+/{server}/tools), burn(+PATCH). Local-time bucketing; range today/7d/30d/90d.
  `mcpCalls()` does OTEL-first / JSONL-fallback (parses `mcp__server__tool`).
- `otel.ts` — OTLP/HTTP JSON ingest (logs/metrics/traces); always 200; per-row try/catch.
- `setup_otel.ts` (Phase 1) — wizard: backs up `~/.claude/settings.json`, adds only the 6
  missing OTEL env keys, never overwrites. `--dry-run` / `--revert` / `--port`.

## Frontend (`ui/src/`, Svelte 5 runes SPA, Vite)
- `lib/api.ts` — typed fetchers for every endpoint. `lib/format.ts` — compact/usd/ms/pct/
  relTime/shortDate/homeDir. `lib/resource.svelte.ts` — `resource(key, fetcher)` reactive
  fetch (refetches when key() changes; cancels stale).
- `lib/stores.svelte.ts` — `ui.range` (global toggle), `drill` (drill-down ctx), `health` poll.
- `lib/components/panels/` — KpiRow, AgentCard (token-mix bar + dual fidelity-badged cost +
  drill cells), TokenUsagePanel, BurnPanel (log heatmap + scale-equivalents + MA table),
  CachePanel, OutcomesPanel, ToolLatencyPanel, SavingsPanel, McpPanel (centerpiece, lazy
  per-tool expand), LiveSessionsPanel + LiveSessionRow (SSE raw feed), DrillSheet (list→detail).
- Routes: `Command.svelte` (agent-first grid + sections), `Skills.svelte` (MCP panel),
  `Activity.svelte` (Phase 5 long-tail, still empty states). `App.svelte` mounts `DrillSheet`.

## Config
- `config/prices.yaml` — real Anthropic rack rates (source/date noted). `config/agents.yaml` —
  per-adapter enable/path/glob; orchestrator reads `claude_code` entry.
