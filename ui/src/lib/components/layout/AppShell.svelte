<script lang="ts">
  import type { Snippet } from "svelte";
  import Nav from "./Nav.svelte";
  import SystemHealthStrip from "./SystemHealthStrip.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import Icon from "../ui/Icon.svelte";
  import { startHealthPolling, palette } from "../../stores.svelte";

  let { title, children }: { title: string; children: Snippet } = $props();

  // Poll system health for as long as the shell is mounted. Synchronizing with
  // an external system (the server) is the legitimate use of $effect — it is
  // the Svelte analog of the allowed "external-system custom hook".
  $effect(() => startHealthPolling(30_000));

  // Global ⌘K / Ctrl-K to toggle the command palette (master §22 keyboard).
  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.open = !palette.open;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="shell">
  <Nav />

  <div class="main">
    <header class="topbar">
      <h1 class="page-title">{title}</h1>
      <div class="topbar-right">
        <SystemHealthStrip />
        <!-- ds-allow-native: composite search affordance (Search label + ⌘K kbd hint needs scoped kbd styling Button can't provide). -->
        <button class="kbtn" onclick={() => (palette.open = true)} aria-label="Open command palette">
          <Icon name="search" size={14} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>

    <main class="content">
      {@render children()}
    </main>
  </div>
</div>

<CommandPalette />

<!-- The real drill-down drawer is mounted once in App.svelte (DrillSheet). The
     Phase-0 placeholder Sheet that used to live here was dead and double-mounted
     on the same `drill` store — every drill opened two stacked aria-modal dialogs. -->

<style>
  .shell {
    display: flex;
    min-height: 100dvh;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    flex-wrap: wrap;
    padding: 18px 32px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(10px);
    z-index: 40;
  }
  .page-title {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .kbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 12.5px;
    transition: all 0.15s var(--ease);
  }
  .kbtn:hover {
    color: var(--text);
    border-color: var(--border-glow);
  }
  .kbtn kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-subtle);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }
  .content {
    flex: 1;
    padding: 26px 32px 60px;
    max-width: 1320px;
    width: 100%;
  }
</style>
