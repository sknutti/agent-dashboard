<script lang="ts">
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import RangeToggle from "../lib/components/ui/RangeToggle.svelte";
  import KpiRow from "../lib/components/panels/KpiRow.svelte";
  import AgentCard from "../lib/components/panels/AgentCard.svelte";
  import LiveSessionsPanel from "../lib/components/panels/LiveSessionsPanel.svelte";
  import TokenUsagePanel from "../lib/components/panels/TokenUsagePanel.svelte";
  import BurnPanel from "../lib/components/panels/BurnPanel.svelte";
  import CachePanel from "../lib/components/panels/CachePanel.svelte";
  import OutcomesPanel from "../lib/components/panels/OutcomesPanel.svelte";
  import ToolLatencyPanel from "../lib/components/panels/ToolLatencyPanel.svelte";
  import SavingsPanel from "../lib/components/panels/SavingsPanel.svelte";
  import ProjectBreakdownPanel from "../lib/components/panels/ProjectBreakdownPanel.svelte";
  import AgentFanoutPanel from "../lib/components/panels/AgentFanoutPanel.svelte";
  import HookActivityPanel from "../lib/components/panels/HookActivityPanel.svelte";
  import EditAcceptancePanel from "../lib/components/panels/EditAcceptancePanel.svelte";
  import ProductivityPanel from "../lib/components/panels/ProductivityPanel.svelte";
  import PressurePanel from "../lib/components/panels/PressurePanel.svelte";
  import { getAgents } from "../lib/api";
  import { resource } from "../lib/resource.svelte";
  import { ui, setRange } from "../lib/stores.svelte";

  const agentsRes = resource(() => `agents:${ui.range}`, () => getAgents(ui.range));
  // Order comes from agents.yaml via each card's `order` (review #17) — no hardcoded
  // id list. The API already returns them sorted; sorting here is belt-and-braces.
  const agents = $derived(
    (agentsRes.data?.agents ?? []).slice().sort((a, b) => a.order - b.order),
  );
</script>

<div class="page">
  <div class="page-head">
    <p class="kicker">Observability · {ui.range}</p>
    <RangeToggle value={ui.range} onChange={setRange} />
  </div>

  <p class="kicker block-kicker">Today · live</p>
  <KpiRow />

  <div class="block">
    <p class="kicker block-kicker">Agents · {ui.range}</p>
    {#if !agents.length}
      <div class="agent-grid">
        {#each Array(4) as _, i (i)}<div class="skel-card"></div>{/each}
      </div>
    {:else}
      <div class="agent-grid">
        {#each agents as a (a.id)}<AgentCard agent={a} />{/each}
      </div>
    {/if}
  </div>

  <CollapsibleSection id="live" title="Live sessions" subtitle="in-flight, across all agents">
    <LiveSessionsPanel />
  </CollapsibleSection>

  <CollapsibleSection id="tokens-burn" title="Token usage & Burn" subtitle="where the spend goes, and whether it's making you fluent">
    <div class="stack">
      <TokenUsagePanel />
      <BurnPanel />
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="observability" title="Observability" subtitle="latency · cache · outcomes · projects · subagents · pressure">
    <div class="grid-2">
      <CachePanel />
      <OutcomesPanel />
    </div>
    <div class="grid-2">
      <ToolLatencyPanel />
      <SavingsPanel />
    </div>
    <div class="grid-2">
      <ProjectBreakdownPanel />
      <AgentFanoutPanel />
    </div>
    <div class="grid-2">
      <HookActivityPanel />
      <EditAcceptancePanel />
    </div>
    <div class="grid-2">
      <ProductivityPanel />
      <PressurePanel />
    </div>
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .block-kicker {
    margin: 0 0 12px 4px;
  }
  .agent-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  @media (max-width: 1080px) {
    .agent-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .skel-card {
    height: 220px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    opacity: 0.5;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
    align-items: stretch;
  }
  @media (max-width: 860px) {
    .grid-2 {
      grid-template-columns: 1fr;
    }
  }
</style>
