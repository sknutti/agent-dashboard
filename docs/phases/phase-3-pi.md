# Phase 3 — Pi

> Status: Planned · Depends on: 0, 1 · Master refs: §10.2 (pi), §10.6, §10.3, §12.1 · Decisions: [ADR-0002](../adr/0002-uniform-rack-rate-estimated-cost.md)

## Goal

Add Pi as the **third agent**. Pi stresses two seam assumptions Claude/Codex didn't: **tree-structured sessions** (`parentId` branches) and **native per-message USD cost**. If the Phase 0 interface was designed correctly, both are already admissible.

## In scope

- **Pi adapter** (`adapters/pi.ts`) — glob `~/.pi/agent/sessions/**/*.jsonl` (one dir per cwd-slug). Records `{type, id, parentId, timestamp, message}`, **tree via `parentId`**; `type ∈ {session, message, model_change, thinking_level_change}`. Map per master §10.2:
  - `session_id` ← `session.id`; `cwd` ← `session.cwd`; `model` ← `message.message.model`/`.provider` (or `model_change.modelId`).
  - **tokens** ← `assistant` rows `message.message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`) — **sum across ALL branches** (master §10.6 / Resolved #8: you were billed for abandoned branches). Keep distinct branch-tip count as session metadata.
  - **native cost** ← `message.message.usage.cost.total` (per-message USD) → `cost_usd`.
  - tool calls ← `message.message` role `toolResult` (`toolName`, `toolCallId`, `isError`); latency = `toolResult.timestamp − issuing assistant.timestamp` (cap 10 min).
  - outcome ← `assistant.stopReason`; any `toolResult.isError` → error_count.
- **Branch accounting** (master §10.6) — totals sum every branch; the latest linear path is **not** used for totals. Branch count stored as metadata for context.
- **Registration** — orchestrator + `agents.yaml` auto-detect `~/.pi/agent/sessions`.
- **Cost** — Pi has **native USD** → populate `cost_usd`. **Also** compute `cost_estimated_usd` (rack-rate) from Pi's `model` → Pi gets the **subscription-savings delta** (native vs rack-rate), same as Claude.
- **Pi OTEL (plugin)** — `pi install npm:pi-otel`, `/otel start`; metrics include token usage/LLM latency/tool-exec time, logs `pi.session.start/end`/`pi.tool.error`. Rows tagged `agent='pi'`; OTEL-first/JSONL-fallback (master §12.3).

## Out of scope

New panels, long-tail, operations.

## Dependencies

Phase 0 (interface must already admit tree sessions + optional/native cost), Phase 1 (panels, rack-rate engine, native-cost rendering established for Claude).

## Deliverables

`adapters/pi.ts` (with branch-summation), `agents.yaml` Pi entry, Pi rates in `prices.yaml`, branch-count metadata surfaced where relevant, optional `pi-otel` setup note.

## Key decisions

- **Sum all branches** for totals (master §10.6) — the single most Pi-specific rule; verify it doesn't double-count shared ancestors (sum `assistant` *rows*, each counted once, regardless of path).
- Pi mirrors Claude as a **dual-cost** agent (native + estimated) → reuse the savings-delta UI from Phase 1.

## Interface / schema / API detail

Master §10.2 (pi field map), §10.6 (branch accounting), §10.3 (`agents.yaml` pi line: `cost: native`), §12.1 (pi-otel plugin).

## Stop conditions

1. Pi adapter parses real `~/.pi/agent/sessions/**/*.jsonl`; tree handled; `agent='pi'`, `fidelity='exact'`.
2. Token totals **sum across branches** (validated against a known multi-branch session); branch count shown as metadata.
3. Token usage + Burn show **three agents**; Pi shows **native `cost_usd`** *and* `estimated`-badged rack-rate, with the savings delta — never merged into one number.
4. Tool latency/outcomes include Pi; `cc doctor` detects `~/.pi/agent/sessions`.
5. **No regression** to Claude/Codex panels.

## Verification (demo)

A Pi session with re-run branches reports the summed (true-spend) token total, not the latest-path total; Burn shows Pi with both native and estimated cost and the savings delta, alongside Claude (dual-cost) and Codex (estimated-only).

## Risks & open questions

- **Branch double-counting** — the real hazard; sum rows by unique `id`, not by traversing each leaf-path. Add a test on a multi-branch fixture.
- **Latency from timestamp diff** can be inflated by user think-time between assistant and toolResult — the 10-min cap mitigates; confirm it's reasonable.
- Pi volume is low (~13 sessions) — small sample for the cache/outcome panels; low-sample badges apply.
