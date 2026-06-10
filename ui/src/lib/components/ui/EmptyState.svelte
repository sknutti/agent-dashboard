<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // Empty states that TEACH (§22), not just "no data". Phase 0 panels are all
  // empty by design — this is the component that makes that feel intentional.
  //
  // `error` mode: when a panel's fetch FAILED (vs genuinely-empty), passing
  // `error={res.error}` flips this to an honest failure state instead of a
  // misleading "No data" — critical for a cost dashboard that must never imply
  // "zero spend" when the API is actually down. Optional `onRetry` adds a button.
  let {
    icon = "box",
    title,
    message,
    error = false,
    onRetry,
    children,
  }: {
    icon?: string;
    title: string;
    message?: string;
    error?: boolean;
    onRetry?: () => void;
    children?: Snippet;
  } = $props();
</script>

<div class="empty">
  <div class="glyph" class:err={error}>
    <Icon name={error ? "alert" : icon} size={22} stroke={1.6} />
  </div>
  <p class="empty-title">{error ? "Couldn’t load data" : title}</p>
  {#if error}
    <p class="empty-msg">The server may be down or restarting. Numbers shown elsewhere may be stale.</p>
    {#if onRetry}<button class="retry" onclick={onRetry}>Retry</button>{/if}
  {:else}
    {#if message}<p class="empty-msg">{message}</p>{/if}
    {#if children}<div class="empty-extra">{@render children()}</div>{/if}
  {/if}
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
  /* Error glyph: amber (warning), not red — Scott is red/green colourblind and
     red-alone is a poor signal. The "Couldn’t load" title carries the meaning. */
  .glyph.err {
    color: var(--amber);
    border-color: color-mix(in srgb, var(--amber) 45%, var(--border));
    background: color-mix(in srgb, var(--amber) 12%, var(--surface-2));
  }
  .retry {
    margin-top: 10px;
    padding: 5px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
    transition: border-color 0.15s var(--ease);
  }
  .retry:hover { border-color: var(--border-glow); }
</style>
