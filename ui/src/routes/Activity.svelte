<script lang="ts">
  import Card from "../lib/components/ui/Card.svelte";
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
</script>

<div class="page">
  <CollapsibleSection id="patterns" title="Patterns" subtitle="when and how you work">
    <div class="grid-2">
      <Card title="Activity heatmap" icon="activity" kicker="30-day grid">
        <EmptyState icon="activity" title="No activity yet" message="A GitHub-style grid lights up per day, per agent, as sessions accrue." />
      </Card>
      <Card title="Token charts" icon="cpu" kicker="14-day, by model">
        <EmptyState icon="cpu" title="No token history" message="Stacked daily token charts by model and agent." />
      </Card>
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="firehose" title="Telemetry firehose" subtitle="raw OTEL events as they arrive">
    <Card title="OTEL firehose" icon="zap" kicker="live feed">
      <EmptyState icon="zap" title="Waiting for telemetry" message="Once Claude Code OTEL is enabled, every event streams here filterable by name. The ingest endpoints are already live." />
    </Card>
  </CollapsibleSection>

  <CollapsibleSection id="skills-failures" title="Top skills & failures">
    <div class="grid-2">
      <Card title="Top skills" icon="sparkles" kicker="most used">
        <EmptyState icon="sparkles" title="No skill usage" message="Most-invoked skills with their token cost." />
      </Card>
      <Card title="Failures" icon="alert" kicker="crashed sessions">
        <EmptyState icon="alert" title="No failures" message="Crashed sessions and their error messages land here." />
      </Card>
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="all-sessions" title="All sessions" subtitle="searchable, filterable">
    <Card title="All sessions" icon="layers" kicker="every agent">
      <EmptyState icon="layers" title="No sessions yet" message="A searchable, paginated table filterable by range, agent, source, and model." />
    </Card>
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    align-items: stretch;
  }
  @media (max-width: 860px) {
    .grid-2 {
      grid-template-columns: 1fr;
    }
  }
</style>
