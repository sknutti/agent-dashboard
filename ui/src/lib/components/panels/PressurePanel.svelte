<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getPressure } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, relTime } from "../../format";

  const res = resource(() => `pressure:${ui.range}`, () => getPressure(ui.range));
  const d = $derived(res.data);
  const calm = $derived(!!d && d.retryExhaustion === 0 && d.compaction === 0 && d.apiErrors.length === 0);
</script>

<Card title="Pressure" icon="alert" kicker="retry exhaustion · compaction · api errors">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if res.error && !res.data}
    <EmptyState title="" error onRetry={res.reload} />
  {:else if d}
    <div class="tiles">
      <div class="tile" class:hot={d.retryExhaustion > 0}>
        <span class="big mono">{compact(d.retryExhaustion)}</span>
        <span class="lbl">retry exhaustion <span class="thr">(≥{d.threshold} attempts)</span></span>
      </div>
      <div class="tile" class:hot={d.compaction > 0}>
        <span class="big mono">{compact(d.compaction)}</span>
        <span class="lbl">compactions</span>
      </div>
      <div class="tile" class:hot={d.apiErrors.length > 0}>
        <span class="big mono">{compact(d.apiErrors.length)}</span>
        <span class="lbl">recent api errors</span>
      </div>
    </div>
    {#if d.apiErrors.length}
      <div class="errs">
        {#each d.apiErrors as e (e.timestamp)}
          <div class="erow">
            <span class="ecode mono">{e.status_code ?? "—"}</span>
            <span class="emsg" title={e.error_message ?? ""}>{e.error_message ?? "(no message)"}</span>
            <span class="eatt mono dim">{e.attempt_count != null ? `#${e.attempt_count}` : ""}</span>
            <span class="ewhen mono dim">{relTime(e.timestamp)}</span>
          </div>
        {/each}
      </div>
    {:else if calm}
      <p class="calm">No retry exhaustion, compaction, or API errors in range — clear.</p>
    {/if}
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .tile.hot { border-color: var(--red); }
  .tile.hot .big { color: var(--red); }
  .big { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.1; }
  .lbl { font-size: 11px; color: var(--text-dim); }
  .thr { color: var(--text-subtle); }
  .errs { margin-top: 14px; display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  .erow { display: grid; grid-template-columns: 40px 1fr 40px 64px; gap: 8px; align-items: center; }
  .ecode { color: var(--red); text-align: right; }
  .emsg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .eatt, .ewhen { text-align: right; }
  .calm { margin: 14px 0 0; font-size: 12.5px; color: var(--text-dim); }
  .dim { color: var(--text-subtle); }
  @media (max-width: 520px) {
    .tiles { grid-template-columns: 1fr; }
  }
</style>
