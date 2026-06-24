<script lang="ts">
  import type { Snippet } from "svelte";
  // Label + control wrapper (master §3) — the `.meta-field` / `.meta-targets`
  // pattern. The control itself is the `children` snippet; `for` associates the
  // label with it (the caller gives the control a matching `id`). `error` carries
  // its meaning in TEXT (and is amber, not red — Scott is red/green colorblind)
  // and gets role="alert" so AT announces it.
  let {
    label,
    hint,
    error,
    for: htmlFor,
    children,
  }: {
    label?: string;
    hint?: string;
    error?: string;
    for?: string;
    children?: Snippet;
  } = $props();
</script>

<div class="field">
  {#if label}<label class="field-label" for={htmlFor}>{label}</label>{/if}
  {#if children}{@render children()}{/if}
  {#if hint}<p class="field-hint">{hint}</p>{/if}
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 11px;
    color: var(--text-dim);
  }
  .field-hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-subtle);
  }
  /* Amber + explicit text — never red-alone (CVD). */
  .field-error {
    margin: 0;
    font-size: 11.5px;
    color: var(--amber);
  }
</style>
