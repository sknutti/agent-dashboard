<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  // The one button primitive (master §3) — folds the hand-rolled `.act` control
  // (×N) into a single accessible surface. `primary` finally reads as accent:
  // the old `.act.primary` used the undefined `var(--accent)`, so those buttons
  // silently rendered as plain defaults; this uses `--accent-from` on purpose.
  //
  // `danger` is AMBER, not red — Scott is red/green colorblind, so destructive
  // intent leans on the warm border + the button's own text, never hue alone.
  //
  // Icon-only usage is forbidden here (no accessible name) — reach for IconButton.
  type ButtonVariant = "default" | "primary" | "ghost" | "danger";
  type ButtonSize = "sm" | "md";
  let {
    variant = "default",
    size = "md",
    type = "button",
    disabled = false,
    loading = false,
    icon,
    iconSize,
    href,
    ariaLabel,
    onclick,
    class: cls = "",
    children,
    ...rest
  }: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    loading?: boolean;
    icon?: string;
    iconSize?: number;
    href?: string;
    ariaLabel?: string;
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
    // Forward arbitrary native attributes (data-testid, name, title, aria-*, …)
    // to the rendered element — a wrapper must not swallow them.
  } & Record<string, unknown> = $props();

  // loading implies disabled; either one blocks the click.
  const isDisabled = $derived(disabled || loading);
  const glyphSize = $derived(iconSize ?? (size === "sm" ? 13 : 14));

  function handleClick(e: MouseEvent): void {
    if (isDisabled) return; // a link can't use `disabled`, so guard here too
    onclick?.(e);
  }
</script>

{#if href}
  <a
    class="btn {variant} {size} {cls}"
    class:loading
    {...rest}
    {href}
    aria-label={ariaLabel}
    aria-disabled={isDisabled || undefined}
    onclick={handleClick}
  >
    {#if icon}<Icon name={icon} size={glyphSize} />{/if}
    {#if children}{@render children()}{/if}
  </a>
{:else}
  <button
    class="btn {variant} {size} {cls}"
    class:loading
    {...rest}
    {type}
    disabled={isDisabled}
    aria-label={ariaLabel}
    onclick={handleClick}
  >
    {#if icon}<Icon name={icon} size={glyphSize} />{/if}
    {#if children}{@render children()}{/if}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font-family: inherit;
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .sm {
    padding: 4px 11px;
    font-size: 11.5px;
    border-radius: 6px;
  }
  .md {
    padding: 6px 14px;
    font-size: 12.5px;
  }
  .btn:not(:disabled):hover {
    border-color: var(--border-glow);
  }
  .btn:disabled,
  .btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .primary {
    background: color-mix(in srgb, var(--accent-from) 20%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent-from) 45%, var(--border));
    color: var(--accent-ink);
  }
  .ghost {
    background: transparent;
  }
  /* Amber, not red — CVD-safe destructive signal (see header note). */
  .danger {
    border-color: color-mix(in srgb, var(--amber) 55%, var(--border));
  }
  /* A subtle dimming while loading — no new colour introduced. */
  .btn.loading {
    opacity: 0.5;
  }
</style>
