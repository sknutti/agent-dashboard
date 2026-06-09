<script lang="ts">
  import Card from "../ui/Card.svelte";
  import Badge from "../ui/Badge.svelte";
  import { getAgents } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { usd, AGENT_NAMES } from "../../format";

  const res = resource(() => `agents:${ui.range}`, () => getAgents(ui.range));
  // Subscription savings = estimated (rack-rate) − native; only Claude/Pi have native.
  const rows = $derived(
    (res.data?.agents ?? [])
      .filter((a) => a.cost === "native" && a.costEstimatedUsd != null)
      .map((a) => ({
        id: a.id,
        name: AGENT_NAMES[a.id] ?? a.id,
        est: a.costEstimatedUsd!,
        native: a.costUsd,
        savings: a.costUsd != null ? a.costEstimatedUsd! - a.costUsd : null,
      })),
  );
  const anyNative = $derived(rows.some((r) => r.native != null));
</script>

<Card title="Subscription savings" icon="dollar" kicker="rack-rate (est) − native · {ui.range}">
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !anyNative}
    <div class="teach">
      <p class="lead">Savings needs the native figure.</p>
      <p class="body">
        Rack-rate estimated cost is computed from tokens for every agent. The <em>native</em> cost
        Claude stamps lives in OTEL metrics — interactive sessions don't write it to JSONL.
        Turn telemetry on (<code>bun run setup:otel</code>) and the savings delta lights up here.
      </p>
      {#each rows as r (r.id)}
        <div class="est-only">
          <span class="name">{r.name}</span>
          <span class="mono est">{usd(r.est)} <span class="tag">est</span></span>
          <Badge tone="amber">native pending OTEL</Badge>
        </div>
      {/each}
    </div>
  {:else}
    {#each rows as r (r.id)}
      <div class="srow">
        <span class="name">{r.name}</span>
        <div class="figs">
          <span class="fig"><span class="lbl">rack-rate · est</span><span class="mono est">{usd(r.est)}</span></span>
          <span class="fig"><span class="lbl">native</span><span class="mono nat">{usd(r.native)}</span></span>
          <span class="fig save"><span class="lbl">saved</span><span class="mono">{usd(r.savings)}</span></span>
        </div>
      </div>
    {/each}
    <p class="caveat">
      Exact only once OTEL has covered the whole range — native cost exists solely for
      sessions run with telemetry on, while rack-rate covers every session. The delta
      sharpens as more sessions accrue under OTEL.
    </p>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .teach .lead { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--text-dim); }
  .teach .body { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--text-subtle); }
  .est-only, .srow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); }
  .name { font-size: 13px; font-weight: 560; color: var(--text); }
  .est { color: var(--amber); display: inline-flex; align-items: baseline; gap: 5px; }
  .tag { font-family: var(--font-sans); font-size: 9.5px; color: var(--text-subtle); }
  .nat { color: var(--cyan); }
  .figs { display: flex; gap: 16px; }
  .fig { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .fig .lbl { font-size: 9.5px; color: var(--text-subtle); }
  .fig.save .mono { color: var(--green); font-weight: 600; }
  .caveat { margin: 12px 0 0; font-size: 11px; line-height: 1.55; color: var(--text-subtle); }
</style>
