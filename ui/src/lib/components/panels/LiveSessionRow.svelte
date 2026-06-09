<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import SessionFeed from "./SessionFeed.svelte";
  import { compact, homeDir, relTime } from "../../format";
  import type { LiveSession } from "../../api";

  // Controlled accordion: the panel owns which row is open (single-open), so
  // the row reports clicks via onToggle and reflects the `open` prop. The feed
  // is only mounted while open, which lazily starts/stops its EventSource.
  let { session, open, onToggle }: {
    session: LiveSession;
    open: boolean;
    onToggle: () => void;
  } = $props();
</script>

<div class="acc" class:open>
  <div class="summary">
    <button class="summary-main" onclick={onToggle} aria-expanded={open}>
      <span class="chev"><Icon name="chevron-right" size={14} /></span>
      <span class="title">{session.title ?? `session:${session.session_id.slice(0, 8)}`}</span>
      <span class="meta mono">
        <span class="proj">{homeDir(session.cwd)}</span>
        {#if session.model}<span class="pill model">{session.model}</span>{/if}
        <span class="pill tok">{compact(session.total_tokens)} tok</span>
        {#if (session.error_count ?? 0) > 0}<span class="err">{session.error_count} err</span>{/if}
        <span class="started">{relTime(session.started_at)}</span>
      </span>
    </button>
    <a
      class="open-page"
      href={`/session/${session.session_id}`}
      target="_blank"
      rel="noopener"
      title="Open this session in a new page"
      aria-label="Open this session in a new page"
    >
      <Icon name="external-link" size={14} />
    </a>
  </div>

  {#if open}
    <SessionFeed sessionId={session.session_id} />
  {/if}
</div>

<style>
  .acc {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
  }
  .acc + :global(.acc) { margin-top: 8px; }
  .summary {
    display: flex;
    align-items: stretch;
  }
  .summary-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .summary-main:hover { background: color-mix(in srgb, var(--border) 30%, transparent); }
  .chev { display: grid; place-items: center; color: var(--text-subtle); transition: transform 0.18s var(--ease); flex: none; }
  .acc.open .chev { transform: rotate(90deg); }
  .title { font-size: 13px; font-weight: 560; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .meta { display: inline-flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-subtle); flex: none; }
  .meta .err { color: var(--red); }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 10.5px;
    line-height: 1.4;
  }
  .pill.model { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 35%, var(--border)); }
  .pill.tok { color: var(--text-dim); }
  .open-page {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    border: none;
    border-left: 1px solid var(--border);
    background: none;
    color: var(--text-subtle);
    transition: all 0.15s var(--ease);
  }
  .open-page:hover { color: var(--text); background: color-mix(in srgb, var(--border) 30%, transparent); }
  @media (max-width: 720px) { .meta .proj, .meta .model { display: none; } }
</style>
