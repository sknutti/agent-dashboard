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
  const allSessions = $derived(res.data?.sessions ?? []);
  // Backend already orders by started_at DESC; cap the list to the 10 newest.
  const sessions = $derived(allSessions.slice(0, 10));

  // Single-open accordion: opening one row closes any other.
  let openId = $state<string | null>(null);
  function toggle(id: string) {
    openId = openId === id ? null : id;
  }
</script>

<Card title="Live sessions" icon="circle-dot" kicker="active in the last 5 min">
  {#snippet actions()}
    {#if allSessions.length}<Badge tone="cyan">{allSessions.length} active</Badge>{/if}
  {/snippet}

  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !sessions.length}
    <EmptyState icon="circle-dot" title="No active sessions" message="When an agent is mid-run it appears here. Each row expands to a scrollable raw-JSONL event feed." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="rows">
      {#each sessions as s (s.session_id)}
        <LiveSessionRow
          session={s}
          open={openId === s.session_id}
          onToggle={() => toggle(s.session_id)}
        />
      {/each}
    </div>
  {/if}
</Card>

<style>
  .rows { display: flex; flex-direction: column; }
</style>
