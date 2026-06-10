<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { getTopSkills } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact } from "../../format";

  const res = resource(() => `skill-econ:${ui.range}`, () => getTopSkills(ui.range));
  const d = $derived(res.data);
</script>

<Card title="Skill economics" icon="dollar" kicker="token cost per skill">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if d && d.attributed.length}
    <div class="rows">
      {#each d.attributed as s (s.skill)}
        <div class="srow"><span class="sn">{s.skill}</span><span class="sv mono dim">{compact(s.uses)} uses</span></div>
      {/each}
    </div>
  {:else}
    <div class="summary">
      <span class="big mono">{compact(d?.invocations ?? 0)}</span>
      <span class="sub">Skill invocations · {ui.range}</span>
    </div>
    <p class="note">
      Per-skill <strong>token cost</strong> needs the <code>skill_name</code> OTEL attribute to attribute tokens
      to the skill that spent them. The invocation count is exact; cost attribution lights up under telemetry.
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
  .rows { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .srow { display: flex; justify-content: space-between; gap: 8px; }
  .sn { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim { color: var(--text-subtle); }
</style>
