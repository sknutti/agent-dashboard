<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getTokenUsage } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, shortDate, pct} from "../../format";
  import { AGENT_NAMES, agentFilterOptions } from "../../registry.svelte";

  // Per-agent dimension the API already returns (was collapsed to all-agents).
  const AGENTS = $derived(agentFilterOptions());
  let agent = $state("all");
  const res = resource(
    () => `tokens:${ui.range}:${agent}`,
    () => getTokenUsage(ui.range, agent === "all" ? undefined : agent),
  );

  // Roll the per-(date,model) rows up to per-day stacks.
  const SEGS = [
    { key: "output", label: "output", color: "var(--tok-output)" },
    { key: "input", label: "input", color: "var(--tok-input)" },
    { key: "reasoning", label: "reasoning", color: "var(--tok-reasoning)" },
    { key: "cacheCreate", label: "cache write", color: "var(--tok-cache-write)" },
    { key: "cacheRead", label: "cache read", color: "var(--tok-cache-read)" },
  ] as const;

  // Concrete shape (not Record<string, number>) so property access is `number`,
  // not `number | undefined` under noUncheckedIndexedAccess.
  type TokenMix = { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number };

  const days = $derived.by(() => {
    const rows = res.data?.rows ?? [];
    const m = new Map<string, TokenMix>();
    for (const r of rows) {
      const d: TokenMix = m.get(r.date) ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 };
      d.input += r.input; d.output += r.output; d.cacheRead += r.cacheRead;
      d.cacheCreate += r.cacheCreate; d.reasoning += r.reasoning;
      m.set(r.date, d);
    }
    return [...m.entries()].map(([date, v]) => ({
      date,
      total: v.input + v.output + v.cacheRead + v.cacheCreate + v.reasoning,
      v,
    }));
  });
  // "Nice" axis ticks (0, 1, 2, 2.5, 5 × 10ⁿ) so the gridline labels are round
  // numbers. The bars are scaled to axisMax (the top tick), not the raw data max,
  // so a bar that reaches a gridline genuinely represents that value.
  function niceTicks(maxVal: number, count = 4): number[] {
    if (maxVal <= 0) return [0, 1];
    const rawStep = maxVal / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const ticks = [0];
    for (let t = step; ; t += step) {
      ticks.push(t);
      if (t >= maxVal) break; // top tick ≥ maxVal
    }
    return ticks;
  }
  const dataMax = $derived(Math.max(1, ...days.map((d) => d.total)));
  const ticks = $derived(niceTicks(dataMax));
  const axisMax = $derived(Math.max(1, ...ticks));
  const totals = $derived(res.data?.totals);
  const grandTotal = $derived(
    totals ? totals.input + totals.output + totals.cacheRead + totals.cacheCreate + totals.reasoning : 0,
  );
</script>

<Card title="Token usage" icon="cpu" kicker="stacked daily · {ui.range}">
  {#snippet actions()}
    <select class="sel" bind:value={agent} aria-label="Agent">
      {#each AGENTS as a (a)}
        <option value={a}>{a === "all" ? "All agents" : AGENT_NAMES[a] ?? a}</option>
      {/each}
    </select>
  {/snippet}
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !days.length}
    <EmptyState icon="cpu" title="No token data in range" message="Token usage appears here once a sync lands for this range." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="totals">
      <span class="grand mono">{compact(grandTotal)}</span>
      <span class="sub">tokens · {ui.range}</span>
    </div>
    <div class="chart-wrap">
    <div class="plot" role="img" aria-label="Daily token usage stacked by category, max {compact(axisMax)} tokens per day">
      <div class="yaxis" aria-hidden="true">
        {#each ticks as t (t)}
          <span class="ytick" style="bottom:{(t / axisMax) * 100}%">{compact(t)}</span>
        {/each}
      </div>
      <div class="bars">
        {#each ticks as t (t)}
          <span class="gridline" class:base={t === 0} style="bottom:{(t / axisMax) * 100}%"></span>
        {/each}
        {#each days as d (d.date)}
          {@const title = `${shortDate(d.date)} — ${compact(d.total)} total\n` + SEGS.map((s) => `${s.label}: ${compact(d.v[s.key])} (${pct(d.v[s.key] / (d.total || 1), 0)})`).join("\n")}
          <div class="col" {title}>
            <div class="bar" style="height:{(d.total / axisMax) * 100}%">
              {#each SEGS as s (s.key)}
                {#if d.v[s.key] > 0}
                  <span class="seg" style="flex:{d.v[s.key]};background:{s.color}"></span>
                {/if}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
    <div class="xlabels">
      {#each days as d (d.date)}
        <span class="xlabel">{shortDate(d.date)}</span>
      {/each}
    </div>
    </div>
    <div class="legend">
      {#each SEGS as s (s.key)}
        <span class="leg"><span class="dot" style="background:{s.color}"></span>{s.label}</span>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .sel {
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-dim);
  }
  .totals { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
  .grand { font-size: 24px; font-weight: 600; color: var(--text); }
  .sub { font-size: 11.5px; color: var(--text-subtle); }
  /* Plot = fixed-width y-axis gutter + the bars area; both share the same height
     so percentage-positioned ticks/gridlines line up with the bar tops. The
     y-axis width is shared with .xlabels' padding so labels sit under the bars. */
  .chart-wrap {
    --yaxis-w: 42px;
    --chart-h: 130px;
  }
  .plot {
    display: flex;
    align-items: stretch;
    height: var(--chart-h);
  }
  .yaxis {
    position: relative;
    width: var(--yaxis-w);
    flex: none;
  }
  .ytick {
    position: absolute;
    right: 8px;
    transform: translateY(50%);
    font-size: 9px;
    line-height: 1;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .bars {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }
  .gridline {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    pointer-events: none;
  }
  .gridline.base {
    border-top-style: solid;
    border-top-color: var(--border);
  }
  .col {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    min-width: 0;
  }
  .bar {
    width: 100%;
    max-width: 26px;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 3px 3px 0 0;
    overflow: hidden;
    min-height: 2px;
    transition: height 0.3s var(--ease);
  }
  .seg { width: 100%; }
  .xlabels {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    padding-left: var(--yaxis-w);
  }
  .xlabel {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-size: 9px;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 14px;
  }
  .leg { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-dim); }
  .dot { width: 8px; height: 8px; border-radius: 2px; }
</style>
