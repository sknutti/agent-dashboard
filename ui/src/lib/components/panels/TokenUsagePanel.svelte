<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState, Select } from "../ui";
  import { getTokenUsage } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { compact, shortDate, pct} from "../../format";
  import { AGENT_NAMES, agentFilterOptions, agentIds } from "../../registry.svelte";

  // Per-agent dimension the API already returns (was collapsed to all-agents).
  const AGENTS = $derived(agentFilterOptions());
  const agentOpts = $derived(
    AGENTS.map((a) => ({ value: a, label: a === "all" ? "All agents" : AGENT_NAMES[a] ?? a })),
  );
  let agent = $state("all");
  const res = resource(
    () => `tokens:${ui.range}:${agent}`,
    () => getTokenUsage(ui.range, agent === "all" ? undefined : agent),
  );

  // Roll the per-(date,model) rows up to per-day stacks. Segments are EFFECTIVE
  // tokens only — cache-read is excluded (it's ~95% of raw and would crush the
  // rest; it lives in CachePanel). Order matches the luminance ramp (ADR-0004):
  // output (lightest) → cache-write (darkest).
  const SEGS = [
    { key: "output", label: "output", color: "var(--tok-output)" },
    { key: "input", label: "input", color: "var(--tok-input)" },
    { key: "reasoning", label: "reasoning", color: "var(--tok-reasoning)" },
    { key: "cacheCreate", label: "cache write", color: "var(--tok-cache-write)" },
  ] as const;

  // Agent palette — Okabe-Ito (CVD-safe). Agents are NOMINAL, so distinct hues,
  // not a luminance ramp (ADR-0004's nominal rule), and visually distinct from the
  // token ramp so the two breakdown modes don't blur. Assigned by registry order.
  const AGENT_PALETTE = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00"];

  // Breakdown dimension: token CATEGORY (the spend mix) or AGENT (who used it).
  // A stacked bar holds one categorical dimension; this flips which one. The
  // per-day total stays effective tokens either way.
  let mode = $state<"category" | "agent">("category");

  // Legend ↔ segment highlight (brushing & linking). Hover/focus a legend entry
  // to isolate it across every bar — the non-colour disambiguator the luminance
  // ramp leans on, and in agent mode the way to trace one agent's daily use.
  // Keyboard-focusable so the CVD affordance is reachable.
  let hl = $state<string | null>(null);

  // Concrete shape (not Record<string, number>) so property access is `number`,
  // not `number | undefined` under noUncheckedIndexedAccess.
  type TokenMix = { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number };

  const days = $derived.by(() => {
    const rows = res.data?.rows ?? [];
    const m = new Map<string, { v: TokenMix; byAgent: Map<string, number> }>();
    for (const r of rows) {
      const e = m.get(r.date) ?? { v: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, byAgent: new Map<string, number>() };
      e.v.input += r.input; e.v.output += r.output; e.v.cacheRead += r.cacheRead;
      e.v.cacheCreate += r.cacheCreate; e.v.reasoning += r.reasoning;
      // Per-agent effective tokens (excludes cache-read), for the agent breakdown.
      const eff = r.input + r.output + r.reasoning + r.cacheCreate;
      e.byAgent.set(r.agent, (e.byAgent.get(r.agent) ?? 0) + eff);
      m.set(r.date, e);
    }
    return [...m.entries()].map(([date, e]) => ({
      date,
      // effective tokens — excludes cache-read
      total: e.v.input + e.v.output + e.v.cacheCreate + e.v.reasoning,
      v: e.v,
      byAgent: e.byAgent,
    }));
  });

  // Agents present in the data, in registry order (stable colours), with any
  // data-only ids appended — agent-generic, no hardcoded id list (review #17).
  const agentsPresent = $derived.by(() => {
    const set = new Set((res.data?.rows ?? []).map((r) => r.agent));
    const ordered = agentIds().filter((id) => set.has(id));
    for (const id of set) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
  });
  const agentSegs = $derived(
    agentsPresent.map((id, i) => ({
      key: id,
      label: AGENT_NAMES[id] ?? id,
      color: AGENT_PALETTE[i % AGENT_PALETTE.length]!,
    })),
  );
  // Active segment set + a per-day value accessor for the chosen breakdown.
  const segs = $derived<{ key: string; label: string; color: string }[]>(
    mode === "agent" ? agentSegs : SEGS.map((s) => ({ key: s.key, label: s.label, color: s.color })),
  );
  function segVal(d: (typeof days)[number], key: string): number {
    return mode === "agent" ? (d.byAgent.get(key) ?? 0) : (d.v as unknown as Record<string, number>)[key]!;
  }
  function setMode(m: "category" | "agent") {
    mode = m;
    hl = null; // keys differ across modes; clear any stale highlight
  }
  // "Nice" axis ticks (0, 1, 2, 2.5, 5 × 10ⁿ) so the gridline labels are round
  // numbers. The bars are scaled to axisMax (the top tick), not the raw data max,
  // so a bar that reaches a gridline genuinely represents that value.
  function niceTicks(maxVal: number, count = 4): number[] {
    if (maxVal <= 0) return [0, 1];
    const rawStep = maxVal / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const ticks = [0];
    for (let t = step; ; t += step) {
      ticks.push(t);
      if (t >= maxVal) break; // top tick ≥ maxVal
    }
    return ticks;
  }
  const dataMax = $derived(Math.max(1, ...days.map((d) => d.total)));
  const ticks = $derived(niceTicks(dataMax));
  const axisMax = $derived(Math.max(1, ...ticks));
  const totals = $derived(res.data?.totals);
  const grandTotal = $derived(
    totals ? totals.input + totals.output + totals.cacheCreate + totals.reasoning : 0,
  );
</script>

<Card title="Token usage" icon="cpu" kicker="effective · stacked daily · {ui.range}">
  {#snippet actions()}
    <div class="modetog" role="group" aria-label="Break down by">
      <!-- ds-allow-native: segmented breakdown toggle (structural 2-state switch, not a form control). -->
      <button type="button" class:on={mode === "category"} onclick={() => setMode("category")}>category</button>
      <!-- ds-allow-native: segmented breakdown toggle (structural 2-state switch, not a form control). -->
      <button type="button" class:on={mode === "agent"} onclick={() => setMode("agent")}>agent</button>
    </div>
    <Select bind:value={agent} options={agentOpts} size="sm" ariaLabel="Agent" />
  {/snippet}
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !days.length}
    <EmptyState icon="cpu" title="No token data in range" message="Token usage appears here once a sync lands for this range." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="totals">
      <span class="grand mono">{compact(grandTotal)}</span>
      <span class="sub">effective tokens · {ui.range}</span>
    </div>
    <p class="caption">Effective = input + output + reasoning + cache-write. Cache-read is excluded — see the Cache panel.</p>
    <div class="chart-wrap">
    <div class="plot" role="img" aria-label="Daily effective token usage (excludes cache read) stacked by {mode === 'agent' ? 'agent' : 'category'}, max {compact(axisMax)} tokens per day">
      <div class="yaxis" aria-hidden="true">
        {#each ticks as t (t)}
          <span class="ytick" style="bottom:{(t / axisMax) * 100}%">{compact(t)}</span>
        {/each}
      </div>
      <div class="bars">
        {#each ticks as t (t)}
          <span class="gridline" class:base={t === 0} style="bottom:{(t / axisMax) * 100}%"></span>
        {/each}
        {#each days as d (d.date)}
          {@const title = `${shortDate(d.date)} — ${compact(d.total)} effective\n` + segs.filter((s) => segVal(d, s.key) > 0).map((s) => `${s.label}: ${compact(segVal(d, s.key))} (${pct(segVal(d, s.key) / (d.total || 1), 0)})`).join("\n")}
          <div class="col" {title}>
            <div class="bar" style="height:{(d.total / axisMax) * 100}%">
              {#each segs as s (s.key)}
                {#if segVal(d, s.key) > 0}
                  <span class="seg" class:dim={hl !== null && hl !== s.key} style="flex:{segVal(d, s.key)};background:{s.color}"></span>
                {/if}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
    <div class="xlabels">
      {#each days as d (d.date)}
        <span class="xlabel">{shortDate(d.date)}</span>
      {/each}
    </div>
    </div>
    <div class="legend">
      {#each segs as s (s.key)}
        <!-- ds-allow-native: legend entry is a structural brushing/highlight control (focusable), not a form action. -->
        <button
          type="button"
          class="leg"
          class:active={hl === s.key}
          class:dim={hl !== null && hl !== s.key}
          onmouseenter={() => (hl = s.key)}
          onmouseleave={() => (hl = null)}
          onfocus={() => (hl = s.key)}
          onblur={() => (hl = null)}
        ><span class="dot" style="background:{s.color}"></span>{s.label}</button>
      {/each}
    </div>
  {/if}
</Card>

<style>
  /* Segmented breakdown toggle (category | agent). */
  .modetog {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .modetog button {
    font-size: 11px;
    padding: 3px 9px;
    color: var(--text-subtle);
    background: var(--surface-2);
    transition: background 0.15s var(--ease), color 0.15s var(--ease);
  }
  .modetog button + button { border-left: 1px solid var(--border); }
  .modetog button:hover { color: var(--text-dim); }
  .modetog button.on { background: var(--surface); color: var(--text); }
  .totals { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .grand { font-size: 24px; font-weight: 600; color: var(--text); }
  .sub { font-size: 11.5px; color: var(--text-subtle); }
  .caption { margin: 0 0 14px; font-size: 10.5px; line-height: 1.5; color: var(--text-subtle); }
  /* Plot = fixed-width y-axis gutter + the bars area; both share the same height
     so percentage-positioned ticks/gridlines line up with the bar tops. The
     y-axis width is shared with .xlabels' padding so labels sit under the bars. */
  .chart-wrap {
    --yaxis-w: 42px;
    --chart-h: 130px;
  }
  .plot {
    display: flex;
    align-items: stretch;
    height: var(--chart-h);
  }
  .yaxis {
    position: relative;
    width: var(--yaxis-w);
    flex: none;
  }
  .ytick {
    position: absolute;
    right: 8px;
    transform: translateY(50%);
    font-size: 9px;
    line-height: 1;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .bars {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }
  .gridline {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    pointer-events: none;
  }
  .gridline.base {
    border-top-style: solid;
    border-top-color: var(--border);
  }
  .col {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    min-width: 0;
  }
  .bar {
    width: 100%;
    max-width: 26px;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 3px 3px 0 0;
    overflow: hidden;
    min-height: 2px;
    transition: height 0.3s var(--ease);
  }
  .seg { width: 100%; transition: opacity 0.15s var(--ease); }
  /* Brushing: dim the non-highlighted categories so the focused one pops. */
  .seg.dim { opacity: 0.22; }
  .xlabels {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    padding-left: var(--yaxis-w);
  }
  .xlabel {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-size: 9px;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 14px;
  }
  /* Legend entries are buttons (keyboard-focusable highlight control). The
     app-wide button reset already strips chrome; we add the interactive states. */
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--text-dim);
    cursor: pointer;
    border-radius: 5px;
    padding: 2px 5px;
    transition: opacity 0.15s var(--ease), background 0.15s var(--ease);
  }
  .leg:hover, .leg.active { background: var(--surface-2); color: var(--text); }
  .leg.dim { opacity: 0.45; }
  .dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
</style>
