<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import IconButton from "./IconButton.svelte";

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
    // Move focus into the dialog on open (the close button is the first focusable
    // element). Replaces the close button's old `autofocus` attribute, which the
    // IconButton primitive doesn't expose — keeps the modal's focus contract intact.
    visible()[0]?.focus();
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
      <IconButton icon="x" label="Close" iconSize={16} class="close" onclick={onClose} />
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
  /* The close control is the IconButton primitive (30px r8 default matches the
     original); only keep it from shrinking in the header flex row. */
  .sheet-head :global(.close) {
    flex: none;
  }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 22px 24px;
  }
</style>
