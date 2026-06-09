<script lang="ts">
  // Icon-only fidelity badge (ADR-0003 validated affordance). Every token/cost
  // figure carries one so an estimate can never visually pass as a measurement.
  //   exact     -> "=" cyan   (counted from logs)
  //   estimated -> "≈" amber  (rack-rate calibration)
  let { fidelity }: { fidelity: "exact" | "estimated" } = $props();
  const glyph = $derived(fidelity === "exact" ? "=" : "≈");
  const title = $derived(
    fidelity === "exact"
      ? "Exact — counted directly from logs"
      : "Estimated — rack-rate calibration, not a measurement",
  );
</script>

<span class="fid {fidelity}" {title} aria-label={title}>{glyph}</span>

<style>
  .fid {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--border);
    cursor: help;
    user-select: none;
  }
  .exact {
    color: var(--cyan);
    border-color: color-mix(in srgb, var(--cyan) 45%, var(--border));
    background: color-mix(in srgb, var(--cyan) 12%, transparent);
  }
  .estimated {
    color: var(--amber);
    border-color: color-mix(in srgb, var(--amber) 45%, var(--border));
    background: color-mix(in srgb, var(--amber) 12%, transparent);
  }
</style>
