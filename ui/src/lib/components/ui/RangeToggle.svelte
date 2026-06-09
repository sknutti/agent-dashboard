<script lang="ts">
  import type { Range } from "../../api";
  // Range toggle (master §16). Local-time bucketing happens server-side.
  let {
    value,
    options = ["today", "7d", "30d"],
    onChange,
  }: { value: Range; options?: Range[]; onChange: (r: Range) => void } = $props();
  const LABEL: Record<string, string> = { today: "Today", "7d": "7d", "30d": "30d", "90d": "90d" };
</script>

<div class="seg" role="tablist">
  {#each options as o (o)}
    <button
      class="seg-btn"
      class:active={value === o}
      role="tab"
      aria-selected={value === o}
      onclick={() => onChange(o)}>{LABEL[o]}</button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .seg-btn {
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-subtle);
    transition: all 0.15s var(--ease);
  }
  .seg-btn:hover {
    color: var(--text-dim);
  }
  .seg-btn.active {
    /* Any low-opacity orange over a dark base reads as muddy brown, so the
       active pill is a neutral raised surface — the warmth lives in the accent
       text and the orange ring, not in the fill. */
    color: var(--accent-from);
    background: var(--border-glow);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-from) 50%, transparent);
  }
</style>
