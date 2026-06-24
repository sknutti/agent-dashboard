<script lang="ts">
  // Multi-line input primitive (master §3) — same border/focus language as Input,
  // but the WorkingFileEditor textarea shape: roomier radius/padding, mono font,
  // vertical-only resize. `value` is `$bindable` for `bind:value`.
  let {
    value = $bindable(""),
    rows = 4,
    placeholder,
    disabled = false,
    oninput,
    class: cls = "",
    ...rest
  }: {
    value?: string;
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    oninput?: (e: Event) => void;
    class?: string;
    // Forward arbitrary native attributes (data-testid, name, …).
  } & Record<string, unknown> = $props();
</script>

<textarea
  class="textarea {cls}"
  {...rest}
  bind:value
  {rows}
  {placeholder}
  {disabled}
  {oninput}
></textarea>

<style>
  .textarea {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 10px 12px;
    resize: vertical;
  }
  .textarea:focus {
    outline: none;
    border-color: var(--border-glow);
  }
  .textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .textarea::placeholder {
    color: var(--text-subtle);
  }
</style>
