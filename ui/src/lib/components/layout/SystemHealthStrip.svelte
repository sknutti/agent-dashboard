<script lang="ts">
  import StatePill from "../ui/StatePill.svelte";
  import { health } from "../../stores.svelte";

  type Tone = "green" | "amber" | "red" | "cyan" | "neutral";

  function fmtDur(s: number | null): string {
    if (s === null || s === undefined) return "—";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // Freshness thresholds. Sync ticks every 120s, so >300s is stale.
  // "Good" is cyan, not green: cyan-vs-red/amber stays distinguishable for
  // red/green colour vision, where green-vs-red would not.
  function otelTone(age: number | null): Tone {
    if (age === null) return "neutral";
    return age < 180 ? "cyan" : "amber";
  }
  function syncTone(age: number | null): Tone {
    if (age === null) return "amber";
    return age < 300 ? "cyan" : "red";
  }
</script>

<div class="strip" class:offline={health.error}>
  {#if health.error}
    <StatePill tone="red" label="Server" value="unreachable" />
  {:else if health.loading && !health.data}
    <StatePill tone="neutral" label="Connecting…" />
  {:else if health.data}
    {@const h = health.data}
    <StatePill tone="cyan" label="Uptime" value={fmtDur(h.uptime_s)} />
    <StatePill
      tone={syncTone(h.last_sync_tick_age_s)}
      label="Sync tick"
      value={fmtDur(h.last_sync_tick_age_s)}
      title="Age of the orchestrator's last heartbeat (worker thread)"
    />
    <StatePill
      tone={otelTone(h.last_otel_event_age_s)}
      label="OTEL"
      value={h.last_otel_event_age_s === null
        ? "no events"
        : fmtDur(h.last_otel_event_age_s)}
      title="Age of the most recent OTLP event received"
    />
    <StatePill
      tone="cyan"
      label="Mem"
      value={`${Math.round(h.rss_bytes / 1048576)} MB`}
    />
  {/if}
</div>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    align-items: center;
  }
</style>
