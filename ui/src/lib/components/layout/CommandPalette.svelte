<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import Icon from "../ui/Icon.svelte";
  import { palette } from "../../stores.svelte";
  import { ROUTES, navigate, type RoutePath } from "../../router.svelte";

  type Item = {
    label: string;
    hint: string;
    icon: string;
    disabled?: boolean;
    go?: RoutePath;
  };

  const ITEMS: Item[] = [
    ...ROUTES.map((r) => ({
      label: `Go to ${r.label}`,
      hint: "Page",
      icon: r.icon,
      go: r.path,
    })),
    // Acting on agents is the Operations layer — ships in Phase 6 (ADR-0003).
    { label: "Queue a task", hint: "Phase 6", icon: "terminal", disabled: true },
  ];

  let query = $state("");
  let selected = $state(0);

  const filtered = $derived(
    ITEMS.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
  );

  function close() {
    palette.open = false;
    query = "";
    selected = 0;
  }

  function run(item: Item | undefined) {
    if (!item || item.disabled) return;
    if (item.go) navigate(item.go);
    close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[selected]);
    }
  }
</script>

{#if palette.open}
  <!-- Backdrop is a mouse convenience; keyboard close is Esc, handled in the input. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 120 }} onclick={close} role="presentation"></div>
  <div
    class="palette"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    transition:scale={{ duration: 160, start: 0.97, easing: cubicOut }}
  >
    <div class="search">
      <Icon name="search" size={16} />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={query}
        oninput={() => (selected = 0)}
        onkeydown={onKeydown}
        placeholder="Search pages and actions…"
        aria-label="Search pages and actions"
      />
      <kbd>ESC</kbd>
    </div>
    <ul class="results">
      {#each filtered as item, i (item.label)}
        <li>
          <button
            class="row"
            class:active={i === selected}
            class:disabled={item.disabled}
            disabled={item.disabled}
            onmouseenter={() => (selected = i)}
            onclick={() => run(item)}
          >
            <Icon name={item.icon} size={15} />
            <span class="lbl">{item.label}</span>
            <span class="hint mono">{item.hint}</span>
          </button>
        </li>
      {:else}
        <li class="none">No matches</li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(4, 4, 9, 0.55);
    backdrop-filter: blur(2px);
    z-index: 90;
  }
  .palette {
    position: fixed;
    top: 16vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-glow);
    border-radius: 14px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
    z-index: 91;
    overflow: hidden;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 15px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text-dim);
  }
  .search input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text);
    font-family: inherit;
    font-size: 14.5px;
  }
  .search input::placeholder {
    color: var(--text-subtle);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-subtle);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 6px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 46vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 10px 11px;
    border: none;
    border-radius: 9px;
    background: none;
    color: var(--text-dim);
    text-align: left;
  }
  .row.active {
    background: color-mix(in srgb, var(--accent-from) 16%, transparent);
    color: var(--text);
  }
  .row.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .lbl {
    flex: 1;
  }
  .hint {
    font-size: 10.5px;
    color: var(--text-subtle);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 6px;
  }
  .none {
    list-style: none;
    padding: 18px;
    text-align: center;
    color: var(--text-subtle);
    font-size: 13px;
  }
</style>
