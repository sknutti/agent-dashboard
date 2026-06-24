<script lang="ts">
  // Full-text search over session TRANSCRIPT CONTENT (FTS5) — distinct from the
  // metadata `q` box on the Sessions table (title/cwd only). Filters (agent /
  // outcome / shared range) and pagination mirror SessionsTablePanel. Fetching uses
  // resource() — the repo's sanctioned external-sync wrapper (no raw $effect) — so
  // the panel tracks the Activity RangeToggle (ui.range) reactively. The query is
  // debounced (qInput → qApplied) so we don't refetch on every keystroke; a blank
  // query short-circuits to an empty result WITHOUT hitting the API.
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Badge, Button, Input } from "../ui";
  import Icon from "../ui/Icon.svelte";
  import { searchContent, type SearchResponse } from "../../api";
  import { navigate } from "../../router.svelte";
  import { AGENT_NAMES, agentFilterOptions } from "../../registry.svelte";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { splitSnippet, compact } from "../../format";

  const LIMIT = 25;
  let qInput = $state("");
  let qApplied = $state("");
  let agent = $state("all");
  let outcome = $state("all");
  let offset = $state(0);

  let timer: ReturnType<typeof setTimeout> | null = null;
  function onSearch(v: string) {
    qInput = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      qApplied = v.trim();
      offset = 0; // a new query restarts paging
    }, 200);
  }

  const EMPTY: SearchResponse = { q: "", total: 0, limit: LIMIT, offset: 0, results: [] };
  const res = resource(
    () => `search:${ui.range}:${agent}:${outcome}:${qApplied}:${offset}`,
    () =>
      qApplied
        ? searchContent({
            q: qApplied,
            agent: agent === "all" ? undefined : agent,
            outcome: outcome === "all" ? undefined : outcome,
            range: ui.range,
            limit: LIMIT,
            offset,
          })
        : Promise.resolve(EMPTY), // blank query: don't touch the API
  );

  const results = $derived(res.data?.results ?? []);
  const total = $derived(res.data?.total ?? 0);
  const failed = $derived(Boolean(res.data?.error) || res.error);
  const hasQuery = $derived(qApplied.length > 0);
  const showingFrom = $derived(total === 0 ? 0 : offset + 1);
  const showingTo = $derived(Math.min(offset + LIMIT, total));

  const AGENTS = $derived(agentFilterOptions()); // ["all", …ids] from the registry
  const OUTCOMES = ["all", "ok", "errored", "rate_limited", "truncated", "unfinished"];
  const OUT_LABEL: Record<string, string> = { rate_limited: "rate-limited", all: "all" };

  const agentName = (id: string): string => AGENT_NAMES[id] ?? id;
  function open(id: string): void {
    navigate("/session/" + id);
  }
</script>

<Card title="Content search" kicker="full-text · all sessions" icon="search">
  {#snippet actions()}
    <label class="search">
      <Icon name="search" size={13} />
      <Input
        type="search"
        class="search-field"
        placeholder="search transcript content…"
        ariaLabel="search transcript content"
        value={qInput}
        oninput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
      />
    </label>
  {/snippet}

  <div class="filters">
    <div class="chips">
      {#each AGENTS as a (a)}
        <!-- ds-allow-native: toggle-pill in a custom filter chip group, not a form-control button -->
        <button class="chip" class:on={agent === a} onclick={() => { agent = a; offset = 0; }}>
          {a === "all" ? "all agents" : agentName(a)}
        </button>
      {/each}
    </div>
    <div class="chips">
      {#each OUTCOMES as o (o)}
        <!-- ds-allow-native: toggle-pill in a custom filter chip group, not a form-control button -->
        <button class="chip" class:on={outcome === o} onclick={() => { outcome = o; offset = 0; }}>
          {OUT_LABEL[o] ?? o}
        </button>
      {/each}
    </div>
  </div>

  {#if res.loading && !res.data}
    <p class="status">Searching…</p>
  {:else if !hasQuery}
    <p class="status">Type to search across every session's transcript.</p>
  {:else if results.length === 0}
    <EmptyState
      icon="search"
      title="No matches"
      message={failed
        ? "That query couldn't be parsed — try simpler terms."
        : `No session content matches “${qApplied}”.`}
      error={failed}
    />
  {:else}
    <ul class="results">
      {#each results as r (r.session_id)}
        <li>
          <!-- ds-allow-native: clickable result row (whole card opens the session), not a form-control button -->
          <button type="button" class="result" onclick={() => open(r.session_id)}>
            <div class="meta">
              <Badge>{agentName(r.agent)}</Badge>
              <span class="title">{r.title ?? r.cwd ?? r.session_id}</span>
            </div>
            <p class="snippet">{#each splitSnippet(r.snippet) as seg}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</p>
          </button>
        </li>
      {/each}
    </ul>
    <div class="pager">
      <span class="pinfo">{showingFrom}–{showingTo} of {compact(total)}</span>
      <div class="pbtns">
        <Button size="sm" disabled={offset === 0} onclick={() => (offset = Math.max(0, offset - LIMIT))}>Prev</Button>
        <Button size="sm" disabled={offset + LIMIT >= total} onclick={() => (offset += LIMIT)}>Next</Button>
      </div>
    </div>
  {/if}
</Card>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-subtle);
  }
  /* The Input primitive sits inside the icon wrapper, so strip its own chrome and
     let the wrapper provide the border/background (the search-affordance look). */
  .search :global(.search-field) {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    padding: 0;
    width: 170px;
  }
  .filters { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip {
    padding: 2px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s var(--ease);
  }
  .chip:hover { border-color: var(--border-glow); color: var(--text); }
  .chip.on { background: var(--surface-2); border-color: var(--cyan); color: var(--cyan); }
  .status {
    font-size: 12px;
    color: var(--text-subtle);
    padding: 4px 2px;
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
  /* Match highlight: cyan accent (not a red/green pairing) plus bold weight as a
     redundant non-color cue, per the colourblind rule. */
  .snippet :global(mark) {
    background: color-mix(in srgb, var(--cyan) 22%, transparent);
    color: var(--text);
    font-weight: 600;
    border-radius: 2px;
    padding: 0 1px;
  }
  .pager { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .pinfo { font-size: 11.5px; color: var(--text-subtle); }
  .pbtns { display: flex; gap: 6px; }
</style>
