<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Icon from "../ui/Icon.svelte";
  import { getSessions } from "../../api";
  import { navigate } from "../../router.svelte";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, relTime, projectName, usd, AGENT_NAMES } from "../../format";

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
      offset = 0;
    }, 250);
  }

  const res = resource(
    () => `sessions:${ui.range}:${agent}:${outcome}:${qApplied}:${offset}`,
    () =>
      getSessions({
        range: ui.range,
        agent: agent === "all" ? undefined : agent,
        outcome: outcome === "all" ? undefined : outcome,
        q: qApplied || undefined,
        limit: LIMIT,
        offset,
      }),
  );
  const rows = $derived(res.data?.sessions ?? []);
  const total = $derived(res.data?.total ?? 0);
  const showingFrom = $derived(total === 0 ? 0 : offset + 1);
  const showingTo = $derived(Math.min(offset + LIMIT, total));

  const AGENTS = ["all", "claude_code", "codex", "pi", "antigravity"];
  const OUTCOMES = ["all", "ok", "errored", "rate_limited", "truncated", "unfinished"];
  const OUT_LABEL: Record<string, string> = { rate_limited: "rate-limited", all: "all" };
</script>

<Card title="All sessions" icon="layers" kicker="searchable · filterable · every agent">
  {#snippet actions()}
    <label class="search">
      <Icon name="search" size={13} />
      <input
        type="text"
        placeholder="title or path…"
        value={qInput}
        oninput={(e) => onSearch(e.currentTarget.value)}
      />
    </label>
  {/snippet}

  <div class="filters">
    <div class="chips">
      {#each AGENTS as a (a)}
        <button class="chip" class:on={agent === a} onclick={() => { agent = a; offset = 0; }}>
          {a === "all" ? "all agents" : AGENT_NAMES[a] ?? a}
        </button>
      {/each}
    </div>
    <div class="chips">
      {#each OUTCOMES as o (o)}
        <button class="chip" class:on={outcome === o} onclick={() => { outcome = o; offset = 0; }}>
          {OUT_LABEL[o] ?? o}
        </button>
      {/each}
    </div>
  </div>

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !rows.length}
    <EmptyState icon="layers" title="No sessions match" message="Adjust the search text, agent, outcome, or range." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="tbl">
      <div class="row head">
        <span class="c-title">session</span>
        <span class="c-agent">agent</span>
        <span class="c-out">outcome</span>
        <span class="c-num">tokens</span>
        <span class="c-num">est $</span>
        <span class="c-when">when</span>
      </div>
      <div class="scroll">
        {#each rows as s (s.session_id)}
          <button class="row rowbtn" type="button" title="Open session" onclick={() => navigate(`/session/${encodeURIComponent(s.session_id)}`)}>
            <span class="c-title">
              <span class="t-main" title={s.title ?? s.session_id}>{s.title ?? `session:${s.session_id.slice(0, 8)}`}</span>
              <span class="t-sub dim" title={s.cwd ?? ""}>{projectName(s.cwd)}</span>
            </span>
            <span class="c-agent dim">{AGENT_NAMES[s.agent] ?? s.agent}</span>
            <span class="c-out"><span class="pill {s.outcome}">{s.outcome === "rate_limited" ? "rate-limited" : s.outcome}</span></span>
            <span class="c-num mono">{compact(s.total_tokens)}</span>
            <span class="c-num mono dim">{usd(s.cost_estimated_usd)}</span>
            <span class="c-when mono dim">{relTime(s.started_at)}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="pager">
      <span class="pinfo">{showingFrom}–{showingTo} of {compact(total)}</span>
      <div class="pbtns">
        <button class="pbtn" disabled={offset === 0} onclick={() => (offset = Math.max(0, offset - LIMIT))}>Prev</button>
        <button class="pbtn" disabled={offset + LIMIT >= total} onclick={() => (offset += LIMIT)}>Next</button>
      </div>
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
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
  .search input {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    outline: none;
    width: 150px;
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
  .tbl { font-size: 12px; }
  .scroll { max-height: 420px; overflow-y: auto; }
  .row {
    display: grid;
    grid-template-columns: 1fr 90px 84px 60px 56px 56px;
    gap: 8px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  /* Data rows are buttons that open the session detail page (the only other link
     to /session/:id was the live-session icon — a list you couldn't open). */
  .rowbtn {
    width: 100%;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rowbtn:hover { background: var(--surface-2); }
  .row.head {
    position: sticky;
    top: 0;
    background: var(--surface);
    color: var(--text-subtle);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .c-title { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .t-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .t-sub { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-agent { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-num, .c-when { text-align: right; }
  .pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    background: var(--surface-2);
    color: var(--text-dim);
  }
  .pill.errored { color: var(--red); }
  .pill.rate_limited, .pill.truncated { color: var(--amber); }
  .pill.ok { color: var(--cyan); }
  .pager { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .pinfo { font-size: 11.5px; color: var(--text-subtle); }
  .pbtns { display: flex; gap: 6px; }
  .pbtn {
    padding: 3px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
  }
  .pbtn:disabled { opacity: 0.4; cursor: default; }
  .pbtn:not(:disabled):hover { border-color: var(--cyan); color: var(--cyan); }
  .dim { color: var(--text-subtle); }
</style>
