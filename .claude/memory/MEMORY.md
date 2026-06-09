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
  `~/.codex/config.toml` NOT yet wired (opt-in, deferred). Next: Phase 3 (Pi — per-message
  NATIVE cost, parentId branch tree).
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
