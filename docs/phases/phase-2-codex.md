# Phase 2 — Codex

> Status: Planned · Depends on: 0, 1 · Master refs: §10.2 (codex), §10.3, §12.1 · Decisions: [ADR-0002](../adr/0002-uniform-rack-rate-estimated-cost.md)

## Goal

Add Codex as the **second agent** — the first real exercise of the seam. Codex is structurally closest to Claude (flat JSONL, exact tokens) and the highest-volume source (~306 sessions), so it's the cheapest validation that "write an adapter, light up the panels" actually holds. No new panels.

## In scope

- **Codex adapter** (`adapters/codex.ts`) implementing `AgentAdapter` — glob `$CODEX_HOME/sessions/**/*.jsonl` (date-bucketed `YYYY/MM/DD/`). Records are `{type, timestamp, payload}` with `type ∈ {session_meta, turn_context, response_item, event_msg}`. Map per master §10.2:
  - `session_id` ← `session_meta.payload.id`; `cwd` ← `session_meta`/`turn_context.payload.cwd`; `model` ← `turn_context.payload.model`.
  - **tokens** ← `event_msg/token_count.payload.info.total_token_usage` — **use the LAST one in the file** (cumulative): `input_tokens`, `cached_input_tokens` (→ cache_read), `output_tokens`, **`reasoning_output_tokens` → `reasoning_tokens`** (first-class column/segment, gap #2), `total_tokens`. No cache-create concept.
  - tool calls/latency ← `response_item/function_call` ↔ `function_call_output` by `call_id`; shell tools also `event_msg/exec_command_end` (real `duration`, `exit_code`).
  - outcome ← `task_complete` present → ok; errors/`exit_code≠0` → flag.
- **Registration** — add to orchestrator registry + `config/agents.yaml` auto-detect/pre-enable `~/.codex/sessions`.
- **Cost** — **no native USD**; `cost_usd = NULL`. `cost_estimated_usd` computed by the Phase 1 rack-rate engine using the Codex `model` id (e.g. `gpt-5.4`) → ensure that model has rates in `config/prices.yaml`.
- **Codex OTEL (opt-in)** — `[otel]` block in `~/.codex/config.toml` (`exporter="otlp-http"`, endpoint → dashboard, `log_user_prompt=false`); `service.name=codex-cli`. Rows tagged `agent='codex'`. Apply the OTEL-first/JSONL-fallback rule (master §12.3). (Optional for the user to enable; JSONL is always-on.)

## Out of scope

New panels, long-tail, operations. Codex MCP attribution only if Codex emits it; otherwise tool-latency from JSONL pairing.

## Dependencies

Phase 0 (schema/seam), Phase 1 (finalized interface, core panels, rack-rate engine, OTEL-fallback pattern).

## Deliverables

`adapters/codex.ts`, `agents.yaml` Codex entry, Codex rates in `prices.yaml`, optional `setup` note for the `config.toml` `[otel]` block, Codex series in Token usage/Burn legends.

## Key decisions

- **Cumulative token semantics** (last `total_token_usage`) — Codex differs from Claude's per-message accumulation; the adapter normalizes to the same row shape.
- Codex is **tokens-only for native cost**; its money figure is the rack-rate estimate (ADR-0002).

## Interface / schema / API detail

Master §10.2 (codex field map), §10.3 (`agents.yaml` codex line), §12.1 (Codex OTEL enablement; note ≤v0.117.0 `codex exec`/`mcp-server` lacked metrics — re-verify on the installed version).

## Stop conditions

1. Codex adapter parses real `~/.codex/sessions/**/*.jsonl`; `sessions`/`token_usage`/`tool_calls` populated with `agent='codex'`, `fidelity='exact'`.
2. Token usage + Burn show **two agents** (Claude + Codex) with per-agent series/legend; Codex tokens exact.
3. Codex shows `cost_usd` empty (tokens-only) but a **`estimated`-badged rack-rate** cost; nothing merges native + estimated.
4. Tool latency / outcomes include Codex; `cc doctor` detects `~/.codex/sessions` + file count.
5. **No regression** to Claude panels.

## Verification (demo)

With both agents enabled, the Token usage and Burn moving-average table shows Claude and Codex side by side, each labeled exact, Codex money shown as estimated-only. The seam held — Codex required only an adapter, no panel surgery.

## Risks & open questions

- **`reasoning_output_tokens`** — RESOLVED (gap #2): stored in the first-class `reasoning_tokens` column, shown as a distinct token-mix segment, priced at the model's output rate by default (overridable per model in `prices.yaml`).
- Codex OTEL metrics coverage varies by version — JSONL remains the baseline.
- Confirm `cached_input_tokens` → cache-read mapping for the cache-efficiency panel (Codex has no cache-create).
