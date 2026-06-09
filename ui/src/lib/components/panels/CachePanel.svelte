<script lang="ts">
  import Card from "../ui/Card.svelte";
  import InfoModal from "../ui/InfoModal.svelte";
  import Badge from "../ui/Badge.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getCache } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { pct, compact, shortDate } from "../../format";

  const res = resource(() => `cache:${ui.range}`, () => getCache(ui.range));
  const d = $derived(res.data);
  const trend = $derived(d?.trend ?? []);
  const maxRate = $derived(Math.max(0.0001, ...trend.map((t) => t.hitRate ?? 0), d?.target ?? 0.7));
</script>

<Card title="Cache efficiency" icon="database" kicker="hit rate · target 70%">
  {#snippet actions()}
    <InfoModal title="Cache efficiency">
      <p class="modal-p">Hit rate = cache-read ÷ billable tokens (input + cache-read + cache-write). The 70% target line marks healthy reuse. A "low sample" badge shows under 10K billable tokens so a tiny denominator can't masquerade as a real rate. <code>n/a</code> for agents with no cache concept (e.g. Antigravity).</p>
    </InfoModal>
  {/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !d || d.hitRate == null}
    <EmptyState icon="database" title="No cache data" message="Hit-rate trend with a 70% target line, once tokens flow." />
  {:else}
    <div class="big-row">
      <div class="big" class:good={d.hitRate >= d.target}>{pct(d.hitRate)}</div>
      {#if d.lowSample}<Badge tone="amber">low sample · {compact(d.billableTokens)} billable</Badge>{/if}
    </div>
    <div class="spark" role="img" aria-label="Daily cache hit rate">
      <div class="target-line" style="bottom:{(d.target / maxRate) * 100}%"><span>70%</span></div>
      {#each trend as t (t.date)}
        <div class="col" title="{shortDate(t.date)}: {pct(t.hitRate)}">
          <div class="bar" style="height:{((t.hitRate ?? 0) / maxRate) * 100}%" class:good={(t.hitRate ?? 0) >= d.target}></div>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .modal-p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-dim); }
  .big-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .big { font-size: 34px; font-weight: 650; color: var(--amber); line-height: 1; }
  .big.good { color: var(--green); }
  .spark {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 70px;
  }
  .col { flex: 1; display: flex; align-items: flex-end; height: 100%; min-width: 0; }
  .bar {
    width: 100%;
    background: color-mix(in srgb, var(--amber) 55%, transparent);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
  }
  .bar.good { background: color-mix(in srgb, var(--green) 60%, transparent); }
  .target-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed color-mix(in srgb, var(--green) 60%, transparent);
    pointer-events: none;
  }
  .target-line span {
    position: absolute;
    right: 0;
    top: -14px;
    font-size: 9px;
    color: var(--green);
  }
</style>
