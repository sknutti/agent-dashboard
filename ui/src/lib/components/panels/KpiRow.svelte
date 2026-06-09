<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import { getSummary } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact } from "../../format";

  // Today's headline counters (master §17 KpiRow). Real /api/summary data.
  const res = resource(() => "summary", () => getSummary());

  const TILES = $derived([
    { label: "Sessions today", icon: "layers", value: res.data?.sessions },
    { label: "Tokens today", icon: "cpu", value: res.data?.tokens, fmt: true },
    { label: "Tool calls", icon: "wrench", value: res.data?.tools },
    { label: "Errors", icon: "alert", value: res.data?.errors, alert: true },
  ]);
</script>

<div class="kpis">
  {#each TILES as t (t.label)}
    <div class="tile" class:err={t.alert && (t.value ?? 0) > 0}>
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
    </div>
  {/each}
</div>

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
