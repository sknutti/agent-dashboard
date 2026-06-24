<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState } from "../ui";
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
      <div class="tile"><span class="big u-mono">{compact(d.commits)}</span><span class="u-label">commits</span></div>
      <div class="tile"><span class="big u-mono">{compact(d.pullRequests)}</span><span class="u-label">PRs</span></div>
      <div class="tile"><span class="big u-mono pos">+{compact(d.linesAdded)}</span><span class="u-label">lines added</span></div>
      <div class="tile"><span class="big u-mono neg">−{compact(d.linesRemoved)}</span><span class="u-label">lines removed</span></div>
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
  /* Tile figure: kept local because `.pos`/`.neg` recolour it (added/removed). */
  .big { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.1; }
  /* added = cyan, removed = amber — colourblind-safe (no red/green pairing) */
  .pos { color: var(--cyan); }
  .neg { color: var(--amber); }
  @media (max-width: 520px) {
    .tiles { grid-template-columns: repeat(2, 1fr); }
  }
</style>
