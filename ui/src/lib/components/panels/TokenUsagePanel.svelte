<script lang="ts">
  import Card from "../ui/Card.svelte";
  import FidelityBadge from "../ui/FidelityBadge.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getTokenUsage } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, shortDate, pct } from "../../format";

  const res = resource(() => `tokens:${ui.range}`, () => getTokenUsage(ui.range));

  // Roll the per-(date,model) rows up to per-day stacks.
  const SEGS = [
    { key: "output", label: "output", color: "var(--accent-from)" },
    { key: "input", label: "input", color: "var(--cyan)" },
    { key: "reasoning", label: "reasoning", color: "#a78bfa" },
    { key: "cacheCreate", label: "cache write", color: "var(--amber)" },
    { key: "cacheRead", label: "cache read", color: "var(--text-subtle)" },
  ] as const;

  const days = $derived.by(() => {
    const rows = res.data?.rows ?? [];
    const m = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const d = m.get(r.date) ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 };
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
  const max = $derived(Math.max(1, ...days.map((d) => d.total)));
  const totals = $derived(res.data?.totals);
  const grandTotal = $derived(
    totals ? totals.input + totals.output + totals.cacheRead + totals.cacheCreate + totals.reasoning : 0,
  );
</script>

<Card title="Token usage" icon="cpu" kicker="stacked daily · {ui.range}">
  {#snippet actions()}<FidelityBadge fidelity="exact" />{/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !days.length}
    <EmptyState icon="cpu" title="No token data in range" message="Token usage appears here once a sync lands for this range." />
  {:else}
    <div class="totals">
      <span class="grand mono">{compact(grandTotal)}</span>
      <span class="sub">tokens · {ui.range}</span>
    </div>
    <div class="chart" role="img" aria-label="Daily token usage stacked by category">
      {#each days as d (d.date)}
        {@const title = `${shortDate(d.date)} — ${compact(d.total)} total\n` + SEGS.map((s) => `${s.label}: ${compact(d.v[s.key])} (${pct(d.v[s.key] / (d.total || 1), 0)})`).join("\n")}
        <div class="col" {title}>
          <div class="bar" style="height:{(d.total / max) * 100}%">
            {#each SEGS as s (s.key)}
              {#if d.v[s.key] > 0}
                <span class="seg" style="flex:{d.v[s.key]};background:{s.color}"></span>
              {/if}
            {/each}
          </div>
          <span class="xlabel">{shortDate(d.date)}</span>
        </div>
      {/each}
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
  .totals { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
  .grand { font-size: 24px; font-weight: 600; color: var(--text); }
  .sub { font-size: 11.5px; color: var(--text-subtle); }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 130px;
  }
  .col {
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
  .xlabel {
    margin-top: 6px;
    font-size: 9px;
    color: var(--text-subtle);
    white-space: nowrap;
    transform: rotate(0);
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
