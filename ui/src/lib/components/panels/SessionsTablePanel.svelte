<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Button, Input, Select } from "../ui";
  import Icon from "../ui/Icon.svelte";
  import { getSessions } from "../../api";
  import { navigate } from "../../router.svelte";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, relTime, projectName, usd} from "../../format";
  import { AGENT_NAMES, agentFilterOptions } from "../../registry.svelte";

  const LIMIT = 25;
  let qInput = $state("");
  let qApplied = $state("");
  let agent = $state("all");
  let outcome = $state("all");
  let model = $state("all");
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
    () => `sessions:${ui.range}:${agent}:${outcome}:${model}:${qApplied}:${offset}`,
    () =>
      getSessions({
        range: ui.range,
        agent: agent === "all" ? undefined : agent,
        outcome: outcome === "all" ? undefined : outcome,
        model: model === "all" ? undefined : model,
        q: qApplied || undefined,
        limit: LIMIT,
        offset,
      }),
  );
  const rows = $derived(res.data?.sessions ?? []);
  const total = $derived(res.data?.total ?? 0);
  const showingFrom = $derived(total === 0 ? 0 : offset + 1);
  const showingTo = $derived(Math.min(offset + LIMIT, total));

  // Model options derive from the loaded rows (the API supports ?model=); the
  // current selection is always kept so the dropdown never drops out from under
  // an active filter when the filtered result set narrows.
  const modelOpts = $derived([
    "all",
    ...new Set([
      ...(model !== "all" ? [model] : []),
      ...rows.map((r) => r.model).filter((m): m is string => !!m),
    ]),
  ]);

  const AGENTS = $derived(agentFilterOptions()); // ["all", …ids] from the registry
  const OUTCOMES = ["all", "ok", "errored", "rate_limited", "truncated", "unfinished"];
  const OUT_LABEL: Record<string, string> = { rate_limited: "rate-limited", all: "all" };
</script>

<Card title="All sessions" icon="layers" kicker="searchable · filterable · every agent">
  {#snippet actions()}
    <label class="search">
      <Icon name="search" size={13} />
      <Input
        class="search-field"
        placeholder="title or path…"
        ariaLabel="Search sessions by title or path"
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
          {a === "all" ? "all agents" : AGENT_NAMES[a] ?? a}
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
      {#if modelOpts.length > 1}
        <Select
          class="modelsel"
          bind:value={model}
          options={modelOpts.map((m) => ({ value: m, label: m === "all" ? "all models" : m }))}
          onchange={() => (offset = 0)}
          ariaLabel="Model"
        />
      {/if}
    </div>
  </div>

  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
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
          <!-- ds-allow-native: clickable table row opening the session detail page, not a form-control button -->
          <button class="row rowbtn" type="button" title="Open session" onclick={() => navigate(`/session/${encodeURIComponent(s.session_id)}`)}>
            <span class="c-title">
              <span class="t-main" title={s.title ?? s.session_id}>{s.title ?? `session:${s.session_id.slice(0, 8)}`}</span>
              <span class="t-sub u-subtle" title={s.cwd ?? ""}>{projectName(s.cwd)}</span>
            </span>
            <span class="c-agent u-subtle">{AGENT_NAMES[s.agent] ?? s.agent}</span>
            <span class="c-out">
              {#if s.outcome === "errored"}
                <!-- The errored pill is a shortcut to that session's Errors tab. It's
                     a span[role=button] (NOT a native button element) so it's valid
                     inside the row button; stopPropagation keeps the row's Messages
                     nav from firing too. ✗ pairs the red (colourblind rule). -->
                <span
                  class="pill errored pillbtn" role="button" tabindex="0"
                  aria-label="View parsed errors for this session"
                  title="View parsed errors"
                  onclick={(e) => { e.stopPropagation(); navigate(`/session/${encodeURIComponent(s.session_id)}`, "?tab=errors"); }}
                  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); navigate(`/session/${encodeURIComponent(s.session_id)}`, "?tab=errors"); } }}
                >errored <span class="xmark">✗</span></span>
              {:else}
                <span class="pill {s.outcome}">{s.outcome === "rate_limited" ? "rate-limited" : s.outcome}</span>
              {/if}
            </span>
            <span class="c-num mono">{compact(s.total_tokens)}</span>
            <span class="c-num mono u-subtle">{usd(s.cost_estimated_usd)}</span>
            <span class="c-when mono u-subtle">{relTime(s.started_at)}</span>
          </button>
        {/each}
      </div>
    </div>
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
  /* The Select primitive provides the dropdown chrome; round it into a pill so it
     reads as part of the chip filter row (it sits inline with the outcome chips). */
  .chips :global(.modelsel) {
    border-radius: 999px;
  }
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
  .pillbtn { cursor: pointer; }
  .pillbtn:hover { background: color-mix(in srgb, var(--red) 16%, var(--surface-2)); }
  .pillbtn:focus-visible { outline: 1px solid var(--red); outline-offset: 1px; }
  .xmark { font-weight: 700; }
  .pager { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .pinfo { font-size: 11.5px; color: var(--text-subtle); }
  .pbtns { display: flex; gap: 6px; }
</style>
