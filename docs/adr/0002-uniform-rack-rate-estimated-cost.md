# Compute a uniform rack-rate estimated cost for every agent, alongside (never merged with) native cost

Every Agent gets an **estimated cost** = `tokens × API list price` from a maintained per-model price table — the same method for all four — always rendered with the `estimated` Fidelity badge, default-visible. Native cost (Claude `total_cost_usd`, Pi `usage.cost.total`) is kept as a separate exact figure where it exists. The two are **never summed into a single total**.

## Status

accepted — refines the master spec's Resolved #7 ("hybrid: native where present, tokens-only otherwise, never fabricate USD") and Open Q #2 ("price table declined").

## Context

Scott's goal is to know *"what this work would cost at API rates if I weren't on a subscription."* That's a rack-rate (notional) number, not what he actually paid. The master spec previously declined a per-model price table to avoid estimates masquerading as measurements.

## Why this doesn't violate the fidelity rule

The rule is "don't let an estimate look exact," not "never estimate." The `estimated` Fidelity badge is exactly the mechanism for this. So an explicitly-labeled estimate is honest, not fabrication.

## Why uniform (all agents), not just Codex/Antigravity

Native USD is computed per-vendor under plan-specific semantics, so it is **not comparable agent-to-agent**. A rack-rate estimate uses one method for all four, so it *is* comparable — making it the honest cross-agent money axis and avoiding the trap of adding Claude's exact $ to Codex's estimated $. Where native cost also exists (Claude, Pi), `estimated − native` surfaces **subscription savings**.

## Consequences / constraints

- **Schema (Phase 0):** reserve both `cost_usd` (native, exact, nullable) and `cost_estimated_usd` (rack-rate, estimated, nullable) columns; price table as config (`config/prices.yaml`).
- **Engine (Phase 1):** the rack-rate computation debuts with Claude (first real tokens), so the `estimated` cost path exists before any second agent; phases 2–4 just supply tokens + model id and reuse it.
- **Model id is required to price.** Codex/Pi/Claude expose it. **Antigravity's model is unverified** (token counts decoded, model not yet) — if it can't be pinned, Antigravity's `cost_estimated_usd` stays NULL with a visible "model unknown" note rather than a guessed rate.
- **Unknown-model fallback:** any model absent from the price table → `cost_estimated_usd` NULL + flagged, never a guessed rate.
- **Never merge** native and estimated into one headline number; cross-agent money comparison uses estimated-for-all; tokens remain the rawest exact unit.
- Price table drifts over time and must be maintained; stale prices silently skew estimates.
