<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getProductivity } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact } from "../../format";

  const res = resource(() => `productivity:${ui.range}`, () => getProductivity(ui.range));
  const d = $derived(res.data);
</script>

<Card title="Productivity" icon="gauge" kicker="commits · PRs · lines (OTEL counters)">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !d || d.empty}
    <EmptyState icon="gauge" title="No productivity signal yet" message="Commits, PRs, and lines added/removed come from Claude Code's delta-temporality OTEL counters. They accrue as you commit under telemetry." />
  {:else}
    <div class="tiles">
      <div class="tile"><span class="big mono">{compact(d.commits)}</span><span class="lbl">commits</span></div>
      <div class="tile"><span class="big mono">{compact(d.pullRequests)}</span><span class="lbl">PRs</span></div>
      <div class="tile"><span class="big mono pos">+{compact(d.linesAdded)}</span><span class="lbl">lines added</span></div>
      <div class="tile"><span class="big mono neg">−{compact(d.linesRemoved)}</span><span class="lbl">lines removed</span></div>
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
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
  .big { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.1; }
  /* added = cyan, removed = amber — colourblind-safe (no red/green pairing) */
  .pos { color: var(--cyan); }
  .neg { color: var(--amber); }
  .lbl { font-size: 11px; color: var(--text-dim); }
  @media (max-width: 520px) {
    .tiles { grid-template-columns: repeat(2, 1fr); }
  }
</style>
