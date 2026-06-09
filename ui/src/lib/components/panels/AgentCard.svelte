<script lang="ts">
  import FidelityBadge from "../ui/FidelityBadge.svelte";
  import OtelIndicator from "../ui/OtelIndicator.svelte";
  import Badge from "../ui/Badge.svelte";
  import { openDrill } from "../../stores.svelte";

  export type AgentMeta = {
    id: string;
    name: string;
    otel: boolean; // telemetry currently live (always false in Phase 0)
    cost: "native" | "none";
    detected: boolean;
  };
  let { agent }: { agent: AgentMeta } = $props();

  // Clickable cells map to the read-only sessions filter they'll apply in Phase 1
  // (ADR-0003 drill-down IA). They open the wired Sheet now to prove the path.
  function drill(metric: string, query: string) {
    openDrill({
      title: `${agent.name} · ${metric}`,
      subtitle: agent.detected ? undefined : "Agent not detected on this machine",
      query,
    });
  }
  const CELLS = $derived([
    { key: "tokens", label: "Tokens", q: `GET /api/sessions?agent=${agent.id}` },
    { key: "tools", label: "Tool calls", q: `GET /api/tools?agent=${agent.id}` },
    { key: "errors", label: "Errors", q: `GET /api/sessions?agent=${agent.id}&outcome=errored` },
  ]);
</script>

<div class="agent-card" class:dim={!agent.detected}>
  <header>
    <div class="name-row">
      <span class="name">{agent.name}</span>
      <FidelityBadge fidelity="exact" />
    </div>
    <div class="meta-row">
      <OtelIndicator on={agent.otel} />
      {#if agent.cost === "native"}
        <Badge tone="green">native $</Badge>
      {:else}
        <Badge tone="amber">est $ only</Badge>
      {/if}
    </div>
  </header>

  {#if !agent.detected}
    <p class="not-detected">Not detected — enable in <span class="mono">agents.yaml</span></p>
  {/if}

  <div class="cells">
    {#each CELLS as cell (cell.key)}
      <button class="cell" onclick={() => drill(cell.label, cell.q)}>
        <span class="cell-val mono">—</span>
        <span class="cell-label">{cell.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .agent-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
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
    opacity: 0.72;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .name-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .name {
    font-size: 14px;
    font-weight: 620;
  }
  .meta-row {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .not-detected {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: auto;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 10px;
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
  .cell-val {
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
  }
  .cell-label {
    font-size: 10.5px;
    color: var(--text-subtle);
  }
</style>
