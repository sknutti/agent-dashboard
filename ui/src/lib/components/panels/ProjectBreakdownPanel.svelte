<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { MetricBar } from "../ui";
  import { getProjectBreakdown } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, pct, projectName, homeDir } from "../../format";

  const res = resource(() => `by-project:${ui.range}`, () => getProjectBreakdown(ui.range));
  const projects = $derived(res.data?.projects ?? []);
</script>

<Card title="Project breakdown" icon="box" kicker="by working directory — effective tokens">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !projects.length}
    <EmptyState icon="box" title="No project activity in range" message="Sessions rolled up by cwd: effective tokens, sessions, tool calls. The home dir collapses to ~ — never a hardcoded username." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="tbl">
      <div class="row head">
        <span class="c-proj">project</span>
        <span class="c-n">sess</span>
        <span class="c-n">tools</span>
        <span class="c-num">eff tok</span>
        <span class="c-share">share</span>
      </div>
      <div class="scroll">
        {#each projects as p (p.cwd)}
          <div class="row">
            <span class="c-proj" title={homeDir(p.cwd)}>{projectName(p.cwd)}</span>
            <span class="c-n mono">{compact(p.sessions)}</span>
            <span class="c-n mono u-subtle">{compact(p.tools)}</span>
            <span class="c-num mono">{compact(p.eff)}</span>
            <span class="c-share">
              <span class="barwrap"><MetricBar value={p.share} color="var(--cyan)" ariaLabel={`${pct(p.share, 0)} share`} /></span>
              <span class="pctv mono u-subtle">{pct(p.share, 0)}</span>
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Card>

<style>
  .tbl { font-size: 12px; }
  .scroll { max-height: 300px; overflow-y: auto; }
  .row {
    display: grid;
    grid-template-columns: 1fr 44px 48px 64px 92px;
    gap: 8px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  .row.head {
    position: sticky;
    top: 0;
    background: var(--surface);
    color: var(--text-subtle);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .c-proj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .c-n, .c-num { text-align: right; }
  .c-share { display: flex; align-items: center; gap: 6px; }
  .barwrap { flex: 1; min-width: 0; }
  .pctv { width: 30px; text-align: right; }
</style>
