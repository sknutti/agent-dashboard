<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getTopSkills } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact } from "../../format";

  const res = resource(() => `top-skills:${ui.range}`, () => getTopSkills(ui.range));
  const d = $derived(res.data);
  const maxUses = $derived(Math.max(1, ...(d?.attributed ?? []).map((s) => s.uses)));
</script>

<Card title="Top skills" icon="sparkles" kicker="most used — by invocation">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if res.error && !res.data}
    <EmptyState title="" error onRetry={res.reload} />
  {:else if d && d.attributed.length}
    <div class="rows">
      {#each d.attributed as s (s.skill)}
        <div class="srow">
          <span class="sn" title={s.skill}>{s.skill}</span>
          <span class="bar"><span class="fill" style="width:{((s.uses / maxUses) * 100).toFixed(0)}%"></span></span>
          <span class="sv mono dim">{compact(s.uses)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="summary">
      <span class="big mono">{compact(d?.invocations ?? 0)}</span>
      <span class="sub">Skill tool invocations in range</span>
    </div>
    <p class="note">
      No named skill calls in this range yet. The breakdown is lifted from each
      <code>Skill</code> call's <code>input.skill</code> at sync time; it fills in for sessions
      synced after this landed (older calls predate capture).
    </p>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .summary { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .big { font-size: 26px; font-weight: 650; color: var(--text); }
  .sub { font-size: 12px; color: var(--text-dim); }
  .note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .note code { font-size: 11px; background: var(--surface-2); padding: 0 4px; border-radius: 4px; color: var(--cyan); }
  .rows { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
  .srow { display: grid; grid-template-columns: 1fr 1fr 48px; gap: 8px; align-items: center; }
  .sn { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--cyan); }
  .sv { text-align: right; }
  .dim { color: var(--text-subtle); }
</style>
