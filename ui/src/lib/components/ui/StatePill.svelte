<script lang="ts">
  // Colored status pill with a leading dot (master §17 / §22). Used for health
  // states and elsewhere a live status needs a glanceable color.
  type Tone = "green" | "amber" | "red" | "cyan" | "neutral";
  let {
    tone = "neutral",
    label,
    value,
    title,
  }: { tone?: Tone; label: string; value?: string; title?: string } = $props();
</script>

<span class="pill {tone}" {title}>
  <span class="dot"></span>
  <span class="label">{label}</span>
  {#if value !== undefined}<span class="value mono">{value}</span>{/if}
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px 4px 9px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-subtle);
    flex: none;
  }
  .label {
    color: var(--text-dim);
  }
  .value {
    color: var(--text);
    font-size: 11.5px;
  }
  .green .dot {
    background: var(--green);
    box-shadow: 0 0 8px color-mix(in srgb, var(--green) 70%, transparent);
  }
  .amber .dot {
    background: var(--amber);
    box-shadow: 0 0 8px color-mix(in srgb, var(--amber) 70%, transparent);
  }
  .red .dot {
    background: var(--red);
    box-shadow: 0 0 8px color-mix(in srgb, var(--red) 70%, transparent);
  }
  .cyan .dot {
    background: var(--cyan);
    box-shadow: 0 0 8px color-mix(in srgb, var(--cyan) 70%, transparent);
  }
</style>
