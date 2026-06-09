<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // Empty states that TEACH (§22), not just "no data". Phase 0 panels are all
  // empty by design — this is the component that makes that feel intentional.
  let {
    icon = "box",
    title,
    message,
    children,
  }: { icon?: string; title: string; message?: string; children?: Snippet } =
    $props();
</script>

<div class="empty">
  <div class="glyph"><Icon name={icon} size={22} stroke={1.6} /></div>
  <p class="empty-title">{title}</p>
  {#if message}<p class="empty-msg">{message}</p>{/if}
  {#if children}<div class="empty-extra">{@render children()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    padding: 30px 18px;
    color: var(--text-dim);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 13px;
    margin-bottom: 4px;
    color: var(--text-subtle);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .empty-title {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
  }
  .empty-msg {
    margin: 0;
    max-width: 40ch;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-dim);
  }
  .empty-extra {
    margin-top: 6px;
  }
</style>
