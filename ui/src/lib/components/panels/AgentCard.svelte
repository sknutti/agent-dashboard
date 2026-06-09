<script lang="ts">
  import FidelityBadge from "../ui/FidelityBadge.svelte";
  import OtelIndicator from "../ui/OtelIndicator.svelte";
  import Badge from "../ui/Badge.svelte";
  import { openDrill } from "../../stores.svelte";
  import { compact, usd, pct, AGENT_NAMES } from "../../format";
  import type { AgentCardData } from "../../api";

  let { agent }: { agent: AgentCardData } = $props();

  const name = $derived(AGENT_NAMES[agent.id] ?? agent.id);
  const hasData = $derived(agent.sessions > 0);
  const ADAPTER_PHASE: Record<string, string> = { codex: "Phase 2", pi: "Phase 3", antigravity: "Phase 4" };

  // Token-mix segments (ADR-0003 gap #2: reasoning is first-class). The bar shows
  // segments; the input·output·reasoning·cacheR·cacheC breakdown is on hover.
  const SEG_DEFS = [
    { key: "output", label: "output", color: "var(--accent-from)" },
    { key: "input", label: "input", color: "var(--cyan)" },
    { key: "reasoning", label: "reasoning", color: "#a78bfa" },
    { key: "cacheCreate", label: "cache write", color: "var(--amber)" },
    { key: "cacheRead", label: "cache read", color: "var(--text-subtle)" },
  ] as const;
  const segs = $derived.by(() => {
    const t = agent.tokens;
    const total = t.total || 1;
    return SEG_DEFS.map((s) => ({
      ...s,
      val: (t as any)[s.key] as number,
      pctOf: ((t as any)[s.key] as number) / total,
    })).filter((s) => s.val > 0);
  });
  const mixTitle = $derived(
    segs.map((s) => `${s.label}: ${compact(s.val)} (${pct(s.pctOf, 0)})`).join("\n"),
  );

  function drill(metric: string, outcome?: string) {
    openDrill({
      title: `${name} · ${metric}`,
      subtitle: outcome ? `${outcome} sessions` : "sessions",
      agent: agent.id,
      outcome,
      query: `GET /api/sessions?agent=${agent.id}${outcome ? `&outcome=${outcome}` : ""}`,
    });
  }
</script>

<div class="agent-card" class:dim={!hasData}>
  <header>
    <div class="name-row">
      <span class="name">{name}</span>
      <OtelIndicator on={agent.otel} />
    </div>
    <div class="meta-row">
      {#if agent.cost === "native"}
        <Badge tone="green">native $</Badge>
      {:else}
        <Badge tone="amber">est $ only</Badge>
      {/if}
    </div>
  </header>

  {#if !hasData}
    <p class="not-detected">
      {#if agent.id === "claude_code"}No sessions in range{:else}Adapter ships in {ADAPTER_PHASE[agent.id] ?? "a later phase"}{/if}
    </p>
  {:else}
    <!-- Tokens + mix bar -->
    <button class="block-btn" onclick={() => drill("tokens")} title="Open this agent's sessions">
      <div class="tok-head">
        <span class="tok-total mono">{compact(agent.tokens.total)}</span>
        <FidelityBadge fidelity="exact" />
        <span class="tok-label">tokens</span>
      </div>
      <div class="mixbar" title={mixTitle} aria-label={mixTitle}>
        {#each segs as s (s.key)}
          <span class="mixseg" style="width:{(s.pctOf * 100).toFixed(2)}%;background:{s.color}"></span>
        {/each}
      </div>
    </button>

    <!-- Cost: native + estimated, each badged by its own fidelity -->
    <div class="cost-row">
      <div class="cost">
        <span class="cost-val mono">{usd(agent.costEstimatedUsd)}</span>
        <FidelityBadge fidelity="estimated" />
        <span class="cost-lbl">rack-rate</span>
      </div>
      <div class="cost">
        {#if agent.costUsd != null}
          <span class="cost-val mono native">{usd(agent.costUsd)}</span>
          <FidelityBadge fidelity="exact" />
          <span class="cost-lbl">native</span>
        {:else}
          <span class="cost-val mono muted">—</span>
          <span class="cost-lbl">{agent.cost === "native" ? "native via OTEL" : "no native $"}</span>
        {/if}
      </div>
    </div>

    <!-- Stat cells (clickable drill-downs) -->
    <div class="cells">
      <button class="cell" onclick={() => drill("sessions")}>
        <span class="cell-val mono">{agent.sessions}</span>
        <span class="cell-label">sessions</span>
      </button>
      <button class="cell" onclick={() => drill("tools")}>
        <span class="cell-val mono">{compact(agent.tools)}</span>
        <span class="cell-label">tool calls</span>
      </button>
      <button class="cell" class:has-err={agent.errors > 0} onclick={() => drill("errors", "errored")}>
        <span class="cell-val mono">{agent.errors}</span>
        <span class="cell-label">errors</span>
      </button>
    </div>

    <div class="cache-line">
      <span class="cache-lbl">cache hit</span>
      <span class="cache-val mono" class:good={(agent.cacheRate ?? 0) >= 0.7}>{pct(agent.cacheRate)}</span>
    </div>
  {/if}
</div>

<style>
  .agent-card {
    display: flex;
    flex-direction: column;
    gap: 13px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    transition: border-color 0.2s var(--ease);
  }
  .agent-card:hover {
    border-color: var(--border-glow);
  }
  .agent-card.dim {
    opacity: 0.66;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-size: 14px;
    font-weight: 620;
  }
  .not-detected {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .block-btn {
    display: flex;
    flex-direction: column;
    gap: 7px;
    text-align: left;
    width: 100%;
  }
  .tok-head {
    display: flex;
    align-items: baseline;
    gap: 7px;
  }
  .tok-total {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
  }
  .tok-label,
  .cost-lbl,
  .cell-label,
  .cache-lbl {
    font-size: 10.5px;
    color: var(--text-subtle);
  }
  .mixbar {
    display: flex;
    height: 7px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    cursor: help;
  }
  .mixseg {
    height: 100%;
  }
  .cost-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .cost {
    display: flex;
    align-items: baseline;
    gap: 5px;
    flex-wrap: wrap;
  }
  .cost-val {
    font-size: 14px;
    font-weight: 600;
    color: var(--amber);
  }
  .cost-val.native {
    color: var(--cyan);
  }
  .cost-val.muted {
    color: var(--text-subtle);
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    text-align: left;
    transition: all 0.15s var(--ease);
  }
  .cell:hover {
    border-color: var(--border-glow);
    background: color-mix(in srgb, var(--accent-from) 10%, var(--surface-2));
  }
  .cell.has-err .cell-val {
    color: var(--red);
  }
  .cell-val {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .cache-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cache-val {
    font-size: 12px;
    color: var(--text-dim);
  }
  .cache-val.good {
    color: var(--green);
  }
</style>
