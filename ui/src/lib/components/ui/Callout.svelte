<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // Messagebox / note / inline-error-confirm primitive (§4), replacing the
  // hand-rolled `.note` boxes (×7). Meaning never rides on hue alone (Scott is
  // red/green colourblind): a tone always pairs with a glyph/title, and `warn`
  // is AMBER (not red), `info` is CYAN — preserving the existing CVD-safe scheme.
  type CalloutTone = "neutral" | "info" | "warn";
  let {
    tone = "neutral",
    icon,
    title,
    role,
    children,
  }: {
    tone?: CalloutTone;
    icon?: string;
    title?: string;
    role?: string; // e.g. "alert" | "status" — pass through when used for errors
    children?: Snippet;
  } = $props();
</script>

<div class="callout {tone}" {role}>
  {#if icon}<Icon name={icon} size={15} stroke={1.7} />{/if}
  <div class="body">
    {#if title}<p class="title">{title}</p>{/if}
    {#if children}<div class="text">{@render children()}</div>{/if}
  </div>
</div>

<style>
  .callout {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 12px 14px;
    border-radius: 10px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .callout :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .title {
    margin: 0 0 2px;
    font-weight: 600;
    color: var(--text);
  }
  .body {
    min-width: 0;
  }
  .neutral {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
  }
  /* Cool complement — informational, never a status warning. */
  .info {
    border: 1px solid color-mix(in srgb, var(--cyan) 40%, var(--border));
    background: color-mix(in srgb, var(--cyan) 10%, var(--surface));
    color: var(--text-dim);
  }
  .info :global(svg) {
    color: var(--cyan);
  }
  /* Amber, NOT red (CVD). The glyph + title carry the warning meaning. */
  .warn {
    border: 1px solid color-mix(in srgb, var(--amber) 45%, var(--border));
    background: color-mix(in srgb, var(--amber) 10%, var(--surface));
    color: var(--text-dim);
  }
  .warn :global(svg) {
    color: var(--amber);
  }
</style>
