<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { MetricBar } from "../ui";
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
    <div class="u-muted">Loading…</div>
  {:else if res.error && !res.data}
    <EmptyState title="" error onRetry={res.reload} />
  {:else if d && d.attributed.length}
    <div class="rows">
      {#each d.attributed as s (s.skill)}
        <div class="srow">
          <span class="sn" title={s.skill}>{s.skill}</span>
          <MetricBar value={s.uses} max={maxUses} color="var(--cyan)" ariaLabel={`${s.skill}: ${s.uses} uses`} />
          <span class="sv mono u-subtle">{compact(s.uses)}</span>
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
  .summary { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .big { font-size: 26px; font-weight: 650; color: var(--text); }
  .sub { font-size: 12px; color: var(--text-dim); }
  .note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .note code { font-size: 11px; background: var(--surface-2); padding: 0 4px; border-radius: 4px; color: var(--cyan); }
  .rows { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
  .srow { display: grid; grid-template-columns: 1fr 1fr 48px; gap: 8px; align-items: center; }
  .sn { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv { text-align: right; }
</style>
