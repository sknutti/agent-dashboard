<script lang="ts">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import Icon from "./Icon.svelte";

  // master §17: localStorage-persisted (cc:section:<id>), chevron rotates 90°,
  // 220ms height animation, proper aria-expanded/aria-controls.
  let {
    id,
    title,
    subtitle,
    summary,
    defaultOpen = true,
    children,
  }: {
    id: string;
    title: string;
    subtitle?: string;
    summary?: string;
    defaultOpen?: boolean;
    children: Snippet;
  } = $props();

  // id and defaultOpen are static props; reading their initial value here is intentional.
  // svelte-ignore state_referenced_locally
  const key = `cc:section:${id}`;
  const stored = localStorage.getItem(key);
  // svelte-ignore state_referenced_locally
  let open = $state(stored === null ? defaultOpen : stored === "1");

  function toggle() {
    open = !open;
    localStorage.setItem(key, open ? "1" : "0");
  }
</script>

<section class="collapsible">
  <button
    class="sec-head"
    onclick={toggle}
    aria-expanded={open}
    aria-controls="sec-{id}"
  >
    <span class="chev" class:open><Icon name="chevron-right" size={16} /></span>
    <span class="titles">
      <span class="sec-title">{title}</span>
      {#if subtitle}<span class="sec-sub">{subtitle}</span>{/if}
    </span>
    {#if summary && !open}<span class="sec-summary mono">{summary}</span>{/if}
  </button>

  {#if open}
    <div
      id="sec-{id}"
      class="sec-body"
      transition:slide={{ duration: 220, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .collapsible {
    margin-bottom: 4px;
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 12px 4px;
    background: none;
    border: none;
    text-align: left;
    color: var(--text);
  }
  .chev {
    display: grid;
    place-items: center;
    color: var(--text-subtle);
    transition: transform 0.22s var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
    color: var(--text-dim);
  }
  .titles {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .sec-title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .sec-sub {
    font-size: 12px;
    color: var(--text-dim);
  }
  .sec-summary {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .sec-body {
    padding: 8px 2px 20px;
  }
</style>
