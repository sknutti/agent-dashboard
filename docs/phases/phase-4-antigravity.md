# Phase 4 — Antigravity

> Status: Planned · Depends on: 0, 1 · Master refs: §10.2 (antigravity), §10.3, §12.1, §15 (antigravity adapter) · Decisions: [ADR-0002](../adr/0002-uniform-rack-rate-estimated-cost.md) · Extractor: [`../antigravity_token_extractor.py`](../antigravity_token_extractor.py)

## Goal

Add Antigravity (`agy` CLI) as the **fourth and hardest agent** — saved for last because it breaks the most assumptions: tokens live in a **protobuf BLOB in a SQLite `.db`** (not JSONL), tools live in a separate transcript JSONL, there is **no usable OTEL**, and there is **no native USD**. Completing it proves the seam's hardest case (multi-source-per-session, non-JSONL tokens).

## In scope

- **Antigravity adapter** (`adapters/antigravity.ts`) — data root `~/.gemini/antigravity-cli/` (**not** `~/.gemini/antigravity/` — corrected path). Conversation id = `brain/<conv-id>/` dir = `conversations/<conv-id>.db`. **Two parse paths merged per session:**
  - **Tools/latency** ← glob `brain/*/.system_generated/logs/transcript_full.jsonl`; step records `{type, content, created_at, source, status, step_index}`.
  - **Tokens (reverse-engineered)** ← `conversations/<conv-id>.db`, table `gen_metadata` (one BLOB row per LLM generation). **Port the Python wire-format reader to TS** (varint + length-delimited; ~30 lines). Usage submessage at path **field `1` → field `4`**:
    - f1 = system (~1020, cached/fixed) · f2 = input/context · f6 = overhead (24) · **f3 = total output (invariant `f3 == f9 + f10`, proven 89/89)** · f9/f10 = output split → **f9 → `reasoning_tokens`** (gap #2; label still inferred), f10 → response output.
    - Per gen: **input = f1+f2+f6**, **output = f3**. Session total = `SUM` over rows. Empty/aborted `gen_metadata` → tools-only fallback.
  - Defensive per-row try/except; skip rows where `1.4` is absent. Re-decode when `.db` mtime advances.
  - `cwd` ← `trajectory_metadata_blob` protobuf (`file:///…`) or `history.jsonl` `workspace` (best-effort).
- **Registration** — orchestrator + `agents.yaml` (`tokens: protobuf_db`, `cost: none`).
- **Cost** — **no native USD** (`cost_usd = NULL`). `cost_estimated_usd` **only if the model can be pinned** (see risk); otherwise NULL + a visible "model unknown" note (ADR-0002 fallback). **Do not guess a rate.**
- **No OTEL** — Antigravity ships only to Google (Sentry, hardcoded `antigravity-unleash.goog`); no local OTLP. **Do not enable** its telemetry toggle (it leaks to Google and doesn't help).

## Out of scope

New panels, long-tail, operations. OTEL (none exists for this agent).

## Dependencies

Phase 0 (interface must already admit **multiple source files per session** + **non-JSONL token source** — this phase is the reason that requirement exists), Phase 1 (panels, rack-rate engine).

## Deliverables

`adapters/antigravity.ts` (TS port of the protobuf reader + transcript loop), `agents.yaml` Antigravity entry, model-id resolution attempt, conditional rack-rate, ported from the validated [`antigravity_token_extractor.py`](../antigravity_token_extractor.py).

## Key decisions

- **Tokens are `exact`** (decoded), not estimated — the input/output totals are solid (Resolved #12). Soft spots (f9/f10 labels, f1-as-cache) are inferred and must NOT block Burn.
- **Two-source merge** is the seam's hardest test — tokens from `.db`, tools from JSONL, joined on conversation id.
- Antigravity is **tokens-only for native cost**; rack-rate is conditional on model identification.

## Interface / schema / API detail

Master §10.2 (antigravity field map + wire-field table), §15 (antigravity adapter reference + embedded protobuf reader to port), §10.3 (`agents.yaml` antigravity line). Reference implementation: `docs/antigravity_token_extractor.py`.

## Stop conditions

1. Adapter decodes real `conversations/<conv-id>.db` `gen_metadata`; token totals match the validated extractor (re-confirm the `f3 == f9+f10` invariant on this machine's data).
2. Tools/latency parse from the transcript JSONL and **merge with** the `.db` tokens under one `agent='antigravity'` session.
3. Token usage + Burn show **all four agents**; Antigravity tokens `exact`; cost shows tokens-only (rack-rate only if model pinned, else NULL + note).
4. `cc doctor` detects `~/.gemini/antigravity-cli/`; empty/aborted conversations degrade to tools-only without errors.
5. **No regression** to the other three agents.

## Verification (demo)

All four agents visible across the core panels. A real Antigravity conversation shows decoded exact tokens (matching the standalone extractor) and its tools/latency from the transcript, unified in one session row — proving the seam handles a non-JSONL, multi-source agent with no code changes to the panels.

## Risks & open questions

- **Model identification (open).** `gen_metadata` gives tokens but the model is unverified; check `trajectory_metadata_blob`. No model → `cost_estimated_usd` NULL + "model unknown" note (never a guessed rate). This is the one place Antigravity may stay money-blind.
- **Protobuf reader port** — validate the TS varint/wire reader against the Python output byte-for-byte on a known `.db`.
- **f9/f10 labels + f1-as-cache** remain inferred — surface input/output totals (solid), don't over-claim the splits.
- Very low volume (2–3 conversations) — fine for correctness, thin for trend panels.
