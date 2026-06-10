# Project memory — Multi-Agent Observability Command Centre

Localhost-only observability + (later) operations dashboard that ingests coding-agent
session logs into one SQLite file and renders a dense Svelte dashboard. Zero outbound.
Stack: Bun + Hono + bun:sqlite (WAL) + Svelte 5 SPA (ADR-0001). Built in phases
(`docs/phases/`); Phase 0 = foundation, Phases 1–4 = one agent each, 5 = long-tail, 6 = ops.

## Topic files
- [codebase-map.md](codebase-map.md) — key modules & entry points (backend + UI).
- [gotchas.md](gotchas.md) — native cost not in JSONL, real model IDs, schema init ownership, esbuild.
- [2026-06-10 adversarial review](../../docs/notes/2026-06-10-adversarial-review.md) — 5-lens audit, ~30 verified
  findings. **Batch 1 FIXED (commit pending):** (1) native-cost merge now OTEL-first per-agent — extracted to pure
  `scripts/burn.ts` (`mergeBurnByDate`) + `burn.test.ts` (8 tests); (2) re-parse gate keys on new `source_path`
  column, not basename — measured 560→4 sessions/tick, 1060ms→33ms; rollups now gated on `synced>0`; (3) overlap-tick
  guard + `elapsedMs` in heartbeat; (4) indexes `idx_tool_calls_session`, `idx_sessions_agent_started`,
  `idx_sessions_source_path`; (5) live-session + OTEL-badge use `datetime(col)` not lexical string compare.
  **Batch 2 FIXED (37569e9):** loopback guard middleware (Host allowlist vs DNS rebinding on all routes; Origin
  check on writes + /v1/* vs drive-by CSRF/OTLP poisoning; emitters/dev-proxy still work).
  **Batch 3 FIXED (commit pending) — biggest correctness win:** Claude per-content-block usage double-count.
  Claude JSONL repeats `usage` on every split line of a message → was 2× over-counting. Measured 3.66B→1.76B
  (51.9% phantom) on this machine; deduped by message.id+requestId, live DB corrected via forced resync. See
  [[gotchas]] + `adapters/claude_code.test.ts` (first reference-adapter test).
  **Batch 4 FIXED (commit pending):** antigravity startedAt falls back to .db mtime when transcript absent (was
  NULL → tokens excluded from all rollups/ranges); Burn type estUsd/estimatedUsd now `number|null` (was lying
  `number`); McpServers.source no longer emits literal `0`; supervised worker respawn (backoff, give-up logs);
  doctor checks heartbeat AGE not just count. Tests `antigravity.test.ts` no-transcript case; svelte-check clean.
  **Batch 5 FIXED (commit pending) — frontend UX, browser-QA'd (0 console errors, 3 pages):** (1) deleted the
  duplicate Phase-0 AppShell drill sheet (real one is DrillSheet in App.svelte); (2) CachePanel pass/fail now
  cyan-not-green + text label "✓ at/above 70% target" (CVD); (3) AgentCard shows "last seen <shortDate>" (new
  `lastSessionAt` un-windowed on /api/agents) so Pi/Codex stop reading as broken; (4) shared EmptyState error
  mode (amber, Retry) applied across 22 panels — a 500 now says "Couldn't load data", not a false "no data"
  (PressurePanel/ContextHealth no longer render blank). NOTE: shortDate() only formats YYYY-MM-DD — slice ISO
  to 10 chars first. **Review COMPLETE — 5 batches + Codex mispricing follow-up shipped.**
  **Codex per-model attribution FIXED (commit pending):** Codex emits CUMULATIVE total_token_usage; was priced
  entirely at the LAST model (mid-session /model switch mispriced the whole session; unpriced-last-model → whole
  est NULL). Now attributes each record's DELTA to the active model → one tokens event per model. LATENT here
  (0/306 sessions switch) → verified byte-identical totals vs DB (no resync); multi-model + counter-reset proven
  by `codex.test.ts` (first Codex tests).
  **Batches 6–11 FIXED (commits Review batch 6–11):** the reliability/perf, tooling, type, and UX-polish tail.
  - B6 reliability: live SSE tails by BYTE offset (was full re-read every 1.5s); OTEL agent attribution from
    resource service.name not hardcoded `claude_code` (+`otel.test.ts`); OTLP per-batch txn; health = MAX of 3
    indexed sub-MAXes (+`idx_otel_metrics/spans_received`); 90d retention sweep (~hourly, ISO-Z cutoff vs raw col
    to dodge the #5 'T'>' ' trap); source-went-empty warn.
  - B7 tooling: `bun run check` (tsc+test+svelte-check) + CI workflow; prices.yaml machine-parseable
    `last_updated:` + doctor "prices freshness"/"unpriced models" checks (flags gemini-3-flash-a); doctor glyphs
    ✓/▲/✗ (CVD).
  - B8 UX: global `dataEpoch` bumped on the 30s health poll → resource() refetches ALL panels (were mount-once);
    DrillSheet honors global range; clickable session rows → /session/:id (SessionsTable+Failures); CVD ✗/cyan+✓;
    BurnPanel heatmap legend + est/native/"—" note; Sheet focus trap (Svelte action); INDEX.md phases 2–4 → Done.
  - B9 types (#15 targeted): `scripts/wire.ts` contract; agents/sessions/burn handlers use `query<Row,Params>` +
    `satisfies` (server can't drift); api.ts documents wire.ts as source of truth.
  - B10: **#12 rollup predicate was a DOUBLE-localtime bug** — `DATE(date,'localtime')` on an already-local date
    shifted it back a day (Denver), dropping the oldest day of every range (live: 7d 4→5 days, +418K tok). Now
    raw `date >=` (sargable: SCAN→SEARCH) +`routes.test.ts`. Timestamp cols stay DATE(,'localtime') — 'localtime'
    is non-deterministic so it can't go in a generated column/index. #19 dead tables removed from schema (live
    orphans inert; DROP blocked by damage-control hook, harmless). #21 TOOL_DURATION_CAP_MS → one base.ts export;
    `pushAgent()` helper collapses ~11 copy-pasted agent filters.
  - B11 (#30 viz): agent selector on TokenUsage+Patterns; model filter on SessionsTable (APIs already supported).
  **STILL OPEN (deliberately):** #17 agent-identity refactor — ARCHITECTURAL, Scott wants to discuss design first
  (buildRegistry iterate agents.yaml + one metadata endpoint + delete ~9 hardcoded lists). #2 Claude resume
  cross-file double-count — confidence 0.7, NEEDS a real resumed session to verify; this machine has none, not
  fake-fixed (intra-file content-block dedup already shipped in B3). Full #15 49-site sweep declined (targeted done).

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
- Phase 4 ✅ Done — Antigravity adapter (`adapters/antigravity.ts`, the 4th/hardest agent),
  registered in `sync_agents.ts`, `agents.yaml` glob → `conversations/*.db`. Tokens decoded
  from a PROTOBUF BLOB (`gen_metadata`) via a hand-ported wire reader; tools from a SIBLING
  transcript JSONL, merged per conversation — the seam's hardest case (non-JSONL tokens +
  multi-source-per-session), and **the adapter seam HELD again** (no panel changes). QA
  surfaced TWO things: (1) a stale UI placeholder dropped — `AgentCard.svelte`
  `ADAPTER_PHASE` now `{}`, all 4 shipped; (2) a LATENT `/api/burn` bug — it coerced
  unpriced daily est to `$0` (a fabricated figure) instead of NULL/"—"; Antigravity is
  the first uniformly-unpriced agent so it exposed it. Fixed `estUsd` to be NULL-preserving
  like `nativeUsd` (one route change, no regression to priced agents). See [[gotchas]]. 5 unit tests (`adapters/antigravity.test.ts`). Verified vs the Python extractor
  oracle EXACTLY: in=618135, out(f10)+reasoning(f9)=22559, total=640694 across 2 real convs;
  cwd decoded, model `gemini-3-flash-a` pinned but UNPRICED → both cost columns NULL (tokens
  `exact`, money-blind by design — never guessed a Gemini rate). 83 tools merged with
  created_at-delta latency, 0 errors. Empty conv `8217e2ca` (0 gen rows + no transcript)
  correctly yields no session row. `cc doctor` detects antigravity, NO regression to the
  other 3 agents. THREE departures-from-reality (see [[gotchas]]): (1) WAL .db needs
  `file:…?immutable=1` open (`{readonly:true}` → SQLITE_CANTOPEN); (2) glob the `.db` (clean
  conv-id session_id + token source), not the colliding transcript — costs a reparse-every-
  tick (harmless); (3) f9/f10 split is disjoint so total=input+f3 stays the verification
  anchor, labels inferred. **Data-recency:** unlike Pi, Antigravity data is Jun 5–8 (within
  7d of today) → it DOES render on the Command page agent grid + token-usage, not just Burn.
- Phase 5 ✅ Done — long-tail panels across all 3 pages, built multi-agent from the start.
  **13 new routes** in `routes.ts` + `scripts/skills.ts` (SKILL.md scanner) + `firehose.svelte.ts`
  (SSE hook) + 15 panels (see [[codebase-map]]). The **adapter seam was untouched** (Phase 5 is
  pure read-side); no schema changes (all P5 tables existed since Phase 0). Stop conditions all
  pass. Split cleanly by DATA REALITY, not by spec section: **rich** (real data) = Project
  breakdown (125 cwd), Agent fan-out (Agent/Task tool), Patterns (523-session heatmap + 14d
  token-by-model), Failures (101 errored), All-sessions (search+chips+pagination), Skills
  registry (105 skills, autonomy PATCH persists), Context health (settings.json+CLAUDE.md scan);
  **honest empty/low-sample** = Edit-acceptance, Productivity, Pressure, Hook activity, Firehose,
  Top skills, Skill economics — all need Claude OTEL, near-empty until telemetry runs (stop
  cond: "real data OR proper empty states" — satisfied). Per-skill cost/name is UNATTRIBUTED
  (Skill tool input not persisted → needs `skill_name` OTEL attr; surface exact invocation
  count, never a fake breakdown). MCP schema bytes need a live handshake (out of this read-only
  build) → report observed tool counts only. ONE real bug found+fixed in QA: the firehose SSE
  died at 10s on Bun.serve's idleTimeout → keepalive + client id-dedupe (see [[gotchas]]); the
  Phase-1 live-stream route had the same bug — fixed with the same keepalive. Verified via 3 playwright-
  bowser passes: all panels render, filters/search/pagination/autonomy work, firehose holds 18s
  with **0 console errors** (was 190+), tests 10/10, no core-panel regression.
  Next: Phase 6 (operations, sub-sliced 6a–6d) — the Claude-only ops axis.
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
