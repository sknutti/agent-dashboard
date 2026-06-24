<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, Badge } from "../ui";
  import { getAgentFanout } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, projectName, relTime } from "../../format";

  const res = resource(() => `fanout:${ui.range}`, () => getAgentFanout(ui.range));
  const sessions = $derived(res.data?.sessions ?? []);
  const totalCalls = $derived(res.data?.totalCalls ?? 0);
</script>

<Card title="Agent fan-out" icon="layers" kicker="sessions that dispatched subagents">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !sessions.length}
    <EmptyState icon="layers" title="No subagent dispatches in range" message="Sessions that called the Agent/Task tool — the subagent proxy. Each row shows how many subagents it spawned." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="summary">
      <span class="big mono">{compact(totalCalls)}</span>
      <span class="sub">subagent calls across {sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
    </div>
    <div class="scroll">
      {#each sessions as s (s.session_id)}
        <div class="row">
          <span class="c-title" title={s.title ?? s.session_id}>
            {s.title ?? `session:${s.session_id.slice(0, 8)}`}
          </span>
          <span class="c-proj u-subtle" title={s.cwd ?? ""}>{projectName(s.cwd)}</span>
          <span class="c-when u-subtle u-mono">{relTime(s.started_at)}</span>
          <span class="c-calls"><Badge tone="cyan">{s.agentCalls}×</Badge></span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .summary { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
  /* Summary figure: 24px (panel-specific, larger than the 22px .u-big utility). */
  .big { font-size: 24px; font-weight: 650; color: var(--text); }
  .sub { font-size: 12px; color: var(--text-dim); }
  .scroll { max-height: 280px; overflow-y: auto; font-size: 12px; }
  .row {
    display: grid;
    grid-template-columns: 1fr 110px 56px 40px;
    gap: 8px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  .c-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .c-proj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-when { text-align: right; }
  .c-calls { text-align: right; }
</style>
