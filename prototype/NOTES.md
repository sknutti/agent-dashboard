# Prototype notes — Command Centre UI

**Question:** Does our data model + core-panel set cover everything once rendered dense, before we build Phase 0/1?

**Artifact:** `dashboard-prototype.html` (vanilla, mock data) — 3 variants on one route, switch via `?variant=A|B|C` / floating bar / ←→ keys. Run: `bun agent-dashboard/prototype/serve.ts` → http://localhost:4321.

- **A — Mission Control deck** (density-first, all panels at once)
- **B — Agent-first** (one column per agent, compare verticals; shows Pi branches + per-agent OTEL)
- **C — Money-first / Burn-led** (Burn hero + dual-cost + subscription savings)

## Candidate gaps surfaced (VERDICT: TBD — Scott to confirm)

1. **Fidelity is per-FIGURE, not per-agent.** Within one agent, tokens are `exact` but rack-rate cost is `estimated`. A single `sessions.fidelity` column can't express that. → Likely: keep `fidelity` for tokens; treat cost fidelity as *implicit* (populated `cost_usd` = exact, `cost_estimated_usd` = estimated) and badge each figure independently in the UI. Confirm + note in CONTEXT/Phase-0.
2. **Reasoning tokens as a first-class segment?** Codex `reasoning_output_tokens` + Antigravity f9/f10 split are folded into "output" in the token mix bar. Decide: separate segment or not (Phase-2 open Q). Affects the bar + rack-rate pricing.
3. **Antigravity = tokens-exact AND cost-fully-absent** renders as "est — model unknown" — confirmed the empty-state reads OK, not broken.
4. **Never-merge rule** is visible: Burn receipts show a "Σ comparable (estimated)" row; native shown per-agent but NOT summed. Confirm this is the right headline.
5. **Range switcher (today/7d/30d) + local-time bucketing** not modeled — panels hardcode 30d. Not a data gap, but every panel needs the toggle.
6. **Low-sample badges** (Pi/Antigravity low volume) not shown — spec wants them under thresholds.
7. **Per-day Burn driver override + evidence** (PATCH) shown only as aggregate %; the editable per-day tag isn't prototyped.

## Verdict / winner — DECIDED

**Variant B (agent-first)** wins, grafting **Tool latency** (from A) + **Subscription savings** (from C). New requirement: **click-through drill-downs** on per-agent card cells (errors / tokens / tools → read-only detail). Gaps **#1** (fidelity per-figure) and **#2** (reasoning tokens first-class) folded in.

Folded into durable docs:
- `CONTEXT.md` — Fidelity redefined as per-figure (cost fidelity implicit by column).
- `ADR-0003` — agent-first UI + drill-downs (+ obs/ops boundary: see now, act in Phase 6).
- Phase 0 — schema adds `reasoning_tokens`; `fidelity` scoped to tokens; shell gets first-class drill-down `Sheet` plumbing.
- Phase 1 — agent-first IA section, grafts, drill-down API wiring, reasoning segment, per-figure badges.
- Phase 2 / Phase 4 — reasoning-token mapping (Codex `reasoning_output`; Antigravity f9).

The HTML was collapsed to the single chosen design (switcher + A/C removed) **as a reference mock**. Gaps #5–#7 (range toggle, low-sample badges, per-day Burn driver override) remain unbuilt-UI, tracked for Phase 1/Phase 5.

### Iteration affordances — FOLDED into docs (2026-06-09)

All concrete affordances from iterations 2–3 are now in the durable docs:
- **Phase 1 → "Validated affordances"**: icon-only fidelity badge · token-mix tooltip · all Activity items drill (incl. Pi branches) · cache info-modal · OTEL on/off indicator by model name · Burn agent-dropdown + dated heatmap (caption, weekly axis, per-cell date) · full-width Live sessions `<details>` accordion → scrollable raw-JSONL (300px).
- **Phase 1 → "Tracked UI affordances"**: range toggle, low-sample badges, per-day Burn driver override (cite master §16/§17/§11.3).
- **ADR-0003** → "Validated affordances" note. **Phase 0** → shell primitives (details accordion, info-modal, fidelity icon, OTEL indicator).

**Status:** UI validation COMPLETE. Server stopped. This prototype is throwaway — the decisions live in the docs above. Delete `prototype/` when Phase 1 builds the real page (or keep as a visual reference until then). Restart anytime: `bun agent-dashboard/prototype/serve.ts`.
