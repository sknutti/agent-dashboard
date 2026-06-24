<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getMcpMeasure } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";

  const res = resource(() => `mcp-measure:${ui.range}`, () => getMcpMeasure(ui.range));
  const d = $derived(res.data);
  const servers = $derived(d?.servers ?? []);
</script>

<Card title="MCP schema footprint" icon="plug" kicker="tools per server · context cost">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !servers.length}
    <EmptyState icon="plug" title="No MCP servers observed" message="Servers that handled tool calls in range appear here with their tool counts. Per-schema token cost needs a live MCP handshake." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="rows">
      {#each servers as s (s.server)}
        <div class="row">
          <span class="sv">{s.server}</span>
          <span class="tn mono u-subtle">{s.tools} tool{s.tools === 1 ? "" : "s"}</span>
          <span class="sz mono u-subtle">schema —</span>
        </div>
      {/each}
    </div>
    <p class="note">{d?.note}</p>
  {/if}
</Card>

<style>
  .rows { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .row { display: grid; grid-template-columns: 1fr 70px 80px; gap: 8px; align-items: center; padding: 5px 4px; border-bottom: 1px solid var(--border); }
  .sv { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tn, .sz { text-align: right; }
  .note { margin: 10px 0 0; font-size: 11px; line-height: 1.5; color: var(--text-subtle); }
</style>
