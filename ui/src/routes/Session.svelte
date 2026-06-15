<script lang="ts">
  import Icon from "../lib/components/ui/Icon.svelte";
  import SessionMessages from "../lib/components/panels/SessionMessages.svelte";
  import SessionErrors from "../lib/components/panels/SessionErrors.svelte";
  import GitOutcomeStrip from "../lib/components/panels/GitOutcomeStrip.svelte";
  import { getSessionDetail } from "../lib/api";
  import { resource } from "../lib/resource.svelte";
  import { compact, homeDir, relTime} from "../lib/format";
  import { AGENT_NAMES } from "../lib/registry.svelte";
  import { navigate, router, tabFromSearch } from "../lib/router.svelte";

  let { id }: { id: string } = $props();

  const res = resource(() => `session:${id}`, () => getSessionDetail(id));
  const session = $derived(res.data?.session ?? null);
  const agentName = $derived(session ? (AGENT_NAMES[session.agent] ?? session.agent) : "");

  // Active tab tracks the URL query, so deep-links (?tab=errors) and browser
  // back/forward both Just Work — clicking a tab pushes the query and this
  // recomputes. Default is Messages (the complete, in-order live feed).
  const activeTab = $derived(tabFromSearch(router.search));
  function selectTab(tab: "errors" | "messages"): void {
    navigate(`/session/${id}`, tab === "errors" ? "?tab=errors" : "?tab=messages");
  }
</script>

<div class="session-page">
  <header class="head">
    <button class="back" onclick={() => navigate("/")} title="Back to dashboard">
      <Icon name="chevron-right" size={16} class="flip" />
      <span>Dashboard</span>
    </button>

    {#if session}
      <div class="head-main">
        <h1 class="title">{session.title ?? `session:${id.slice(0, 8)}`}</h1>
        <div class="meta mono">
          <span class="agent">{agentName}</span>
          {#if session.model}<span class="pill model">{session.model}</span>{/if}
          <span class="pill tok">{compact(session.total_tokens)} tok</span>
          {#if (session.error_count ?? 0) > 0}<span class="err">{session.error_count} err</span>{/if}
          <span class="proj">{homeDir(session.cwd)}</span>
          <span class="started">{relTime(session.started_at)}</span>
        </div>
        <GitOutcomeStrip {id} />
      </div>
    {:else if res.error}
      <h1 class="title">Session not found</h1>
    {:else}
      <h1 class="title muted">Loading session…</h1>
    {/if}
  </header>

  <div class="tabs" role="tablist" aria-label="Session view">
    <button
      class="tab" role="tab" aria-selected={activeTab === "errors"}
      class:active={activeTab === "errors"} onclick={() => selectTab("errors")}>
      Errors
    </button>
    <button
      class="tab" role="tab" aria-selected={activeTab === "messages"}
      class:active={activeTab === "messages"} onclick={() => selectTab("messages")}>
      Messages
    </button>
  </div>

  <div class="feed-wrap">
    {#if activeTab === "errors"}
      <SessionErrors sessionId={id} />
    {:else}
      <!-- Messages auto-branches on session state (ADR-0006): an ended session
           renders the parsed Transcript as grouped-turn cards; a still-live one
           keeps the raw byte-tail. Mounted only while active. -->
      <SessionMessages sessionId={id} />
    {/if}
  </div>
</div>

<style>
  .session-page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--bg, #0a0a0f);
  }
  .head {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    padding: 5px 9px 5px 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 12.5px;
    transition: all 0.15s var(--ease);
  }
  .back:hover { color: var(--text); border-color: var(--border-glow); }
  .back :global(svg.flip) { transform: rotate(180deg); }
  .head-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .title {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title.muted { color: var(--text-subtle); font-weight: 500; }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .meta .agent { color: var(--text-dim); font-weight: 560; }
  .meta .err { color: var(--red); }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 11px;
    line-height: 1.4;
  }
  .pill.model { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 35%, var(--border)); }
  .pill.tok { color: var(--text-dim); }
  .tabs {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 10px 14px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-subtle);
    font-size: 13px;
    font-weight: 560;
    transition: color 0.15s var(--ease);
  }
  .tab:hover { color: var(--text-dim); }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--cyan);
  }
  .feed-wrap {
    flex: 1;
    min-height: 0;
  }
</style>
