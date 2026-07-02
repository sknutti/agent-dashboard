<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import { getSummary } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact } from "../../format";
  import { openDrill } from "../../stores.svelte";

  // Today's headline counters (master §17 KpiRow). Real /api/summary data.
  const res = resource(() => "summary", () => getSummary());

  const TILES = $derived([
    { label: "Sessions today", icon: "layers", value: res.data?.sessions },
    { label: "Tokens today", icon: "cpu", value: res.data?.tokens, fmt: true },
    { label: "Tool calls", icon: "wrench", value: res.data?.tools },
    { label: "Errors", icon: "alert", value: res.data?.errors, alert: true },
  ]);

  // "Errors · needs attention" was a dead-end tile even though the per-agent
  // errors cell (AgentCard) already drills into errored sessions. Route the
  // aggregate tile through the same read-only drill (all agents, outcome=errored)
  // so the headline alert is a lead, not a full stop.
  function drillErrors() {
    openDrill({
      title: "Errors · needs attention",
      subtitle: "errored sessions · today",
      outcome: "errored",
      // The KPI count is always today's, so pin the drill to today rather than
      // the global range toggle — otherwise the "18" tile opens a 7d list.
      range: "today",
      query: "GET /api/sessions?outcome=errored&range=today",
    });
  }
</script>

<div class="kpis">
  {#each TILES as t (t.label)}
    {@const alerting = !!t.alert && !res.loading && !res.error && (t.value ?? 0) > 0}
    {#if alerting}
      <!-- ds-allow-native: whole-tile drill trigger into the errored-session list (mirrors AgentCard), not a form control -->
      <button class="tile err" type="button" onclick={drillErrors} title="View errored sessions">
        {@render tileBody(t)}
      </button>
    {:else}
      <div class="tile" class:err={!!t.alert && (t.value ?? 0) > 0}>
        {@render tileBody(t)}
      </div>
    {/if}
  {/each}
</div>

{#snippet tileBody(t: (typeof TILES)[number])}
  <div class="tile-head">
    <span class="kicker">{t.label}</span>
    <Icon name={t.icon} size={15} />
  </div>
  {#if res.loading}
    <div class="tile-val skel mono">—</div>
    <div class="tile-sub">loading…</div>
  {:else if res.error}
    <div class="tile-val mono">—</div>
    <div class="tile-sub">unavailable</div>
  {:else}
    <div class="tile-val mono">{t.fmt ? compact(t.value) : (t.value ?? 0).toLocaleString()}</div>
    <div class="tile-sub">{t.alert && (t.value ?? 0) > 0 ? "needs attention" : "live"}</div>
  {/if}
{/snippet}

<style>
  .kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  @media (max-width: 760px) {
    .kpis {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    transition: border-color 0.2s var(--ease);
  }
  .tile.err {
    border-color: color-mix(in srgb, var(--red) 40%, var(--border));
  }
  /* The alerting Errors tile renders as a <button> drill trigger; keep it visually
     identical to the div tiles (global button reset already strips chrome) but fill
     the grid cell, left-align, and strengthen the border on hover as an affordance. */
  button.tile {
    width: 100%;
    text-align: left;
    transition: border-color 0.2s var(--ease);
  }
  button.tile:hover {
    border-color: color-mix(in srgb, var(--red) 70%, var(--border));
  }
  .tile-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-subtle);
    margin-bottom: 12px;
  }
  .tile-val {
    font-size: 30px;
    font-weight: 600;
    line-height: 1;
    color: var(--text);
  }
  .tile.err .tile-val {
    color: var(--red);
  }
  .skel {
    color: var(--text-subtle);
    opacity: 0.5;
  }
  .tile-sub {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-subtle);
  }
</style>
