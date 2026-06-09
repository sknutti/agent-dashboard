<script lang="ts">
  import Card from "../lib/components/ui/Card.svelte";
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
  import InfoModal from "../lib/components/ui/InfoModal.svelte";
</script>

<div class="page">
  <CollapsibleSection id="mcp" title="MCP servers" subtitle="the centerpiece — per-server, per-tool latency">
    <Card title="MCP servers" icon="plug" kicker="latency · tokens">
      {#snippet actions()}
        <InfoModal title="Why MCP is the centerpiece">
          <p class="modal-p">Each server expands to a per-tool table (p50/p95/max/error/N). When you open it you should <em>feel</em> the slow ones — a 14s p95 reads red. This is where the dashboard earns its keep.</p>
        </InfoModal>
      {/snippet}
      <EmptyState icon="database" title="No MCP traffic yet" message="Servers with totals, avg + p95 latency. Click a server → per-tool breakdown. Slow tools (p95 ≥ 10s) flag red." />
    </Card>
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
  .modal-p {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-dim);
  }
</style>
