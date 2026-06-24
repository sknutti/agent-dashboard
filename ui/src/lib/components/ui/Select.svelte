<script lang="ts">
  // Select primitive (master §3) — lifts the `.sel` dropdown. Accepts either bare
  // strings or `{value,label}` objects and normalizes; `value` is `$bindable`.
  type Opt = string | { value: string; label: string };
  let {
    value = $bindable(""),
    options,
    disabled = false,
    size = "sm",
    ariaLabel,
    onchange,
    class: cls = "",
  }: {
    value?: string;
    options: Opt[];
    disabled?: boolean;
    size?: "sm" | "md";
    ariaLabel?: string;
    onchange?: (e: Event) => void;
    class?: string;
  } = $props();

  // string → {value:s, label:s}; objects pass through.
  const normalized = $derived(
    options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
  );
</script>

<select
  class="sel {size} {cls}"
  bind:value
  {disabled}
  aria-label={ariaLabel}
  {onchange}
>
  {#each normalized as o (o.value)}
    <option value={o.value}>{o.label}</option>
  {/each}
</select>

<style>
  .sel {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-dim);
    font-family: inherit;
    cursor: pointer;
  }
  .sm {
    font-size: 11px;
    padding: 3px 6px;
  }
  .md {
    font-size: 12.5px;
    padding: 5px 8px;
  }
  .sel:focus {
    outline: none;
    border-color: var(--border-glow);
  }
  .sel:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
