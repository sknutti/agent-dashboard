<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Badge from "../ui/Badge.svelte";
  import LiveSessionRow from "./LiveSessionRow.svelte";
  import { getLive } from "../../api";
  import { resource } from "../../resource.svelte";

  // Poll the live list every 10s by varying the key with a ticking counter.
  let tick = $state(0);
  const timer = setInterval(() => (tick += 1), 10_000);
  $effect(() => () => clearInterval(timer));

  const res = resource(() => `live:${tick}`, () => getLive());
  const sessions = $derived(res.data?.sessions ?? []);
</script>

<Card title="Live sessions" icon="circle-dot" kicker="active in the last 5 min">
  {#snippet actions()}
    {#if sessions.length}<Badge tone="cyan">{sessions.length} active</Badge>{/if}
  {/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !sessions.length}
    <EmptyState icon="circle-dot" title="No active sessions" message="When an agent is mid-run it appears here. Each row expands to a scrollable raw-JSONL event feed." />
  {:else}
    <div class="rows">
      {#each sessions as s (s.session_id)}
        <LiveSessionRow session={s} />
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .rows { display: flex; flex-direction: column; }
</style>
