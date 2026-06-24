<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, MetricBar, Badge } from "../ui";
  import { getEditDecisions } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { pct, compact } from "../../format";

  const res = resource(() => `edit-decisions:${ui.range}`, () => getEditDecisions(ui.range));
  const d = $derived(res.data);
</script>

<Card title="Edit acceptance" icon="circle-dot" kicker="accept / reject — from tool_decision">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !d || d.total === 0}
    <EmptyState icon="circle-dot" title="No edit decisions yet" error={res.error} onRetry={res.reload} message="Accept/reject rate for Edit · MultiEdit · Write · NotebookEdit comes from the tool_decision OTEL event. It lights up once telemetry has captured a few edits.">
      {#snippet children()}
        <span class="hint">N = 0 · needs ≥ 10 for a stable rate</span>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="summary">
      <span class="big mono" class:dim={d.lowSample}>{pct(d.acceptRate, 0)}</span>
      <div class="meta">
        <span class="sub">accepted</span>
        <span class="counts mono">{compact(d.accepted)} ✓ · {compact(d.rejected)} ✗ · N={compact(d.total)}</span>
        {#if d.lowSample}<Badge tone="amber">low sample</Badge>{/if}
      </div>
    </div>
    <div class="bars">
      {#each d.byTool as t (t.tool)}
        <div class="brow">
          <span class="bt">{t.tool}</span>
          <MetricBar value={t.acceptRate ?? 0} max={1} color="var(--cyan)" ariaLabel="{t.tool} accept rate {pct(t.acceptRate, 0)}" />
          <span class="bv u-mono u-subtle">{pct(t.acceptRate, 0)}</span>
          <span class="bn u-mono u-subtle">N={t.accepted + t.rejected}</span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .hint { font-size: 11px; color: var(--text-subtle); }
  .summary { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .big { font-size: 32px; font-weight: 680; color: var(--cyan); line-height: 1; }
  .big.dim { color: var(--text-dim); }
  .meta { display: flex; flex-direction: column; gap: 3px; }
  .sub { font-size: 12px; color: var(--text-dim); }
  .counts { font-size: 11.5px; color: var(--text-subtle); }
  .bars { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
  .brow { display: grid; grid-template-columns: 90px 1fr 40px 48px; gap: 8px; align-items: center; }
  .bt { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bv, .bn { text-align: right; }
</style>
