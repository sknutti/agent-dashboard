<script lang="ts">
  import type { Snippet } from "svelte";
  import Nav from "./Nav.svelte";
  import SystemHealthStrip from "./SystemHealthStrip.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import Sheet from "../ui/Sheet.svelte";
  import Icon from "../ui/Icon.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { startHealthPolling, palette, drill, closeDrill } from "../../stores.svelte";

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

<!-- First-class read-only drill-down plumbing (ADR-0003). Phase 1 fills the body. -->
<Sheet open={drill.open} title={drill.ctx?.title ?? ""} subtitle={drill.ctx?.subtitle} onClose={closeDrill}>
  <EmptyState
    icon="layers"
    title="Drill-down wired — no data yet"
    message="This read-only detail view is plumbed in Phase 0. Phase 1 fills it from the sessions API."
  >
    {#if drill.ctx?.query}
      <code class="q mono">{drill.ctx.query}</code>
    {/if}
  </EmptyState>
</Sheet>

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
  .q {
    display: inline-block;
    font-size: 11.5px;
    color: var(--cyan);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 5px 9px;
  }
</style>
