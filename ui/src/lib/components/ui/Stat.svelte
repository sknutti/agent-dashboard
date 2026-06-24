<script lang="ts">
  // Figure-cluster primitive (§4): label on top, value below, optional sub —
  // replacing the hand-rolled `.stat`+`.big`+`.lbl` clusters (×6–9). Uses the
  // global `.u-label` / `.u-big` / `.u-sub` text utilities (§5) so type stays in
  // one place. `tone` colours the VALUE only (and tone here is decorative accent,
  // never the sole carrier of meaning — CVD-safe).
  let {
    label,
    value,
    sub,
    big = false,
    mono = true,
    tone,
  }: {
    label?: string;
    value: string | number;
    sub?: string;
    big?: boolean;
    mono?: boolean;
    tone?: "default" | "accent" | "cyan" | "amber";
  } = $props();
</script>

<div class="stat">
  {#if label}<span class="u-label">{label}</span>{/if}
  <span
    class="value {tone ?? 'default'}"
    class:u-big={big}
    class:big={!big}
    class:u-mono={mono}>{value}</span
  >
  {#if sub}<span class="u-sub">{sub}</span>{/if}
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* Non-big value: 15px/600 (matches the existing `.stat` figure size). */
  .value.big {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.1;
  }
  .value.accent {
    color: var(--accent-from);
  }
  .value.cyan {
    color: var(--cyan);
  }
  .value.amber {
    color: var(--amber);
  }
</style>
