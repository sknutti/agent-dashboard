# Agent Dashboard (Command Centre)

A localhost-only observability + operations dashboard that reads the on-disk session logs of multiple coding agents, stores them in one SQLite file, and renders a dense dashboard. Zero outbound network calls.

## Language

**Agent**:
One supported coding-agent CLI whose local logs we ingest. Exactly four: Claude Code, Codex, Pi, Antigravity.
_Avoid_: tool, assistant, model (a model is what an Agent runs, not the Agent itself).

**Adapter**:
A per-Agent module that finds and parses that Agent's own logs into the shared normalized row shapes. One Adapter per Agent.
_Avoid_: parser, connector, plugin.

**Fidelity**:
The measurement quality of a single *figure* — `exact` (counted from logs) or `estimated` (calibrated) — attached **per figure, not per Agent or session**. Within one Agent, tokens can be `exact` while cost is `estimated`. Token fidelity is the `fidelity` column; **cost fidelity is implicit** (a populated `cost_usd` is exact-native, a `cost_estimated_usd` is estimated-rack-rate). Each number is badged by its own fidelity; estimates must never visually pass as measurements.

**Burn**:
Token spend reframed as a behavioral signal ("am I getting fluent or just expensive?") — the cross-agent daily-spend view (Panel 34), not a raw token count.

**Native cost**:
The USD figure a vendor stamps on its own logs — Claude `total_cost_usd`, Pi `usage.cost.total`. Exact, but computed per-vendor under plan-specific semantics, so **not comparable agent-to-agent**. Only Claude and Pi emit it.
_Avoid_: real cost, actual cost (it's still notional under a subscription).

**Estimated cost (rack-rate)**:
A USD estimate **we** compute as `tokens × API list price` from a maintained per-model price table — the same method for **all four Agents**, so it *is* comparable. Answers "what would this work cost at API rates if I weren't on a subscription?" Always carries `estimated` Fidelity. The cross-agent money axis.
_Avoid_: estimated cost being merged into a total with Native cost.

**Subscription savings**:
For Agents with both figures (Claude, Pi): `Estimated cost − Native cost` — what the subscription saves vs. paying API rates.

**Effective tokens**:
The "work" token figure — `input + output + reasoning + cache-write` — i.e. **total minus cache-read**. Cache-read is replayed context, not new work, and on agentic workloads it's ~95% of raw tokens; excluding it is what makes the other categories legible. The `effective_tokens` DB column, the Project-breakdown rollup, and the token-mix bars all use this exact figure. Cache-read lives in the Cache panel, not the mix.
_Avoid_: "generative tokens" or any near-synonym that silently drops cache-write — effective tokens **keeps** cache-write.

**Observability layer**:
The read-only half of the product — ingest + panels that show what the Agents did (tokens, latency, MCP, cache, outcomes, Burn). Multi-agent by nature.
_Avoid_: monitoring, metrics.

**Operations layer**:
The write half — acting on agents: Mission Control dispatcher, HITL decisions/inbox, schedules, Telegram pager, emergency stop. **Claude-Code-only** (it spawns and kills `claude -p` processes); does not generalize across Agents.
_Avoid_: ops, control plane.

**Foundation**:
The agent-agnostic substrate every Agent rides on: the multi-agent schema, the Adapter seam + orchestrator, the dashboard shell, and the OTEL ingest endpoints. Contains no Agent-specific logic.

**Phase**:
One self-contained delivery slice, documented in its own file under `docs/phases/`. Phase 0 = Foundation; Phases 1–4 = one Agent each (Claude → Codex → Pi → Antigravity); Phase 5 = Operations layer.

## Relationships

- The **Foundation** defines the **Adapter** seam; each **Agent** contributes exactly one **Adapter**.
- The **Observability layer** spans all four **Agents**; the **Operations layer** covers only Claude Code.
- Every token figure produced by an **Adapter** carries a **Fidelity**; **Burn** aggregates them per **Agent** per day.
- Every **Agent** gets an **Estimated cost** (rack-rate, uniform); only Claude and Pi also get a **Native cost**. The two are never summed into one total; **Estimated cost** is the cross-agent money axis, **tokens** the rawest one.
- A **Phase** delivers either the Foundation, one Agent's Adapter + panels, or the Operations layer — never a mix.

## Example dialogue

> **Dev:** "Does adding Pi touch the Operations layer at all?"
> **Scott:** "No. Pi is an Agent — it gets an Adapter and lights up the Observability panels. The Operations layer is Claude-only and ships last, in its own Phase."
> **Dev:** "And Antigravity's tokens — are those exact?"
> **Scott:** "Exact, but decoded from a protobuf blob, not native. No USD cost though, so Burn shows it tokens-only."

## Flagged ambiguities

- "the dashboard" was used to mean both the whole product and the read-only Observability half — resolved: **Observability layer** vs **Operations layer** are distinct, and Phase ordering deliberately ships all Observability (Phases 0–4) before any Operations (Phase 5).
