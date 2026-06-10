<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import Icon from "./Icon.svelte";

  // Right slide-out drawer (master §17 / §22): Esc-to-close, backdrop click,
  // aria-modal. The drill-down detail and the info-modal both use this.
  let {
    open = false,
    title,
    subtitle,
    width = 460,
    onClose,
    children,
  }: {
    open?: boolean;
    title: string;
    subtitle?: string;
    width?: number;
    onClose: () => void;
    children?: Snippet;
  } = $props();

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  // Focus trap (a Svelte action — DOM lifecycle sync, not a component effect).
  // An aria-modal dialog must keep Tab within itself and restore focus to the
  // trigger on close; without it, Tab walks back into the page behind the scrim.
  function trapFocus(node: HTMLElement) {
    const restoreTo = document.activeElement as HTMLElement | null;
    const SEL =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const visible = () =>
      Array.from(node.querySelectorAll<HTMLElement>(SEL)).filter((el) => el.offsetParent !== null);
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const f = visible();
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    node.addEventListener("keydown", onKey);
    return {
      destroy() {
        node.removeEventListener("keydown", onKey);
        restoreTo?.focus?.();
      },
    };
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Backdrop is a mouse convenience; keyboard close is handled by Esc on window. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 160 }} onclick={onClose} role="presentation"></div>
  <div
    class="sheet"
    style="width:{width}px"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    use:trapFocus
    transition:fly={{ x: width, duration: 240, easing: cubicOut }}
  >
    <header class="sheet-head">
      <div class="ht">
        <h2>{title}</h2>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <button class="close" onclick={onClose} aria-label="Close" autofocus>
        <Icon name="x" size={16} />
      </button>
    </header>
    <div class="sheet-body">
      {#if children}{@render children()}{/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(4, 4, 9, 0.62);
    backdrop-filter: blur(2px);
    z-index: 80;
  }
  .sheet {
    position: fixed;
    top: 0;
    right: 0;
    height: 100dvh;
    max-width: 92vw;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--border-glow);
    box-shadow: -24px 0 60px rgba(0, 0, 0, 0.5);
    z-index: 81;
  }
  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 22px 24px 18px;
    border-bottom: 1px solid var(--border);
  }
  .ht h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .ht p {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .close {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-dim);
    transition: all 0.15s var(--ease);
  }
  .close:hover {
    color: var(--text);
    border-color: var(--border-glow);
  }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 22px 24px;
  }
</style>
