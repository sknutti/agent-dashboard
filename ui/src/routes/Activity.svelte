<script lang="ts">
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import RangeToggle from "../lib/components/ui/RangeToggle.svelte";
  import PatternsPanel from "../lib/components/panels/PatternsPanel.svelte";
  import FirehosePanel from "../lib/components/panels/FirehosePanel.svelte";
  import TopSkillsPanel from "../lib/components/panels/TopSkillsPanel.svelte";
  import FailuresPanel from "../lib/components/panels/FailuresPanel.svelte";
  import SessionsTablePanel from "../lib/components/panels/SessionsTablePanel.svelte";
  import ContentSearchPanel from "../lib/components/panels/ContentSearchPanel.svelte";
  import { ui, setRange } from "../lib/stores.svelte";
</script>

<div class="page">
  <div class="page-head">
    <p class="kicker">Activity · {ui.range}</p>
    <RangeToggle value={ui.range} onChange={setRange} />
  </div>

  <CollapsibleSection id="patterns" title="Patterns" subtitle="when and how you work — fixed 30-day window">
    <PatternsPanel />
  </CollapsibleSection>

  <CollapsibleSection id="firehose" title="Telemetry firehose" subtitle="raw OTEL events as they arrive">
    <FirehosePanel />
  </CollapsibleSection>

  <CollapsibleSection id="skills-failures" title="Top skills & failures">
    <div class="grid-2">
      <TopSkillsPanel />
      <FailuresPanel />
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="content-search" title="Content search" subtitle="full-text across every session transcript — not just titles">
    <ContentSearchPanel />
  </CollapsibleSection>

  <CollapsibleSection id="all-sessions" title="All sessions" subtitle="searchable, filterable, across all four agents">
    <SessionsTablePanel />
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
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
