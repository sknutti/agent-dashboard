<script lang="ts">
  // Live raw-JSONL event feed for one session. Callers control its lifecycle by
  // mounting/unmounting (e.g. an accordion renders it only while open).
  let { sessionId, fill = false }: { sessionId: string; fill?: boolean } = $props();

  let lines = $state<string[]>([]);
  let feedEl = $state<HTMLDivElement | null>(null);

  // Open the SSE stream and tail it; reconnect if the session changes. Syncing
  // with an external system (EventSource) is the legitimate use of $effect.
  $effect(() => {
    lines = [];
    const es = new EventSource(`/api/sessions/live/${sessionId}/stream`);
    es.addEventListener("line", (e: MessageEvent) => {
      lines = [...lines, e.data].slice(-500); // cap the scrollback
    });
    es.onerror = () => { /* keep the feed; SSE auto-reconnects or closes */ };
    return () => es.close();
  });

  // Auto-scroll the raw feed to the newest line (DOM sync → legitimate effect).
  $effect(() => {
    lines.length;
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });
</script>

<div class="feed mono" class:fill bind:this={feedEl}>
  {#if !lines.length}
    <div class="feed-empty">Connecting to raw event feed…</div>
  {:else}
    {#each lines as line, i (i)}
      <div class="line">{line}</div>
    {/each}
  {/if}
</div>

<style>
  .feed {
    max-height: 300px;
    /* Always-on (non-overlay) scrollbar: explicit ::-webkit-scrollbar styling
       below forces a persistent track in WebKit/Chromium whenever the content
       overflows, and scrollbar-gutter reserves the space so lines don't reflow
       when the bar appears. */
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--border-glow) transparent;
    border-top: 1px solid var(--border);
    background: var(--bg);
    padding: 10px 12px;
    font-size: 11px;
    line-height: 1.5;
  }
  .feed.fill {
    /* Standalone session page: grow to fill the viewport-height container. */
    max-height: none;
    height: 100%;
    border-top: none;
  }
  .feed::-webkit-scrollbar {
    width: 11px;
  }
  .feed::-webkit-scrollbar-track {
    background: transparent;
  }
  .feed::-webkit-scrollbar-thumb {
    background: var(--border-glow);
    border-radius: 6px;
    border: 3px solid var(--bg);
  }
  .feed::-webkit-scrollbar-thumb:hover {
    background: var(--text-subtle);
  }
  .feed-empty { color: var(--text-subtle); }
  .line {
    white-space: pre;
    color: var(--text-dim);
    overflow-x: auto;
    padding: 1px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }
</style>
