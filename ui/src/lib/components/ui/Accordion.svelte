<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // Inline native <details> accordion for row expansion (ADR-0003 validated
  // affordance). Used by Live sessions to reveal a scrollable raw feed.
  let {
    summary,
    scroll = false,
    children,
  }: { summary: Snippet; scroll?: boolean; children: Snippet } = $props();
</script>

<details class="acc">
  <summary>
    <span class="chev"><Icon name="chevron-right" size={14} /></span>
    <span class="sum">{@render summary()}</span>
  </summary>
  <div class="acc-body" class:scroll>{@render children()}</div>
</details>

<style>
  .acc {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
  }
  .acc + :global(.acc) {
    margin-top: 8px;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 13px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: color-mix(in srgb, var(--border) 30%, transparent);
  }
  .chev {
    display: grid;
    place-items: center;
    color: var(--text-subtle);
    transition: transform 0.18s var(--ease);
    flex: none;
  }
  details[open] .chev {
    transform: rotate(90deg);
  }
  .sum {
    min-width: 0;
    flex: 1;
  }
  .acc-body {
    padding: 12px 13px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .acc-body.scroll {
    max-height: 300px;
    overflow-y: auto;
  }
</style>
