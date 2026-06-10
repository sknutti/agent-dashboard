<script lang="ts">
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import McpPanel from "../lib/components/panels/McpPanel.svelte";
  import McpSchemaPanel from "../lib/components/panels/McpSchemaPanel.svelte";
  import SkillEconomicsPanel from "../lib/components/panels/SkillEconomicsPanel.svelte";
  import ContextHealthPanel from "../lib/components/panels/ContextHealthPanel.svelte";
  import SkillsRegistryPanel from "../lib/components/panels/SkillsRegistryPanel.svelte";
</script>

<div class="page">
  <CollapsibleSection id="mcp" title="MCP servers" subtitle="the centerpiece — per-server, per-tool latency">
    <div class="stack">
      <McpPanel />
      <McpSchemaPanel />
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="skill-economics" title="Skill economics" subtitle="token cost per skill">
    <SkillEconomicsPanel />
  </CollapsibleSection>

  <CollapsibleSection id="context-registry" title="Context health & registry">
    <div class="grid-3">
      <ContextHealthPanel />
      <SkillsRegistryPanel />
    </div>
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .grid-3 {
      grid-template-columns: 1fr;
    }
  }
</style>
