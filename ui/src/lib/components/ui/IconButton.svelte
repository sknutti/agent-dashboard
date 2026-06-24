<script lang="ts">
  import Icon from "./Icon.svelte";
  // Square, icon-only button (master §3) — the Sheet close (.close 30px r8),
  // InfoModal (.info-btn 26px r7) and search affordances fold into this. Because
  // there's no visible text, `label` is REQUIRED and becomes the aria-label, so
  // these never ship as an unlabelled glyph.
  let {
    icon,
    size = 30,
    iconSize = 15,
    label,
    variant = "default",
    disabled = false,
    onclick,
    class: cls = "",
  }: {
    icon: string;
    size?: number;
    iconSize?: number;
    label: string;
    variant?: "default" | "ghost";
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    class?: string;
  } = $props();

  // Larger affordances get r8, the smaller info-style get r7 (matches the originals).
  const radius = $derived(size >= 30 ? 8 : 7);

  // `disabled` defensively gates the handler too. The native attribute already
  // suppresses clicks in a real browser, but programmatic dispatch (and tests)
  // bypass it — this keeps "disabled blocks onclick" true everywhere.
  function handleClick(e: MouseEvent): void {
    if (disabled) return;
    onclick?.(e);
  }
</script>

<button
  class="icon-btn {variant} {cls}"
  style="width:{size}px;height:{size}px;border-radius:{radius}px;"
  aria-label={label}
  title={label}
  {disabled}
  onclick={handleClick}
>
  <Icon name={icon} size={iconSize} />
</button>

<style>
  .icon-btn {
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-dim);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      color 0.15s var(--ease);
  }
  .icon-btn:not(:disabled):hover {
    color: var(--text);
    border-color: var(--border-glow);
  }
  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost {
    background: transparent;
    border-color: transparent;
  }
</style>
