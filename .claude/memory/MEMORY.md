# Project memory — Multi-Agent Observability Command Centre

Localhost-only observability + (later) operations dashboard that ingests coding-agent
session logs into one SQLite file and renders a dense Svelte dashboard. Zero outbound.
Stack: Bun + Hono + bun:sqlite (WAL) + Svelte 5 SPA (ADR-0001). Built in phases
(`docs/phases/`); Phase 0 = foundation, Phases 1–4 = one agent each, 5 = long-tail, 6 = ops.

## Topic files
- [codebase-map.md](codebase-map.md) — key modules & entry points (backend + UI).
- [gotchas.md](gotchas.md) — native cost not in JSONL, real model IDs, schema init ownership, esbuild.

## Status
- Phase 0 ✅ Done. Phase 1 ✅ Done — adapter, cost engine, orchestrator, all core API routes,
  all Svelte core panels. Verified against real JSONL (228 sessions, 10.5k tool calls) and live
  OTEL (a `claude -p` probe emitted `cost.usage` → native cost flows via OTEL-first/JSONL-fallback).
  UI screenshot-verified, zero console errors. OTEL is enabled in `~/.claude/settings.json`
  (6 keys; backup alongside).
- Phase 2 ✅ Done — Codex adapter (`adapters/codex.ts`), prices.yaml gpt-5.5/gpt-5.4
  (OpenAI list rates, dated 2026-06-09), orchestrator seam generalized (agentId+fidelity
  threaded, no longer hardcoded), doctor file-count. The ADAPTER seam HELD (no adapter-driven
  panel changes); but adding agent #2 surfaced TWO latent Phase-1 single-agent bugs, both
  fixed (see [[gotchas]]): (1) `BurnPanel.svelte` hardcoded the agent dropdown → now data-driven
  via `getAgents`; (2) `/api/burn` leaked Claude's OTEL native cost into non-Claude filters →
  overlay now scoped to all/claude_code. No schema changes. QA screenshot-verified across 2 rounds.
  Verified against real data: 306 Codex sessions ingested `agent='codex' fidelity='exact'`,
  cost_usd NULL + estimated rack-rate present, reasoning a first-class token segment, no
  Claude regression; `/api/usage/tokens` returns both agents. Codex OTEL `[otel]` block in
  `~/.codex/config.toml` NOT yet wired (opt-in, deferred).
- Phase 3 ✅ Done — Pi adapter (`adapters/pi.ts`), registered in `sync_agents.ts`, prices.yaml
  alias `anthropic.claude-opus-4-6-v1`→`claude-opus-4-6`, `branch_count` surfaced (detail route +
  api.ts + DrillSheet chip when >1), 5 unit tests (`adapters/pi.test.ts`, first tests in repo;
  `bun test`). Verified against all 13 real sessions vs a jq oracle: tokens/native/errors/tools
  match exactly (native total $8.3513, 386 tools, 12 errors), branch_count=1 for all (linear),
  3 agents in /api/agents + /api/usage/tokens + /api/burn, doctor detects pi, NO Claude/Codex
  regression. THREE spec-vs-reality departures (see [[gotchas]]): (1) Pi buckets are DISJOINT
  (inverse of Codex) → direct map, no subtraction; (2) ZERO real branches → sum-by-unique-row
  is branch-safe AND linear-correct, no tree traversal (branch summation proven by synthetic
  fixture test, not real data); (3) Pi native == rack-rate est EXACTLY ($8.3512575 both) because
  Pi pays METERED API list rates → savings delta is genuinely ~$0 (unlike Claude's subscription
  delta). Pi is multi-PROVIDER (models are gpt-5.4/gpt-5.5/opus-4-6/gemini ids); gemini-3.1-pro-
  preview left unpriced (never-guess rule) — its rows still get native cost. Pi OTEL plugin
  (pi-otel) NOT wired (opt-in, deferred). UI screenshot-verified (playwright-bowser): Burn@90d
  filtered to Pi shows BOTH native+est columns, est==native every row (savings $0), totals
  match oracle (~16M tok/$8.35), zero console errors. Fixed a stale UI placeholder caught in
  QA: `AgentCard.svelte` `ADAPTER_PHASE` still said "Adapter ships in Phase 3" for empty Pi
  cards → dropped `pi` (Antigravity stays for Phase 4). **Data-recency caveat:** Pi data is
  Mar–Apr (>30d old), so Pi is INVISIBLE on the Command page (agent grid + token-usage are
  capped at the global 7d/30d range and read "No sessions in range"); Pi only renders in the
  Burn panel, which has its own 30d/90d toggle. Not a bug — old data + recency-focused ranges.
  Next: Phase 4 (Antigravity — tokens from protobuf .db).
- Verify the app by running the server (`bun start`) + a `claude -p` probe to generate OTEL,
  then screenshot via a playwright-bowser agent. I (Claude) can't restart my own CC session.

## Load-bearing facts (don't re-derive)
- **Cost model (ADR-0002):** tokens = exact cross-agent unit; rack-rate `cost_estimated_usd`
  = uniform cross-agent money axis (always `estimated`); native `cost_usd` = exact Claude/Pi.
  The two are NEVER summed into one total. Estimated always exists; native often NULL.
- **Fidelity per figure, never per agent/card** — tokens exact, cost badged by which column.
- **Rollups (`token_usage`, `burn_daily`) are re-derived from `sessions` each tick** — pure
  derivation, idempotent, no per-session staging table (keeps INDEX invariant #1). `burn_daily`
  UPSERTs so user driver/evidence overrides survive re-derivation.
- **OTEL-first / JSONL-fallback** (master §12.3) — same query path; JSONL is the only source
  until telemetry is on. Implemented in `routes.ts` (mcpCalls, agents otel flag).
- Reference docs: master spec `docs/2026-06-08-*.md` (what), ADRs `docs/adr/` (why),
  CONTEXT.md (language), phase docs `docs/phases/` (sequencing + TS specifics).
