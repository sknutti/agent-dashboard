<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, MetricBar } from "../ui";
  import { getHookActivity } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, ms } from "../../format";

  const res = resource(() => `hooks:${ui.range}`, () => getHookActivity(ui.range));
  const d = $derived(res.data);
  const maxFires = $derived(Math.max(1, ...(d?.hooks ?? []).map((h) => h.fires)));
</script>

<Card title="Hook activity" icon="plug" kicker="fires · paired duration (60s cap)">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !d || d.totalFires === 0}
    <EmptyState icon="plug" title="No hook fires in range" message="Hook executions (start/complete pairs, FIFO per session) arrive over OTEL once Claude Code telemetry is on. Other agents don't emit hooks." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="summary">
      <div class="stat"><span class="big mono">{compact(d.totalFires)}</span><span class="u-label">fires</span></div>
      <div class="stat"><span class="big mono">{ms(d.avgMs)}</span><span class="u-label">avg paired ({d.paired})</span></div>
      <div class="stat"><span class="big mono">{ms(d.p50Ms)}</span><span class="u-label">p50</span></div>
    </div>
    <div class="rows">
      {#each d.hooks as h (h.hook)}
        <div class="hrow">
          <span class="hn" title={h.hook}>{h.hook}</span>
          <MetricBar value={h.fires} max={maxFires} color="var(--cyan)" ariaLabel="{h.hook}: {compact(h.fires)} fires" />
          <span class="hv u-mono u-subtle">{compact(h.fires)}</span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .summary { display: flex; gap: 24px; margin-bottom: 14px; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .big { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.1; }
  .rows { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
  .hrow { display: grid; grid-template-columns: 1fr 1fr 44px; gap: 8px; align-items: center; }
  .hn { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hv { text-align: right; }
</style>
