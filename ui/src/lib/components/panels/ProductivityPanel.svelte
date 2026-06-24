<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, Stat } from "../ui";
  import { getProductivity } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact } from "../../format";

  const res = resource(() => `productivity:${ui.range}`, () => getProductivity(ui.range));
  const d = $derived(res.data);
</script>

<Card title="Productivity" icon="gauge" kicker="commits · PRs · lines (OTEL counters)">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !d || d.empty}
    <EmptyState icon="gauge" title="No productivity signal yet" message="Commits, PRs, and lines added/removed come from Claude Code's delta-temporality OTEL counters. They accrue as you commit under telemetry." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="tiles">
      <div class="tile"><Stat label="commits" value={compact(d.commits)} big valueFirst /></div>
      <div class="tile"><Stat label="PRs" value={compact(d.pullRequests)} big valueFirst /></div>
      <div class="tile"><Stat label="lines added" value={`+${compact(d.linesAdded)}`} tone="cyan" big valueFirst /></div>
      <div class="tile"><Stat label="lines removed" value={`−${compact(d.linesRemoved)}`} tone="amber" big valueFirst /></div>
    </div>
  {/if}
</Card>

<style>
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  @media (max-width: 520px) {
    .tiles { grid-template-columns: repeat(2, 1fr); }
  }
</style>
