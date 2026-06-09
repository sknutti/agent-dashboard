<script lang="ts">
  import Card from "../lib/components/ui/Card.svelte";
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
  import McpPanel from "../lib/components/panels/McpPanel.svelte";
</script>

<div class="page">
  <CollapsibleSection id="mcp" title="MCP servers" subtitle="the centerpiece — per-server, per-tool latency">
    <McpPanel />
  </CollapsibleSection>

  <CollapsibleSection id="skill-economics" title="Skill economics" subtitle="token cost per skill">
    <Card title="Skill economics" icon="sparkles" kicker="cost by skill">
      <EmptyState icon="sparkles" title="No skill costs yet" message="Token cost per skill, sorted by total spend." />
    </Card>
  </CollapsibleSection>

  <CollapsibleSection id="context-registry" title="Context health & registry">
    <div class="grid-3">
      <Card title="Context health" icon="info" kicker="settings scan">
        <EmptyState icon="info" title="Not scanned" message="A read-only scan of settings.json + CLAUDE.md: line / rule / MCP / hook counts. No LLM." />
      </Card>
      <Card title="Skills registry" icon="box" kicker="all skills · autonomy">
        <EmptyState icon="box" title="No skills indexed" message="Every skill with its environment and autonomy level." />
      </Card>
    </div>
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 14px;
    align-items: stretch;
  }
  @media (max-width: 860px) {
    .grid-3 {
      grid-template-columns: 1fr;
    }
  }
</style>
