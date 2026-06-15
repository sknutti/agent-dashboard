<script lang="ts">
  // Full-text search over session TRANSCRIPT CONTENT (FTS5 tracer) — distinct from
  // the metadata `q` box on the Sessions table (title/cwd only). Event-driven, not
  // resource()-driven: the query comes from user input, so we debounce the fetch in
  // the input handler and write results to $state — deliberately NO $effect.
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Badge from "../ui/Badge.svelte";
  import Icon from "../ui/Icon.svelte";
  import { searchContent, type SearchResult } from "../../api";
  import { navigate } from "../../router.svelte";
  import { AGENT_NAMES } from "../../registry.svelte";

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let loading = $state(false);
  let searched = $state(false);
  let failed = $state(false);

  const agentName = (id: string): string => AGENT_NAMES[id] ?? id;

  // Debounce + nonce: a slow earlier response must never overwrite a newer one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nonce = 0;

  async function run(term: string): Promise<void> {
    const q = term.trim();
    if (!q) {
      results = [];
      searched = false;
      failed = false;
      loading = false;
      return;
    }
    const my = ++nonce;
    loading = true;
    try {
      const res = await searchContent(q);
      if (my !== nonce) return; // superseded
      results = res.results;
      failed = Boolean(res.error);
    } catch {
      if (my !== nonce) return;
      results = [];
      failed = true;
    } finally {
      if (my === nonce) {
        loading = false;
        searched = true;
      }
    }
  }

  function onInput(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void run(query), 180);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      clearTimeout(timer);
      void run(query);
    }
  }

  function open(id: string): void {
    navigate("/session/" + id);
  }
</script>

<Card title="Content search" kicker="full-text · all sessions" icon="search">
  <div class="search-box">
    <Icon name="search" size={15} />
    <input
      type="search"
      bind:value={query}
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="search transcript content…"
      aria-label="search transcript content"
      autocomplete="off"
      spellcheck="false"
    />
  </div>

  {#if loading}
    <p class="status">Searching…</p>
  {:else if searched && results.length === 0}
    <EmptyState
      icon="search"
      title="No matches"
      message={failed
        ? "That query couldn't be parsed — try simpler terms."
        : `No session content matches “${query.trim()}”.`}
      error={failed}
    />
  {:else if results.length > 0}
    <ul class="results">
      {#each results as r (r.session_id)}
        <li>
          <button type="button" class="result" onclick={() => open(r.session_id)}>
            <div class="meta">
              <Badge>{agentName(r.agent)}</Badge>
              <span class="title">{r.title ?? r.cwd ?? r.session_id}</span>
            </div>
            <p class="snippet">{r.snippet}</p>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<style>
  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-dim);
    margin-bottom: 12px;
  }
  .search-box input {
    flex: 1;
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .result {
    width: 100%;
    text-align: left;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    padding: 10px 12px;
    cursor: pointer;
    color: inherit;
  }
  .result:hover {
    border-color: color-mix(in srgb, var(--accent-from) 45%, var(--border));
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .title {
    font-size: 12.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .snippet {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-dim);
    line-height: 1.5;
  }
  .status {
    font-size: 12px;
    color: var(--text-subtle);
    padding: 4px 2px;
  }
</style>
