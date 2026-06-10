<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
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
    <div class="muted">Loading…</div>
  {:else if !d || d.totalFires === 0}
    <EmptyState icon="plug" title="No hook fires in range" message="Hook executions (start/complete pairs, FIFO per session) arrive over OTEL once Claude Code telemetry is on. Other agents don't emit hooks." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="summary">
      <div class="stat"><span class="big mono">{compact(d.totalFires)}</span><span class="lbl">fires</span></div>
      <div class="stat"><span class="big mono">{ms(d.avgMs)}</span><span class="lbl">avg paired ({d.paired})</span></div>
      <div class="stat"><span class="big mono">{ms(d.p50Ms)}</span><span class="lbl">p50</span></div>
    </div>
    <div class="rows">
      {#each d.hooks as h (h.hook)}
        <div class="hrow">
          <span class="hn" title={h.hook}>{h.hook}</span>
          <span class="bar"><span class="fill" style="width:{((h.fires / maxFires) * 100).toFixed(0)}%"></span></span>
          <span class="hv mono dim">{compact(h.fires)}</span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .summary { display: flex; gap: 24px; margin-bottom: 14px; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .big { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.1; }
  .lbl { font-size: 11px; color: var(--text-dim); }
  .rows { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
  .hrow { display: grid; grid-template-columns: 1fr 1fr 44px; gap: 8px; align-items: center; }
  .hn { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--cyan); }
  .hv { text-align: right; }
  .dim { color: var(--text-subtle); }
</style>
