<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getOutcomes } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { shortDate } from "../../format";

  const res = resource(() => `outcomes:${ui.range}`, () => getOutcomes(ui.range));
  const days = $derived(res.data?.days ?? []);
  const max = $derived(Math.max(1, ...days.map((d) => d.total)));

  // Segments rendered bottom-up in reverse-priority so 'ok' (green) is the base.
  const SEGS = [
    { key: "ok", label: "ok", color: "var(--green)" },
    { key: "unfinished", label: "unfinished", color: "var(--text-subtle)" },
    { key: "truncated", label: "truncated", color: "#fb923c" },
    { key: "rate_limited", label: "rate-limited", color: "var(--amber)" },
    { key: "errored", label: "errored", color: "var(--red)" },
  ] as const;
</script>

<Card title="Session outcomes" icon="layers" kicker="ok · errored · limited · truncated">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !days.length}
    <EmptyState icon="layers" title="No sessions in range" message="Stacked daily bars: ok / errored / rate-limited / truncated / unfinished. They sum to the day's total." />
  {:else}
    <div class="chart">
      {#each days as d (d.date)}
        {@const title = `${shortDate(d.date)} — ${d.total} sessions\n` + SEGS.map((s) => `${s.label}: ${(d as any)[s.key]}`).filter((_, i) => (d as any)[SEGS[i].key] > 0).join("\n")}
        <div class="col" {title}>
          <div class="bar" style="height:{(d.total / max) * 100}%">
            {#each SEGS as s (s.key)}
              {#if (d as any)[s.key] > 0}
                <span class="seg" style="flex:{(d as any)[s.key]};background:{s.color}"></span>
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
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 130px; }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
  .bar { width: 100%; max-width: 26px; display: flex; flex-direction: column; border-radius: 3px 3px 0 0; overflow: hidden; min-height: 2px; }
  .seg { width: 100%; }
  .xlabel { margin-top: 6px; font-size: 9px; color: var(--text-subtle); white-space: nowrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .leg { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-dim); }
  .dot { width: 8px; height: 8px; border-radius: 2px; }
</style>
