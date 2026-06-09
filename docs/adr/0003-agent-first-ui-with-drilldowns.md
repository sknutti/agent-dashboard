# Agent-first UI with click-through drill-downs

The command page's primary axis is the **Agent**: a per-agent card per Agent (Claude/Codex/Pi/Antigravity) showing that Agent's vertical slice (tokens, cost, sessions/tools/errors, cache, OTEL, Pi branches), with cross-agent Burn and Live sessions shared below. Per-agent card cells are **clickable → filtered detail views** (e.g. error count → the actual errored sessions). Grafted in from the prototype's other variants: a full **Tool latency** panel and a **Subscription savings** panel.

## Status

accepted — chosen from the `/prototype` UI exploration (variant B over A/C); deviates from master spec §17's Claude-centric single command-page layout.

## Context

The near-term goal is cross-agent visibility ([ADR-0001](0001-typescript-svelte-bun-stack.md) context, INDEX invariant). A density-first command deck (prototype variant A) and a Burn-led layout (variant C) both buried the agent-to-agent comparison. Variant B made the four Agents the primary axis, which matches the goal.

## Decision

- **Layout:** per-agent cards as the primary grid; shared cross-agent Burn + Live sessions below. Tool latency (from variant A) and Subscription savings (from variant C) are first-class panels.
- **Drill-down IA:** card cells are links to filtered detail — errors → `GET /api/sessions?agent=X&outcome=errored` → list → `GET /api/sessions/{id}/details`; tokens → that agent's session list; tools → that agent's tool breakdown. Detail opens in a `Sheet`/route per the shell.
- **Boundary (load-bearing):** drill-down is **read-only observability** (Phase 1). *Acting* on what you find — re-run, dispatch a fix — is the **Operations layer (Phase 6)**. The card cell links must be designed so a Phase 6 "act" affordance slots in without restructuring.

## Considered and rejected

- **Variant A — Mission Control deck (density-first):** great at-a-glance, but cross-agent comparison is implicit. Kept its Tool latency panel.
- **Variant C — Money-first / Burn-led:** strong for the cost story, but makes money the primary axis over agents. Kept its Subscription savings panel.

## Consequences

- Phase 0 shell must treat **detail drill-down** (Sheet/route + filtered list) as a first-class navigation pattern, not a late add.
- Phase 1 core panels are arranged agent-first; the existing `/api/sessions` filters (agent, outcome, model) back the drill-downs — little new API.
- Keeps the Phase 1 (observability) / Phase 6 (operations) seam clean: see, don't act, until Phase 6.

## Validated affordances (prototype iterations)

The throwaway prototype (`/prototype`) confirmed the concrete affordances now specified in [phase-1 → Validated affordances](../phases/phase-1-claude-code.md): icon-only fidelity badges; token-mix as a hover tooltip; every Activity item drillable (incl. Pi branches); a cache info-modal; OTEL as a compact on/off indicator by the model name; a Burn agent-dropdown + dated heatmap (caption, weekly axis, per-cell date); and full-width Live sessions as `<details>` accordions opening a scrollable raw-JSONL feed. The prototype is throwaway — these decisions, not its code, are the keepable artifact.
