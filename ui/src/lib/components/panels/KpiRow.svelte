<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  // Today's headline counters (master §17 KpiRow). Phase 0: structural zeros
  // with a clear "awaiting first sync" cue — no fabricated numbers.
  const TILES = [
    { label: "Sessions today", icon: "layers" },
    { label: "Tokens today", icon: "cpu" },
    { label: "Tool calls", icon: "wrench" },
    { label: "Errors", icon: "alert" },
  ];
</script>

<div class="kpis">
  {#each TILES as t (t.label)}
    <div class="tile">
      <div class="tile-head">
        <span class="kicker">{t.label}</span>
        <Icon name={t.icon} size={15} />
      </div>
      <div class="tile-val mono">—</div>
      <div class="tile-sub">awaiting first sync</div>
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
  .tile-sub {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-subtle);
  }
</style>
