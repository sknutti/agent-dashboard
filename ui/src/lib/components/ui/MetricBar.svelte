<script lang="ts">
  // Horizontal meter primitive (§4), replacing the hand-rolled `.bar` (×8) incl.
  // the stacked token-mix bars. Two modes: a single `value/max` fill, or a
  // `segments` stack whose widths are value-proportional. Colours come from the
  // CALLER as token strings (`var(--tok-*)`, `var(--accent-from)`, etc.) — never
  // raw hex in here; the token ramp is luminance-ordered so segments stay
  // CVD-decodable (ADR-0004).
  type Seg = { value: number; color: string; label?: string };
  let {
    value,
    max = 1,
    color = "var(--accent-from)",
    segments,
    height = 6,
    track = "var(--surface-2)",
    ariaLabel,
  }: {
    value?: number;
    max?: number;
    color?: string;
    segments?: Seg[]; // if present → stacked bar; widths proportional to value
    height?: number;
    track?: string;
    ariaLabel?: string;
  } = $props();

  // Single-fill width, clamped to 0..1 of max. (max<=0 → empty, never NaN/Infinity.)
  const pct = $derived(
    max > 0 ? Math.max(0, Math.min(1, (value ?? 0) / max)) * 100 : 0,
  );
  // Only render segments that contribute width; flex:value mirrors the existing
  // `.bar` stacks (OutcomesPanel), so a zero-value category collapses cleanly.
  const segs = $derived((segments ?? []).filter((s) => s.value > 0));
</script>

<!-- role="img" only when an accessible name is supplied — a nameless role="img"
     is an a11y anti-pattern. Nameless bars stay decorative (no role). -->
<div
  class="bar"
  style="height:{height}px;background:{track}"
  role={ariaLabel ? "img" : undefined}
  aria-label={ariaLabel}
>
  {#if segments}
    {#each segs as s, i (i)}
      <span class="seg" style="flex:{s.value};background:{s.color}"></span>
    {/each}
  {:else}
    <span class="fill" style="width:{pct}%;background:{color}"></span>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    width: 100%;
    border-radius: 999px;
    overflow: hidden;
    min-width: 0;
  }
  .fill {
    height: 100%;
    border-radius: 999px;
    transition: width 0.3s var(--ease);
  }
  .seg {
    height: 100%;
    min-width: 0;
  }
</style>
