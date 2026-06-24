<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, Badge, Callout } from "../ui";
  import { getAgents } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { usd} from "../../format";
  import { AGENT_NAMES } from "../../registry.svelte";

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
    <div class="u-muted">Loading…</div>
  {:else if res.error && !res.data}
    <EmptyState title="" error onRetry={res.reload} />
  {:else if !anyNative}
    <Callout tone="info" icon="info" title="Savings needs the native figure.">
      Rack-rate estimated cost is computed from tokens for every agent. The <em>native</em> cost
      Claude stamps lives in OTEL metrics — interactive sessions don't write it to JSONL.
      Turn telemetry on (<code>bun run setup:otel</code>) and the savings delta lights up here.
    </Callout>
    {#each rows as r (r.id)}
      <div class="est-only">
        <span class="name">{r.name}</span>
        <span class="mono est">{usd(r.est)} <span class="tag">est</span></span>
        <Badge tone="amber">native pending OTEL</Badge>
      </div>
    {/each}
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
  .est-only { margin-top: 10px; }
  .est-only, .srow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); }
  .name { font-size: 13px; font-weight: 560; color: var(--text); }
  .est { color: var(--amber); display: inline-flex; align-items: baseline; gap: 5px; }
  .tag { font-family: var(--font-sans); font-size: 9.5px; color: var(--text-subtle); }
  .nat { color: var(--cyan); }
  .figs { display: flex; gap: 16px; }
  .fig { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .fig .lbl { font-size: 9.5px; color: var(--text-subtle); }
  /* "saved" is cyan, not green — matches the app-wide cyan-as-positive
     convention and avoids the amber(est)/green(saved) red-green-CVD pairing. */
  .fig.save .mono { color: var(--cyan); font-weight: 600; }
  .caveat { margin: 12px 0 0; font-size: 11px; line-height: 1.55; color: var(--text-subtle); }
</style>
