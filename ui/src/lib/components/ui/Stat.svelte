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
    valueFirst = false,
  }: {
    label?: string;
    value: string | number;
    sub?: string;
    big?: boolean;
    mono?: boolean;
    tone?: "default" | "accent" | "cyan" | "amber";
    /** Render the value ABOVE the label (value-prominent clusters) instead of
     *  the default label-above-value. Source order is unchanged (label stays the
     *  accessible-reading-order first); only the visual order flips via flex. */
    valueFirst?: boolean;
  } = $props();
</script>

<div class="stat" class:value-first={valueFirst}>
  {#if label}<span class="u-label">{label}</span>{/if}
  <span
    class="value {tone ?? 'default'}"
    class:u-big={big}
    class:value-md={!big}
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
  /* valueFirst: lift the value above the label without reordering the markup
     (keeps label first in the accessible reading order). sub stays last. */
  .stat.value-first .value {
    order: -1;
  }
  /* Medium (non-big) value: 15px/600 (matches the existing `.stat` figure size).
     Named `value-md` — NOT `big` — so the class name can't be misread as the big variant. */
  .value.value-md {
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
