<script lang="ts">
  // Compact OTEL on/off indicator (ADR-0003 validated affordance), shown beside
  // a model/agent name. Live telemetry = lit cyan bolt; off = dim.
  import Icon from "./Icon.svelte";
  let { on = false }: { on?: boolean } = $props();
</script>

<span
  class="otel"
  class:on
  title={on ? "OTEL telemetry: live" : "OTEL telemetry: off (JSONL fallback)"}
  aria-label={on ? "OTEL live" : "OTEL off"}
>
  <Icon name="zap" size={11} stroke={2.4} />
  <span class="txt mono">OTEL</span>
</span>

<style>
  .otel {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    color: var(--text-subtle);
    background: var(--surface-2);
    font-size: 9.5px;
    letter-spacing: 0.08em;
  }
  .on {
    color: var(--cyan);
    border-color: color-mix(in srgb, var(--cyan) 45%, var(--border));
    background: color-mix(in srgb, var(--cyan) 12%, transparent);
  }
  .txt {
    font-weight: 500;
  }
</style>
