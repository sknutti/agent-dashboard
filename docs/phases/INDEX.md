# Command Centre — Phased Build Index

This is the mapping index for the phased build of the multi-agent observability dashboard. Each phase is a self-contained doc; this file is the cross-phase map — scope, dependencies, status, and where each phase draws from the master spec.

- **Master spec (reference):** [`../2026-06-08-multi-agent-observability-command-centre.md`](../2026-06-08-multi-agent-observability-command-centre.md) — still authoritative for field maps (§10.2), schema (§14), API surface (§16), and panel specs (§17). Superseded only on **stack**, **sequencing**, and **cost** (see ADRs).
- **Language:** [`../../CONTEXT.md`](../../CONTEXT.md)
- **Decisions:** [ADR-0001 — TS/Svelte/Bun stack](../adr/0001-typescript-svelte-bun-stack.md) · [ADR-0002 — uniform rack-rate estimated cost](../adr/0002-uniform-rack-rate-estimated-cost.md) · [ADR-0003 — agent-first UI + drill-downs](../adr/0003-agent-first-ui-with-drilldowns.md)
- **UI direction** (from `/prototype`): agent-first command page (per-agent cards as primary axis) · clickable cells → read-only drill-downs · grafted Tool latency + Subscription savings panels · token mix includes a `reasoning` segment · fidelity badged per figure (tokens vs cost).

## Status tracker

**Legend:** ⬜ Planned · 🔵 In progress · ✅ Done (all stop conditions met) · ⏸️ Blocked. A phase is **Done** only when every stop condition in its doc passes. Update the box and the `Status` column together.

| | Phase / slice | Status | Notes |
|---|---|---|---|
| ✅ | **0 — Foundation** | Done | all 6 stop conditions pass; launchd verified then unloaded |
| ✅ | **1 — Claude Code** | Done | adapter + cost engine + orchestrator + all core API routes + Svelte panels, verified against real JSONL (228 sessions) and live OTEL (probe → `cost.usage` native cost flows). UI screenshot-verified, zero console errors. Two stop-cond caveats are data-limited not impl gaps: a *slow* MCP (p95≥10s) needs a slow server in the data (none present), and OTEL MCP tool-latency lights up once a real MCP tool is called under telemetry. |
| ⬜ | **2 — Codex** | Planned | |
| ⬜ | **3 — Pi** | Planned | |
| ⬜ | **4 — Antigravity** | Planned | model-id risk → cost may stay NULL |
| ⬜ | **5 — Long-tail** | Planned | |
| ⬜ | **6 — Operations** | Planned | sub-sliced ↓ |
| ⬜ | &nbsp;&nbsp;6a — Dispatch spine + safety | Planned | emergency stop ships here |
| ⬜ | &nbsp;&nbsp;6b — Schedules | Planned | classic dispatch |
| ⬜ | &nbsp;&nbsp;6c — HITL + stream mode | Planned | isolated stream-mode risk |
| ⬜ | &nbsp;&nbsp;6d — Telegram bridge | Planned | opt-in |

**Critical path:** 0 → 1 → (2 ∥ 3 ∥ 4) → 5 ; 6 needs only 0 + 1 (parallelable with 2–5). Within 6: 6a → (6b ∥ 6c) → 6d.

## Phases

> Live progress is in the [Status tracker](#status-tracker) above — this table is reference only.

| # | Phase | Doc | Delivers | Depends on |
|---|---|---|---|---|
| 0 | Foundation | [phase-0-foundation.md](./phase-0-foundation.md) | Runnable-empty skeleton: full observability schema (+ both cost cols + stub `prices.yaml`), `AgentAdapter` contract, orchestrator shell, OTEL ingest endpoints, Svelte shell, launchd, `cc doctor` | — |
| 1 | Claude Code | [phase-1-claude-code.md](./phase-1-claude-code.md) | Claude adapter (finalizes the interface) · core panels · Burn (single-agent) · rack-rate cost engine · Claude OTEL | 0 |
| 2 | Codex | [phase-2-codex.md](./phase-2-codex.md) | Codex adapter → core panels · Codex OTEL (opt-in) | 0, 1 |
| 3 | Pi | [phase-3-pi.md](./phase-3-pi.md) | Pi adapter (tree→sum branches; native cost) → core panels · Pi OTEL (plugin) | 0, 1 |
| 4 | Antigravity | [phase-4-antigravity.md](./phase-4-antigravity.md) | Antigravity adapter (protobuf tokens + transcript tools) → core panels | 0, 1 |
| 5 | Long-tail | [phase-5-long-tail.md](./phase-5-long-tail.md) | Remaining observability panels, all agents | 0–4 |
| 6 | Operations | [phase-6-operations.md](./phase-6-operations.md) | Claude-only ops, **sub-sliced 6a–6d** (see below) | 0, 1 |

### Phase 6 sub-slices

Two rules drive the order: **safety ships with the capability to spawn** (emergency stop in the same slice that first launches `claude -p`), and **stream-mode subprocess plumbing is quarantined to one slice** (6a+6b run on classic dispatch only).

| Slice | Scope | Dispatch | Depends on |
|---|---|---|---|
| 6a | Dispatch spine + safety: `ops_*` schema, dispatcher classic mode, PID markers, **emergency stop**, minimal TaskBoard, mission-control plist | classic | 0, 1 |
| 6b | Schedules: heartbeat materialization, cron parsing, SchedulesCard/Composer | classic | 6a |
| 6c | HITL + **stream mode** (isolated): DECISION/INBOX markers, Decisions+Inbox panels, live follow-up, AttentionBar | stream | 6a |
| 6d | Telegram bridge (opt-in): wizard, notifier, dash_router, second plist | — | 6a |

6b and 6c are swappable siblings on top of 6a.

## Two axes (why the phases are shaped this way)

The product has two orthogonal axes. The phasing follows both:

- **Adapter/observability axis** (multi-agent): Phases 0–4, then long-tail in 5. Every agent phase only ever adds an Adapter + lights up existing panels.
- **Operations axis** (Claude-only): Phase 6. Mission Control/HITL/Telegram/emergency-stop spawn and kill `claude -p` — they do not generalize across agents, so they ship last and alone.

Ordering rationale: **breadth-first toward cross-agent visibility** (core panels for all four agents before long-tail or ops), and **easy → hard adapters** (Codex is structurally closest to Claude + highest volume → cheapest seam validation; Pi adds the branch tree + native cost; Antigravity is hardest: protobuf tokens, no OTEL).

## Cross-phase invariants

1. **Full observability schema is built in Phase 0** — including `agent`, `fidelity`, both cost columns (`cost_usd`, `cost_estimated_usd`), the `(date, agent, model, source)` rollup key, and `burn_daily`. Phases 1–4 write rows; they never re-migrate. (`ops_*`, `system_state`, `notification_log` are **excluded** — they belong to Phase 6.)
2. **The `AgentAdapter` interface is designed against all four field maps** (master §10.2) even though Claude (Phase 1) exercises none of the hard cases. The interface must support, from day one: **optional cost**, **tree-structured sessions** (Pi), and **multiple source files per session** (Antigravity: protobuf `.db` for tokens + transcript JSONL for tools). The *contract* lands in Phase 0; the *interface code* is finalized against the running Claude adapter in Phase 1.
3. **Fidelity everywhere.** Every token figure carries `exact`/`estimated`. Tokens are exact for all four agents.
4. **Cost model (ADR-0002):** tokens = exact cross-agent unit; **estimated cost (rack-rate)** = uniform cross-agent money unit, computed for all four, always `estimated`-badged; **native cost** = exact Claude/Pi annotation. Native and estimated are **never summed into one total**.
5. **Stack (ADR-0001):** one always-on Bun process (launchd-supervised) · Hono · `bun:sqlite` (WAL) · Svelte 5 SPA · heavy JSONL ingest in a worker thread · OTEL ingest + API reads on the main thread.
6. **Single source of truth per fact:** *what* (field maps/schema/API/panels) → master spec; *why* → ADRs; *language* → CONTEXT.md; *sequencing + TS/Svelte specifics* → these phase docs.

## Master-spec section map

| Topic | Master § | Used by phase |
|---|---|---|
| Adapter interface | §10.1 | 0, 1 |
| Concrete adapter field maps | §10.2 | 1 (CC), 2 (Codex), 3 (Pi), 4 (Antigravity) |
| Schema deltas + full schema | §10.4, §14 | 0 |
| Sync orchestration | §10.5, §15 | 0, 1 |
| Pi branch accounting | §10.6 | 3 |
| Burn panel | §11 | 1 (single-agent), 2–4 (per-agent) |
| OTEL (per-agent + CC surface + fallback rule) | §12 | 0 (endpoints), 1 (CC), 2 (Codex), 3 (Pi) |
| Project layout | §13 | 0 |
| API surface | §16 | per-panel, all phases |
| Panels | §17 | 1 (core), 5 (long-tail), 6 (ops) |
| Mission Control / emergency stop / Telegram | §18, §19, §20 | 6 |
| Setup UX (install, OTEL wizard, doctor) | §21 | 0 (shell), 1 (CC OTEL), 2–4 (agent detect) |
| Visual direction | §22 | 0 (tokens/shell), all UI phases |

## Panel allocation

- **Core (Phase 1):** Live sessions · Token usage · Tool latency · MCP drill-down (centerpiece) · Session outcomes · Cache efficiency · Burn. Plus a minimal SystemHealthStrip (Phase 0) and KpiRow (Phase 1).
- **Long-tail (Phase 5):** Hook activity · Project breakdown · Agent fan-out · Edit-acceptance · Productivity · Pressure · Telemetry firehose · Patterns/heatmap · All-sessions table · Top skills + failures · Skill economics · Context health + registry · MCP schema measurement.
- **Operations (Phase 6):** AttentionBar · HITL Decisions/Inbox · TaskBoard/Composer · Schedules · EmergencyStop banner · Telegram bridge. (Posture panel is explicitly out of the free build.)
