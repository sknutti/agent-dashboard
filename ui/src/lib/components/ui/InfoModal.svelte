<script lang="ts">
  import type { Snippet } from "svelte";
  import Sheet from "./Sheet.svelte";
  import Icon from "./Icon.svelte";
  // Info-modal affordance (ADR-0003 validated) — an "i" button that opens a
  // Sheet. Demonstrates Sheet reuse beyond the drill-down.
  let { title, children }: { title: string; children: Snippet } = $props();
  let open = $state(false);
</script>

<button class="info-btn" onclick={() => (open = true)} aria-label="More info">
  <Icon name="info" size={15} />
</button>

<Sheet {open} {title} width={420} onClose={() => (open = false)}>
  {@render children()}
</Sheet>

<style>
  .info-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-subtle);
    transition: all 0.15s var(--ease);
  }
  .info-btn:hover {
    color: var(--text-dim);
    border-color: var(--border-glow);
  }
</style>
