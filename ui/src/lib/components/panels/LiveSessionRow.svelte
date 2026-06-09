<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import { compact, homeDir, relTime } from "../../format";
  import type { LiveSession } from "../../api";

  let { session }: { session: LiveSession } = $props();

  let open = $state(false);
  let lines = $state<string[]>([]);
  let feedEl = $state<HTMLDivElement | null>(null);
  let es: EventSource | null = null;

  function start() {
    if (es) return;
    lines = [];
    es = new EventSource(`/api/sessions/live/${session.session_id}/stream`);
    es.addEventListener("line", (e: MessageEvent) => {
      lines = [...lines, e.data].slice(-500); // cap the scrollback
    });
    es.onerror = () => { /* keep the row open; SSE auto-reconnects or closes */ };
  }
  function stop() {
    es?.close();
    es = null;
  }
  function onToggle(e: Event) {
    open = (e.currentTarget as HTMLDetailsElement).open;
    if (open) start();
    else stop();
  }

  // Auto-scroll the raw feed to the newest line (DOM sync → legitimate effect).
  $effect(() => {
    lines.length;
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });

  onDestroy(stop);
</script>

<details class="acc" ontoggle={onToggle}>
  <summary>
    <span class="chev"><Icon name="chevron-right" size={14} /></span>
    <span class="title">{session.title ?? `session:${session.session_id.slice(0, 8)}`}</span>
    <span class="meta mono">
      <span class="proj">{homeDir(session.cwd)}</span>
      {#if session.model}<span class="model">{session.model}</span>{/if}
      <span class="tok">{compact(session.total_tokens)} tok</span>
      {#if (session.error_count ?? 0) > 0}<span class="err">{session.error_count} err</span>{/if}
      <span class="started">{relTime(session.started_at)}</span>
    </span>
  </summary>
  <div class="feed mono" bind:this={feedEl}>
    {#if !lines.length}
      <div class="feed-empty">Connecting to raw event feed…</div>
    {:else}
      {#each lines as line, i (i)}
        <div class="line">{line}</div>
      {/each}
    {/if}
  </div>
</details>

<style>
  .acc {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
  }
  .acc + :global(.acc) { margin-top: 8px; }
  summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: color-mix(in srgb, var(--border) 30%, transparent); }
  .chev { display: grid; place-items: center; color: var(--text-subtle); transition: transform 0.18s var(--ease); flex: none; }
  details[open] .chev { transform: rotate(90deg); }
  .title { font-size: 13px; font-weight: 560; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .meta { display: inline-flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-subtle); flex: none; }
  .meta .err { color: var(--red); }
  @media (max-width: 720px) { .meta .proj, .meta .model { display: none; } }
  .feed {
    max-height: 300px;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--bg, #0a0a0f);
    padding: 10px 12px;
    font-size: 11px;
    line-height: 1.5;
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
