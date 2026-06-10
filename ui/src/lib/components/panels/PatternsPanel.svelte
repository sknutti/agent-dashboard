<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getPatterns } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact, shortDate, AGENT_NAMES } from "../../format";

  // Per-agent dimension the API already returns (was collapsed to all-agents).
  const AGENTS = ["all", "claude_code", "codex", "pi", "antigravity"];
  let agent = $state("all");
  // Heatmap window is fixed at 30 days (independent of the global range toggle).
  const res = resource(
    () => `patterns:${agent}`,
    () => getPatterns(agent === "all" ? undefined : agent),
  );
  const data = $derived(res.data);

  /** Local YYYY-MM-DD (matches the server's DATE(...,'localtime') buckets). */
  function localISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function daysAgo(n: number): Date {
    const d = new Date();
    d.setHours(12, 0, 0, 0); // noon avoids DST edge flips
    d.setDate(d.getDate() - n);
    return d;
  }

  // ── 30-day heatmap grid (GitHub-style: weekday rows, week columns) ─────────
  interface Cell { date: string; sessions: number; tokens: number; placeholder?: boolean }
  const heat = $derived.by((): Cell[] => {
    const map = new Map((data?.days ?? []).map((d) => [d.date, d]));
    const cells: Cell[] = [];
    for (let i = 29; i >= 0; i--) {
      const date = localISO(daysAgo(i));
      const hit = map.get(date);
      cells.push({ date, sessions: hit?.sessions ?? 0, tokens: hit?.tokens ?? 0 });
    }
    const firstWeekday = new Date(cells[0]!.date + "T12:00:00").getDay(); // 0=Sun
    const pad: Cell[] = Array.from({ length: firstWeekday }, () => ({ date: "", sessions: 0, tokens: 0, placeholder: true }));
    return [...pad, ...cells];
  });
  const maxSessions = $derived(data?.maxSessions ?? 0);
  function level(s: number): number {
    if (s <= 0 || maxSessions <= 0) return 0;
    return Math.min(4, Math.ceil((s / maxSessions) * 4));
  }

  // ── 14-day token charts stacked by model (top 4 + other) ──────────────────
  const COLORS = ["var(--cyan)", "var(--amber)", "#7c8aa5", "#a8b3c7", "#576074"];
  interface Seg { model: string; tokens: number; color: string }
  const chart = $derived.by(() => {
    const series = data?.tokenSeries ?? [];
    const totals = new Map<string, number>();
    for (const r of series) totals.set(r.model, (totals.get(r.model) ?? 0) + r.tokens);
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((m) => m[0]);
    const colorOf = (m: string) => COLORS[top.indexOf(m)] ?? COLORS[4]!;
    const byDate = new Map<string, Map<string, number>>();
    for (const r of series) {
      const key = top.includes(r.model) ? r.model : "other";
      const dm = byDate.get(r.date) ?? new Map<string, number>();
      dm.set(key, (dm.get(key) ?? 0) + r.tokens);
      byDate.set(r.date, dm);
    }
    const days: { date: string; total: number; segs: Seg[] }[] = [];
    for (let i = 13; i >= 0; i--) {
      const date = localISO(daysAgo(i));
      const dm = byDate.get(date) ?? new Map<string, number>();
      const segs: Seg[] = [...dm.entries()]
        .map(([model, tokens]) => ({ model, tokens, color: model === "other" ? COLORS[4]! : colorOf(model) }))
        .sort((a, b) => b.tokens - a.tokens);
      days.push({ date, total: [...dm.values()].reduce((a, b) => a + b, 0), segs });
    }
    const maxTotal = Math.max(1, ...days.map((d) => d.total));
    const legend = [...top.map((m) => ({ model: m, color: colorOf(m) })), { model: "other", color: COLORS[4]! }];
    return { days, maxTotal, legend, hasData: series.length > 0 };
  });

  const totalSessions = $derived((data?.days ?? []).reduce((a, d) => a + d.sessions, 0));
  const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];
</script>

<Card title="Patterns" icon="activity" kicker="30-day activity · 14-day token mix">
  {#snippet actions()}
    <select class="sel" bind:value={agent} aria-label="Agent">
      {#each AGENTS as a (a)}
        <option value={a}>{a === "all" ? "All agents" : AGENT_NAMES[a] ?? a}</option>
      {/each}
    </select>
  {/snippet}
  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !data || totalSessions === 0}
    <EmptyState icon="activity" title="No activity in the last 30 days" message="A GitHub-style heatmap lights up per day as sessions accrue, with a 14-day token-mix strip below." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="hsec">
      <div class="hlabel">
        <span class="sub">sessions · last 30 days</span>
        <span class="sub dim">{compact(totalSessions)} total · peak {compact(maxSessions)}/day</span>
      </div>
      <div class="hwrap">
        <div class="wdays">
          {#each WEEKDAYS as w, i (i)}<span class="wd">{w}</span>{/each}
        </div>
        <div class="grid">
          {#each heat as c, i (i)}
            {#if c.placeholder}
              <span class="cell ph"></span>
            {:else}
              <span class="cell lv{level(c.sessions)}" title="{shortDate(c.date)} · {c.sessions} session{c.sessions === 1 ? '' : 's'} · {compact(c.tokens)} tok"></span>
            {/if}
          {/each}
        </div>
      </div>
      <div class="scale">
        <span class="sub dim">less</span>
        {#each [0, 1, 2, 3, 4] as l (l)}<span class="cell lv{l}"></span>{/each}
        <span class="sub dim">more</span>
      </div>
    </div>

    <div class="csec">
      <div class="hlabel">
        <span class="sub">tokens · last 14 days · by model</span>
      </div>
      {#if chart.hasData}
        <div class="bars">
          {#each chart.days as d (d.date)}
            <div class="barcol" title="{shortDate(d.date)} · {compact(d.total)} tok">
              <div class="bar">
                {#each d.segs as s (s.model)}
                  <span class="seg" style="height:{((s.tokens / chart.maxTotal) * 100).toFixed(1)}%; background:{s.color}"></span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
        <div class="legend">
          {#each chart.legend as l (l.model)}
            <span class="lg"><span class="sw" style="background:{l.color}"></span>{l.model}</span>
          {/each}
        </div>
      {:else}
        <p class="muted">No token-usage rows in the last 14 days.</p>
      {/if}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .sel { font-size: 11px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); }
  .sub { font-size: 11.5px; color: var(--text-dim); }
  .dim { color: var(--text-subtle); }
  .hsec { margin-bottom: 18px; }
  .hlabel { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .hwrap { display: flex; gap: 6px; }
  .wdays { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; }
  .wd { font-size: 9px; color: var(--text-subtle); height: 13px; line-height: 13px; }
  .grid {
    display: grid;
    grid-template-rows: repeat(7, 1fr);
    grid-auto-flow: column;
    grid-auto-columns: 13px;
    gap: 3px;
  }
  .cell { width: 13px; height: 13px; border-radius: 3px; background: var(--surface-2); }
  .cell.ph { background: transparent; }
  /* cyan intensity ramp — colourblind-safe (no red/green) */
  .cell.lv0 { background: var(--surface-2); }
  .cell.lv1 { background: rgba(34, 211, 238, 0.25); }
  .cell.lv2 { background: rgba(34, 211, 238, 0.45); }
  .cell.lv3 { background: rgba(34, 211, 238, 0.7); }
  .cell.lv4 { background: var(--cyan); }
  .scale { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
  .scale .cell { width: 11px; height: 11px; }
  .csec { border-top: 1px solid var(--border); padding-top: 14px; }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 90px; }
  .barcol { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .bar { width: 100%; height: 100%; display: flex; flex-direction: column-reverse; justify-content: flex-start; border-radius: 3px 3px 0 0; overflow: hidden; background: var(--surface-2); }
  .seg { display: block; width: 100%; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .lg { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
  .sw { width: 9px; height: 9px; border-radius: 2px; }
</style>
