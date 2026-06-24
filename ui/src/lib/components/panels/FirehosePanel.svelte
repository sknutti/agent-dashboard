<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Select } from "../ui";
  import { createFirehose } from "../../firehose.svelte";
  import { relTime } from "../../format";

  const fh = createFirehose();
  let filter = $state("");
  const names = $derived([...new Set(fh.events.map((e) => e.event_name))].sort());
  const filterOptions = $derived([
    { value: "", label: `all events (${fh.events.length})` },
    ...names.map((n) => ({ value: n, label: n })),
  ]);
  // Newest first; apply the event_name filter.
  const shown = $derived(
    (filter ? fh.events.filter((e) => e.event_name === filter) : fh.events).slice().reverse(),
  );
</script>

<Card title="Telemetry firehose" icon="zap" kicker="raw OTEL events, live">
  {#snippet actions()}
    <div class="ctrls">
      <span class="dot" class:on={fh.connected}></span>
      <Select bind:value={filter} options={filterOptions} ariaLabel="Filter events" />
    </div>
  {/snippet}

  {#if !fh.events.length}
    <EmptyState icon="zap" title={fh.connected ? "Connected — waiting for events" : "Connecting…"} message="Every OTEL log event streams here as it's ingested. The endpoints are live; the feed fills once Claude Code telemetry emits." />
  {:else}
    <div class="feed">
      {#each shown as e (e.id)}
        <div class="ev">
          <span class="name">{e.event_name}</span>
          <span class="meta u-subtle">
            {#if e.tool_name}{e.tool_name} · {/if}{#if e.model}{e.model} · {/if}{#if e.session_id}{e.session_id.slice(0, 8)}{/if}
          </span>
          <span class="when u-subtle mono">{relTime(e.timestamp ?? e.received_at)}</span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .ctrls { display: flex; align-items: center; gap: 8px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-subtle); }
  .dot.on { background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
  .feed { max-height: 360px; overflow-y: auto; font-size: 12px; font-family: var(--mono, monospace); }
  .ev {
    display: grid;
    grid-template-columns: 180px 1fr 64px;
    gap: 8px;
    align-items: center;
    padding: 4px 4px;
    border-bottom: 1px solid var(--border);
  }
  .name { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { text-align: right; }
</style>
