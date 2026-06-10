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
- `adapters/codex.ts` (Phase 2) — Codex JSONL parser. Globs `$CODEX_HOME/sessions/**/*.jsonl`
  (date-bucketed). ONE cumulative `tokens` event from the LAST non-null `total_token_usage`,
  normalized to disjoint buckets (see [[gotchas]]). Tool latency via `function_call`/
  `custom_tool_call` ↔ `*_output` by call_id; precise duration + exit_code from
  `exec_command_end`. No native cost. `supportsOtel()`=false (opt-in, not yet wired).
- `adapters/pi.ts` (Phase 3) — Pi JSONL parser. Globs `~/.pi/agent/sessions/**/*.jsonl`
  (one dir per cwd-slug). Records `{type,id,parentId,timestamp,...}` form a parentId tree;
  emits ONE `tokens` event per assistant row (branch-summed by construction, no traversal)
  with DISJOINT buckets mapped directly (cacheWrite→cacheCreate) + per-message native
  `usage.cost.total`. Tool pairing via `toolCallId`; errorCount from `toolResult.isError`.
  branchCount = message-record tips only. Multi-provider (models are provider ids). See [[gotchas]].
  `adapters/pi.test.ts` — first unit tests in repo (`bun test`), branch-summation fixture.
- `adapters/antigravity.ts` (Phase 4) — the hardest agent: tokens from a PROTOBUF BLOB
  in `conversations/<conv>.db` (table `gen_metadata`), tools from a SIBLING transcript
  JSONL, merged per conv. Hand-ported wire reader (varint + length-delimited; exported
  `decodeGen`). Globs `conversations/*.db` (NOT the transcript). Opens the WAL DB via
  `file:…?immutable=1`. No native USD; model `gemini-3-flash-a` pinned but unpriced →
  both cost columns NULL. `reasoning=f9`/`output=f10` disjoint split. See [[gotchas]].
  `adapters/antigravity.test.ts` — protobuf field-map + two-source-merge fixture tests.
- `sync_agents.ts` (Phase 1; Phase 2 generalized seam) — worker-thread orchestrator. Owns ALL
  DB writes: upserts `sessions` (totals = Σ token events, est cost via cost.ts), replaces
  `tool_calls`, re-derives `token_usage` (DELETE+INSERT…SELECT) + `burn_daily` (UPSERT
  preserving user driver/evidence). `writeSession`/`parseAndWrite` now take `agentId`+
  `fidelity` (no longer hardcoded `claude_code`); `buildRegistry` reads each agent's
  `agents.yaml` entry (now 4 adapters incl antigravity). Re-parse gate: new file |
  `ended_at IS NULL` | mtime > synced_at — keys on FILE BASENAME == session_id, so
  antigravity (.db basename ≠ conv-id) never short-circuits → re-parses every tick
  (harmless; see [[gotchas]]).
- `routes.ts` (Phase 1; Phase 5 long-tail added) — all `/api/*` reads (master §16):
  summary, agents, sessions(+detail, +`q`/`source` search [P5]), live(+SSE stream),
  usage/tokens, usage/cache, tools/latency, sessions/outcomes, mcp(+/{server}/tools),
  burn(+PATCH). Local-time bucketing; range today/7d/30d/90d. `mcpCalls()` does
  OTEL-first / JSONL-fallback (parses `mcp__server__tool`). **Phase 5 routes:**
  sessions/by-project (cwd rollup), tools/agent-fanout (Agent/Task tool), tools/edit-
  decisions (tool_decision OTEL → lowSample), hooks/activity (start/complete FIFO pair,
  60s cap), activity/productivity (commit/PR/LoC delta counters), system/pressure (retry
  exhaustion ≥CLAUDE_CODE_MAX_RETRIES + compaction + api errors), activity/patterns
  (30d session heatmap + 14d token-by-model), firehose (SSE replay+tail, keepalive — see
  [[gotchas]]), activity/top-skills (Skill-tool count; per-skill needs OTEL), activity/
  failures (errored/rate_limited/truncated sessions), skills (GET lazy-sync/POST sync/
  PATCH autonomy), context/health (settings.json+CLAUDE.md scan, counts only), mcp/measure
  (observed servers+tool counts; schema bytes need live handshake). `parseAttrs()` helper.
- `skills.ts` (Phase 5) — read-only SKILL.md scanner → `skills` table. `scanSkills(cwd)`
  globs ~/.claude/skills (ide:global), <cwd>/.claude/skills (ide:project), ~/.claude/
  plugins/**(cowork:plugin); parses frontmatter (name/description), counts non-SKILL.md
  files. `syncSkills()` UPSERTs preserving user `autonomy_level`, prunes deleted. 105 on
  this machine (plugin glob catches marketplace sources).
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
  **Phase 5 panels:** ProjectBreakdown, AgentFanout, EditAcceptance, HookActivity,
  Productivity, Pressure (Command obs section); Patterns (heatmap+token charts, client
  builds local-date axis), Firehose (SSE via `createFirehose`), TopSkills, Failures,
  SessionsTable (search+chips+pagination) (Activity); ContextHealth, SkillsRegistry
  (search+env chips+autonomy select+re-sync), SkillEconomics, McpSchema (Skills).
- `lib/firehose.svelte.ts` (Phase 5) — `createFirehose()` hook: EventSource + id-dedupe,
  the one legit `$effect` (external system), closed on teardown.
- Routes: `Command.svelte` (agent grid + obs section, Phase 5 long-tail wired),
  `Activity.svelte` (Patterns/Firehose/TopSkills+Failures/AllSessions + range head),
  `Skills.svelte` (MCP+schema / economics / context-health+registry). `App.svelte` mounts `DrillSheet`.
- **Data reality (Phase 5):** rich = ProjectBreakdown/AgentFanout/Patterns/Failures/
  AllSessions/SkillsRegistry/ContextHealth (JSONL+filesystem). Honest empty/low-sample =
  EditAcceptance/Productivity/Pressure/HookActivity/Firehose/TopSkills/SkillEconomics
  (need Claude OTEL, near-empty until telemetry runs). Per-skill cost/name unattributed
  (Skill tool input not persisted; needs `skill_name` OTEL attr).

## Config
- `config/prices.yaml` — real Anthropic rack rates (source/date noted). `config/agents.yaml` —
  per-adapter enable/path/glob; orchestrator reads `claude_code` entry.
