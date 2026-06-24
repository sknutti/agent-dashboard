<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getToolLatency } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { ms, pct, compact } from "../../format";

  const res = resource(() => `tools:${ui.range}`, () => getToolLatency(ui.range));
  const tools = $derived(res.data?.tools ?? []);
  const hasHumanGated = $derived(tools.some((t) => t.humanGated));

  // Human-gated tools measure your response time, not execution — never flag them
  // slow/fast (the p95 is think-time, not a performance signal).
  function flag(t: { p95: number | null; humanGated: boolean }): "slow" | "fast" | "" {
    if (t.humanGated || t.p95 == null) return "";
    if (t.p95 >= 10_000) return "slow";
    if (t.p95 < 500) return "fast";
    return "";
  }
</script>

<Card title="Tool latency" icon="wrench" kicker="p50 · p95 · max — sorted by p95">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !tools.length}
    <EmptyState icon="wrench" title="No tool calls in range" message="Per-tool p50/p95/max + error rate, sorted by p95. Red flags at p95 ≥ 10s." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="tbl">
      <div class="row head">
        <span class="c-tool">tool</span>
        <span class="c-n">NUM</span>
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
              {#if t.humanGated}<span class="tag human" title="Latency is your response time, not tool execution — excluded from the slow ranking">· human-gated</span>{:else if flag(t) === "slow"}<span class="tag slow">· slow</span>{:else if flag(t) === "fast"}<span class="tag fast">· fast</span>{/if}
            </span>
            <span class="c-n mono">{compact(t.calls)}</span>
            <span class="c-num mono" class:u-subtle={t.humanGated}>{ms(t.p50)}</span>
            <span class="c-num mono" class:bad={flag(t) === "slow"} class:good={flag(t) === "fast"} class:u-subtle={t.humanGated}>{ms(t.p95)}</span>
            <span class="c-num mono u-subtle">{ms(t.max)}</span>
            <span class="c-num mono" class:bad={t.errorRate > 0}>{t.errors ? pct(t.errorRate, 0) : "0"}</span>
          </div>
        {/each}
      </div>
      {#if hasHumanGated}
        <p class="note">Human-gated tools (AskUserQuestion, ExitPlanMode) measure your response time, not execution — sunk to the bottom, never flagged slow.</p>
      {/if}
    </div>
  {/if}
</Card>

<style>
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
  .bad { color: var(--red); }
  .good { color: var(--cyan); } /* "good/fast" is cyan, not green (colourblind-safe vs red) */
  .tag { font-size: 9.5px; font-weight: 600; }
  .tag.slow { color: var(--red); }
  .tag.fast { color: var(--cyan); }
  .tag.human { color: var(--text-subtle); font-weight: 500; }
  .note { margin: 8px 4px 0; font-size: 10.5px; line-height: 1.4; color: var(--text-subtle); }
</style>
