<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getToolLatency } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { ms, pct, compact } from "../../format";

  const res = resource(() => `tools:${ui.range}`, () => getToolLatency(ui.range));
  const tools = $derived(res.data?.tools ?? []);

  function flag(p95: number | null): "slow" | "fast" | "" {
    if (p95 == null) return "";
    if (p95 >= 10_000) return "slow";
    if (p95 < 500) return "fast";
    return "";
  }
</script>

<Card title="Tool latency" icon="wrench" kicker="p50 · p95 · max — sorted by p95">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !tools.length}
    <EmptyState icon="wrench" title="No tool calls in range" message="Per-tool p50/p95/max + error rate, sorted by p95. Red flags at p95 ≥ 10s." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="tbl">
      <div class="row head">
        <span class="c-tool">tool</span>
        <span class="c-n">N</span>
        <span class="c-num">p50</span>
        <span class="c-num">p95</span>
        <span class="c-num">max</span>
        <span class="c-num">err</span>
      </div>
      <div class="scroll">
        {#each tools as t (t.tool)}
          <div class="row">
            <span class="c-tool" title={t.tool}>
              {t.tool}
              {#if flag(t.p95) === "slow"}<span class="tag slow">· slow</span>{:else if flag(t.p95) === "fast"}<span class="tag fast">· fast</span>{/if}
            </span>
            <span class="c-n mono">{compact(t.calls)}</span>
            <span class="c-num mono">{ms(t.p50)}</span>
            <span class="c-num mono" class:bad={flag(t.p95) === "slow"} class:good={flag(t.p95) === "fast"}>{ms(t.p95)}</span>
            <span class="c-num mono dim">{ms(t.max)}</span>
            <span class="c-num mono" class:bad={t.errorRate > 0}>{t.errors ? pct(t.errorRate, 0) : "0"}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .tbl { font-size: 12px; }
  .scroll { max-height: 300px; overflow-y: auto; }
  .row {
    display: grid;
    grid-template-columns: 1fr 44px 56px 56px 56px 48px;
    gap: 6px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  .row.head {
    position: sticky;
    top: 0;
    background: var(--surface);
    color: var(--text-subtle);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
  }
  .c-tool { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .c-n, .c-num { text-align: right; }
  .dim { color: var(--text-subtle); }
  .bad { color: var(--red); }
  .good { color: var(--cyan); } /* "good/fast" is cyan, not green (colourblind-safe vs red) */
  .tag { font-size: 9.5px; font-weight: 600; }
  .tag.slow { color: var(--red); }
  .tag.fast { color: var(--cyan); }
</style>
