<script lang="ts">
  // Text input primitive (master §3) — lifts `.meta-field input` verbatim so the
  // migration is pixel-faithful. `value` is `$bindable` so callers keep their
  // `bind:value` ergonomics; `ariaLabel` covers the (common) label-less usage.
  let {
    value = $bindable(""),
    type = "text",
    placeholder,
    disabled = false,
    id,
    ariaLabel,
    oninput,
    onkeydown,
    onchange,
    class: cls = "",
    ...rest
  }: {
    value?: string;
    type?: "text" | "email" | "password" | "search" | "number" | "url";
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    ariaLabel?: string;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onchange?: (e: Event) => void;
    class?: string;
    // Forward arbitrary native attributes (data-testid, name, autocomplete, …).
  } & Record<string, unknown> = $props();
</script>

<input
  class="input {cls}"
  {...rest}
  {type}
  bind:value
  {placeholder}
  {disabled}
  {id}
  aria-label={ariaLabel}
  {oninput}
  {onkeydown}
  {onchange}
/>

<style>
  .input {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    padding: 6px 8px;
  }
  .input:focus {
    outline: none;
    border-color: var(--border-glow);
  }
  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .input::placeholder {
    color: var(--text-subtle);
  }
</style>
