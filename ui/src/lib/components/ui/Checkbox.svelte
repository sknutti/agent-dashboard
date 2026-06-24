<script lang="ts">
  import type { Snippet } from "svelte";
  // Checkbox primitive (master §3) — the `.check` label/input pair. The native
  // <input type="checkbox"> is kept on purpose: it already respects the dark
  // color-scheme and carries its own checked semantics for AT. `checked` is
  // `$bindable` so callers keep `bind:checked`. Label text comes from `label`
  // or, for richer content, the `children` snippet.
  let {
    checked = $bindable(false),
    disabled = false,
    onchange,
    label,
    children,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onchange?: (e: Event) => void;
    label?: string;
    children?: Snippet;
  } = $props();
</script>

<label class="check">
  <input type="checkbox" bind:checked {disabled} {onchange} />
  <span>{#if children}{@render children()}{:else}{label}{/if}</span>
</label>

<style>
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text);
    cursor: pointer;
  }
</style>
