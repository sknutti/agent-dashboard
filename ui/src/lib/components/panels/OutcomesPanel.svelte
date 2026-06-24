<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState } from "../ui";
  import { getOutcomes } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { shortDate } from "../../format";

  const res = resource(() => `outcomes:${ui.range}`, () => getOutcomes(ui.range));
  const days = $derived(res.data?.days ?? []);
  const max = $derived(Math.max(1, ...days.map((d) => d.total)));

  // Segments rendered bottom-up in reverse-priority so 'ok' is the base. Colours
  // are the Okabe-Ito colourblind-safe palette: ok=blue vs errored=vermillion is
  // unmistakable for red/green colour vision (no green-vs-red pairing). These are
  // NOMINAL states, so we keep hue (not a luminance ramp — that would imply a
  // false ordering; ADR-0004) and lean on the legend-highlight for disambiguation.
  const SEGS = [
    { key: "ok", label: "ok", color: "#0072b2" }, // blue
    { key: "unfinished", label: "unfinished", color: "#999999" }, // grey
    { key: "truncated", label: "truncated", color: "#f0e442" }, // yellow
    { key: "rate_limited", label: "rate-limited", color: "#e69f00" }, // orange
    { key: "errored", label: "errored", color: "#d55e00" }, // vermillion
  ] as const;

  // Legend ↔ segment highlight (brushing & linking); keyboard-focusable so the
  // colour-vision disambiguator is reachable without a mouse.
  let hl = $state<string | null>(null);
</script>

<Card title="Session outcomes" icon="layers" kicker="ok · errored · limited · truncated">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !days.length}
    <EmptyState icon="layers" title="No sessions in range" message="Stacked daily bars: ok / errored / rate-limited / truncated / unfinished. They sum to the day's total." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="chart" role="img" aria-label="Daily session outcomes stacked by category (ok, unfinished, truncated, rate-limited, errored)">
      {#each days as d (d.date)}
        {@const title = `${shortDate(d.date)} — ${d.total} sessions\n` + SEGS.filter((s) => d[s.key] > 0).map((s) => `${s.label}: ${d[s.key]}`).join("\n")}
        <div class="col" {title}>
          <div class="bar" style="height:{(d.total / max) * 100}%">
            {#each SEGS as s (s.key)}
              {#if d[s.key] > 0}
                <span class="seg" class:dim={hl !== null && hl !== s.key} style="flex:{d[s.key]};background:{s.color}"></span>
              {/if}
            {/each}
          </div>
          <span class="xlabel">{shortDate(d.date)}</span>
        </div>
      {/each}
    </div>
    <div class="legend">
      {#each SEGS as s (s.key)}
        <!-- ds-allow-native: legend entry is a structural brushing/highlight control (focusable), not a form action. -->
        <button
          type="button"
          class="leg"
          class:active={hl === s.key}
          class:dim={hl !== null && hl !== s.key}
          onmouseenter={() => (hl = s.key)}
          onmouseleave={() => (hl = null)}
          onfocus={() => (hl = s.key)}
          onblur={() => (hl = null)}
        ><span class="dot" style="background:{s.color}"></span>{s.label}</button>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 130px; }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
  .bar { width: 100%; max-width: 26px; display: flex; flex-direction: column; border-radius: 3px 3px 0 0; overflow: hidden; min-height: 2px; }
  .seg { width: 100%; transition: opacity 0.15s var(--ease); }
  .seg.dim { opacity: 0.22; }
  .xlabel { margin-top: 6px; font-size: 9px; color: var(--text-subtle); white-space: nowrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  /* Legend entries are buttons (keyboard-focusable highlight control). */
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--text-dim);
    cursor: pointer;
    border-radius: 5px;
    padding: 2px 5px;
    transition: opacity 0.15s var(--ease), background 0.15s var(--ease);
  }
  .leg:hover, .leg.active { background: var(--surface-2); color: var(--text); }
  .leg.dim { opacity: 0.45; }
  .dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
</style>
