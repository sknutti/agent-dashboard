<script lang="ts">
  import type { Snippet } from "svelte";
  // Hover/focus tooltip with arrow and a short delay (§22). CSS-driven.
  let { text, children }: { text: string; children: Snippet } = $props();
</script>

<span class="tip-wrap" tabindex="-1">
  {@render children()}
  <span class="tip" role="tooltip">{text}<span class="arrow"></span></span>
</span>

<style>
  .tip-wrap {
    position: relative;
    display: inline-flex;
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 9px);
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    padding: 6px 9px;
    border-radius: 7px;
    background: #07070c;
    border: 1px solid var(--border-glow);
    color: var(--text);
    font-size: 11.5px;
    line-height: 1.35;
    white-space: nowrap;
    max-width: 280px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.14s var(--ease) 0.25s,
      transform 0.14s var(--ease) 0.25s;
    z-index: 60;
  }
  .arrow {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%) rotate(45deg) translateY(-4px);
    width: 8px;
    height: 8px;
    background: #07070c;
    border-right: 1px solid var(--border-glow);
    border-bottom: 1px solid var(--border-glow);
  }
  .tip-wrap:hover .tip,
  .tip-wrap:focus-within .tip {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
</style>
