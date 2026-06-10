<script lang="ts">
  import Sheet from "../ui/Sheet.svelte";
  import Badge from "../ui/Badge.svelte";
  import Icon from "../ui/Icon.svelte";
  import { drill, closeDrill, ui } from "../../stores.svelte";
  import { getSessions, getSessionDetail, type SessionRow, type SessionDetail } from "../../api";
  import { navigate } from "../../router.svelte";
  import { resource } from "../../resource.svelte";
  import { compact, usd, ms, relTime, projectName } from "../../format";

  // Read-only drill-down (ADR-0003). List of filtered sessions → one session's
  // detail (tool timeline + token breakdown). Acting on findings is Phase 6.
  let selected = $state<string | null>(null);
  let detail = $state<SessionDetail | null>(null);
  let detailLoading = $state(false);

  // The drill list honours the GLOBAL range toggle (was hardcoded "30d", so cell
  // counts computed at the page range disagreed with the sheet's contents).
  const listRes = resource(
    () => `drill:${drill.open}:${ui.range}:${drill.ctx?.agent ?? ""}:${drill.ctx?.outcome ?? ""}`,
    async () => {
      if (!drill.open) return { total: 0, limit: 0, offset: 0, sessions: [] as SessionRow[] };
      return getSessions({ range: ui.range, agent: drill.ctx?.agent, outcome: drill.ctx?.outcome, limit: 100 });
    },
  );

  async function openDetail(id: string) {
    selected = id;
    detail = null;
    detailLoading = true;
    try {
      detail = await getSessionDetail(id);
    } catch {
      detail = null;
    } finally {
      detailLoading = false;
    }
  }
  function back() {
    selected = null;
    detail = null;
  }
  function onClose() {
    back();
    closeDrill();
  }

  const OUTCOME_TONE: Record<string, "red" | "amber" | "green" | "default"> = {
    errored: "red", rate_limited: "amber", truncated: "amber", unfinished: "default", ok: "green",
  };
</script>

<Sheet open={drill.open} title={drill.ctx?.title ?? "Detail"} subtitle={drill.ctx?.subtitle} width={520} {onClose}>
  {#if drill.ctx?.query}<p class="query mono">{drill.ctx.query}</p>{/if}

  {#if selected}
    <!-- ── Session detail ── -->
    <button class="back" onclick={back}><Icon name="chevron-right" size={13} /> back to list</button>
    {#if detailLoading}
      <div class="muted">Loading session…</div>
    {:else if !detail}
      <div class="muted">Could not load this session.</div>
    {:else}
      {@const s = detail.session}
      <div class="dhead">
        <h4>{s.title ?? `session:${s.session_id.slice(0, 8)}`}</h4>
        <div class="dmeta">
          <Badge tone={OUTCOME_TONE[s.outcome] ?? "default"}>{s.outcome}</Badge>
          {#if s.model}<span class="mono dim">{s.model}</span>{/if}
          <span class="dim">{projectName(s.cwd)}</span>
          {#if s.branch_count != null && s.branch_count > 1}<span class="dim">· {s.branch_count} branches</span>{/if}
        </div>
      </div>
      <div class="tokgrid">
        <div class="tk"><span class="tk-v mono">{compact(s.input_tokens)}</span><span class="tk-l">input</span></div>
        <div class="tk"><span class="tk-v mono">{compact(s.output_tokens)}</span><span class="tk-l">output</span></div>
        <div class="tk"><span class="tk-v mono">{compact(s.cache_read_tokens)}</span><span class="tk-l">cache read</span></div>
        <div class="tk"><span class="tk-v mono">{compact(s.cache_create_tokens)}</span><span class="tk-l">cache write</span></div>
      </div>
      <div class="costline">
        <span class="mono est">{usd(s.cost_estimated_usd)} <span class="tag">est</span></span>
        {#if s.cost_usd != null}<span class="mono nat">{usd(s.cost_usd)} <span class="tag">native</span></span>{/if}
      </div>
      <p class="tl-title">Tool timeline · {detail.tools.length}</p>
      <div class="timeline">
        {#each detail.tools as t (t.ts + (t.tool_use_id ?? ''))}
          <div class="tl-row" class:err={t.error != null}>
            <span class="tl-name">{#if t.error != null}<span class="xmark" title={t.error}>✗</span> {/if}{t.tool_name}</span>
            <span class="tl-dur mono">{ms(t.duration_ms)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <!-- ── Filtered session list ── -->
    {#if listRes.loading && !listRes.data}
      <div class="muted">Loading…</div>
    {:else if !listRes.data?.sessions.length}
      <div class="muted">No matching sessions.</div>
    {:else}
      <p class="count">{listRes.data.total} session{listRes.data.total === 1 ? "" : "s"} · range {ui.range}</p>
      <div class="list">
        {#each listRes.data.sessions as s (s.session_id)}
          <button class="srow" onclick={() => openDetail(s.session_id)}>
            <div class="s-main">
              <span class="s-title">{s.title ?? `session:${s.session_id.slice(0, 8)}`}</span>
              <span class="s-sub mono">{projectName(s.cwd)} · {relTime(s.started_at)}</span>
            </div>
            <div class="s-right">
              <Badge tone={OUTCOME_TONE[s.outcome] ?? "default"}>{s.outcome}</Badge>
              <span class="s-tok mono">{compact(s.total_tokens)}</span>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</Sheet>

<style>
  .query { margin: 0 0 16px; font-size: 11px; color: var(--text-subtle); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; overflow-x: auto; }
  .muted { color: var(--text-subtle); font-size: 13px; }
  .count { margin: 0 0 12px; font-size: 11.5px; color: var(--text-subtle); }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .srow {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); text-align: left; transition: all 0.15s var(--ease);
  }
  .srow:hover { border-color: var(--border-glow); }
  .s-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .s-title { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-sub { font-size: 10.5px; color: var(--text-subtle); }
  .s-right { display: flex; align-items: center; gap: 9px; flex: none; }
  .s-tok { font-size: 12px; color: var(--text-dim); }
  .back { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-subtle); margin-bottom: 14px; }
  .back :global(svg) { transform: rotate(180deg); }
  .back:hover { color: var(--text-dim); }
  .dhead h4 { margin: 0 0 7px; font-size: 15px; font-weight: 600; }
  .dmeta { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 11.5px; margin-bottom: 16px; }
  .dim { color: var(--text-subtle); }
  .tokgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .tk { display: flex; flex-direction: column; gap: 3px; padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .tk-v { font-size: 14px; font-weight: 600; color: var(--text); }
  .tk-l { font-size: 9.5px; color: var(--text-subtle); }
  .costline { display: flex; gap: 16px; margin-bottom: 18px; }
  .est { color: var(--amber); display: inline-flex; gap: 5px; align-items: baseline; }
  .nat { color: var(--cyan); display: inline-flex; gap: 5px; align-items: baseline; }
  .tag { font-family: var(--font-sans); font-size: 9.5px; color: var(--text-subtle); }
  .tl-title { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-subtle); }
  .timeline { display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; }
  .tl-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 2px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .tl-row.err .tl-name { color: var(--red); }
  /* Explicit ✗ glyph so an errored row is not signalled by red text alone
     (red/green CVD) — mirrors FailuresPanel. */
  .xmark { color: var(--red); font-weight: 700; }
  .tl-name { color: var(--text-dim); }
  .tl-dur { color: var(--text-subtle); }
</style>
