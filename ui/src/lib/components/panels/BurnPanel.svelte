<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import DayOutputStrip from "./DayOutputStrip.svelte";
  import { getBurn, getAgents, getBurnOutput, type AgentId } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact, usd, shortDate} from "../../format";
  import { AGENT_NAMES } from "../../registry.svelte";

  // Burn has its OWN range (30/90d) + agent selector (All / per-agent), master §11.
  let range = $state<"30d" | "90d">("30d");
  let agent = $state<"all" | AgentId>("all");
  const res = resource(
    () => `burn:${range}:${agent}`,
    () => getBurn(range, agent === "all" ? undefined : agent),
  );
  const d = $derived(res.data);

  // Per-agent filter is data-driven (agent-generic): list only agents with burn
  // data in this window, so each agent appears automatically as its adapter lands.
  const agents = resource(() => `burn-agents:${range}`, () => getAgents(range));
  const agentOpts = $derived(
    (agents.data?.agents ?? []).filter((a) => a.sessions > 0).map((a) => a.id),
  );

  // Build a Sunday-aligned week grid over the range window ending today.
  const cells = $derived.by(() => {
    const byDate = new Map((d?.daily ?? []).map((x) => [x.date, x]));
    const span = range === "90d" ? 90 : 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days: { date: string; tokens: number; est: number; native: number | null }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - i);
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const row = byDate.get(iso);
      days.push({ date: iso, tokens: row?.tokens ?? 0, est: row?.estUsd ?? 0, native: row?.nativeUsd ?? null });
    }
    // Pad the front to the week's Sunday so columns align by weekday.
    const firstDow = new Date(days[0]!.date + "T00:00").getDay();
    const padded: ((typeof days)[number] | null)[] = [...Array(firstDow).fill(null), ...days];
    const weeks: ((typeof days)[number] | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
    return weeks;
  });

  // Log color scale (master §11.1): per-day total tokens. Colourblind-safe
  // cividis-like blue→yellow ramp — luminance rises monotonically per step, so
  // heavier days read as brighter without relying on hue, and there is no
  // red/green pairing. Discrete buckets make adjacent levels easier to tell apart.
  // Normalise across the observed spread (min→max of populated days) so the full
  // ramp is used and day-to-day differences are visible — otherwise every day
  // pins to the top bucket, since the counts share a magnitude. Log scale §11.1.
  const logVals = $derived(
    (d?.daily ?? []).map((x) => x.tokens).filter((t) => t > 0).map((t) => Math.log1p(t)),
  );
  const logMin = $derived(logVals.length ? Math.min(...logVals) : 0);
  const logMax = $derived(logVals.length ? Math.max(...logVals) : 1);
  const RAMP = ["#12376c", "#3f5e8c", "#7c8385", "#bcab5e", "#ffe945"]; // low → high
  function cellColor(tokens: number): string {
    if (tokens <= 0) return "var(--surface-2)";
    const span = logMax - logMin;
    const t = span > 1e-9 ? (Math.log1p(tokens) - logMin) / span : 0.5; // 0..1 across spread
    return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]!;
  }

  const recent = $derived((d?.daily ?? []).slice(-10).reverse());

  // Git-derived OUTPUT for the whole window in ONE read (persisted rollup — no
  // per-day git fan-out). Joined to the recent rows by date so every day pairs its
  // est cost with what it produced. Estimated, hash-deduped, date-only/all-agents.
  const outRange = $derived(range); // getBurnOutput accepts 30d|90d like getBurn
  const out = resource(() => `burnout:${outRange}`, () => getBurnOutput(outRange));
  const outByDate = $derived(new Map((out.data?.days ?? []).map((r) => [r.date, r])));
</script>

<Card title="Burn" icon="gauge" kicker="fluent, or just expensive?">
  {#snippet actions()}
    <select class="sel" bind:value={agent} aria-label="Agent">
      <option value="all">All agents</option>
      {#each agentOpts as id (id)}
        <option value={id}>{AGENT_NAMES[id] ?? id}</option>
      {/each}
    </select>
    <select class="sel" bind:value={range} aria-label="Range">
      <option value="30d">30 days</option>
      <option value="90d">90 days</option>
    </select>
  {/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !d || !d.daily.length}
    <EmptyState icon="gauge" title="Nothing to burn yet" message="A bill tells you what happened — a burn view changes what you hand the computer tomorrow." error={res.error} onRetry={res.reload} />
  {:else}
    <p class="caption">Each box is one local day. Color is log-scaled per-day token spend — brighter (yellow) is heavier, deep blue is lighter.</p>
    <div class="legend" aria-hidden="true">
      <span class="lg-lbl">lighter</span>
      {#each RAMP as c, i (i)}<span class="lg-sw" style="background:{c}"></span>{/each}
      <span class="lg-lbl">heavier</span>
      <span class="lg-note">· scaled across this window only</span>
    </div>
    <div class="heat">
      <div class="dow">
        <span></span><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span>
      </div>
      <div class="weeks" role="img" aria-label="Daily token-spend heatmap over {range}: {compact(d.totals.tokens)} tokens total, colour log-scaled per day (brighter = heavier).">
        {#each cells as week, wi (wi)}
          <div class="week">
            {#each week as cell, di (di)}
              {#if cell}
                <div
                  class="cell"
                  style="background:{cellColor(cell.tokens)}"
                  title="{shortDate(cell.date)} — {compact(cell.tokens)} tokens · {usd(cell.est)} est{cell.native != null ? ` · ${usd(cell.native)} native` : ''}"
                ></div>
              {:else}
                <div class="cell empty"></div>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="receipts">
      <div class="totline">
        <span class="big mono">{compact(d.totals.tokens)}</span>
        <span class="sub">tokens · {usd(d.totals.estimatedUsd)} est over {range}</span>
      </div>
      <div class="scales">
        {#each d.scaleEquivalents as s (s.label)}
          <span class="scale" title="{compact(d.totals.tokens)} ÷ {compact(s.divisor)} — {s.note}">
            ≈ <strong>{s.value.toLocaleString()}</strong> {s.label}
          </span>
        {/each}
      </div>
    </div>

    <p class="colnote">
      <span class="est">est</span> = rack-rate estimate (every agent) ·
      <span class="nat">native</span> = exact provider charge when known (Claude OTEL, Pi metered) ·
      <span class="dash">—</span> = no native figure that day
    </p>
    <p class="outhint">Each day pairs its <span class="est">est</span> cost with the git output it produced (estimated, hash-deduped).</p>
    <div class="ma">
      <div class="ma-row head"><span>day</span><span>tokens</span><span>est $</span><span>native $</span></div>
      {#each recent as r (r.date)}
        <div class="ma-row">
          <span>{shortDate(r.date)}</span>
          <span class="mono">{compact(r.tokens)}</span>
          <span class="mono est">{usd(r.estUsd)}</span>
          <span class="mono nat">{r.nativeUsd != null ? usd(r.nativeUsd) : "—"}</span>
        </div>
        {#if outByDate.get(r.date)}
          <div class="ma-out">
            <span class="out-lbl">output</span>
            <DayOutputStrip outcome={outByDate.get(r.date)} />
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .sel {
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-dim);
  }
  .caption { margin: 0 0 8px; font-size: 11.5px; color: var(--text-subtle); }
  .legend { display: flex; align-items: center; gap: 4px; margin: 0 0 12px; font-size: 10px; color: var(--text-subtle); }
  .lg-sw { width: 12px; height: 12px; border-radius: 3px; border: 1px solid color-mix(in srgb, #000 22%, transparent); }
  .lg-lbl { color: var(--text-subtle); }
  .lg-note { color: var(--text-subtle); opacity: 0.8; }
  .colnote { margin: 14px 0 6px; font-size: 10.5px; line-height: 1.5; color: var(--text-subtle); }
  .colnote .est { color: var(--amber); font-weight: 600; }
  .colnote .nat { color: var(--cyan); font-weight: 600; }
  .colnote .dash { color: var(--text-dim); font-weight: 600; }
  .heat { display: flex; gap: 6px; }
  .dow {
    display: grid;
    grid-template-rows: repeat(7, 1fr);
    gap: 3px;
    font-size: 8px;
    color: var(--text-subtle);
  }
  .dow span { height: 13px; line-height: 13px; }
  .weeks { display: flex; gap: 3px; overflow-x: auto; flex: 1; }
  .week { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; }
  .cell {
    width: 13px;
    height: 13px;
    border-radius: 3px;
    /* background is set inline from the colourblind-safe ramp (cellColor). */
    border: 1px solid color-mix(in srgb, #000 22%, transparent);
  }
  .cell.empty { background: transparent; border-color: transparent; }
  .receipts { margin: 18px 0 14px; }
  .totline { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .big { font-size: 22px; font-weight: 600; color: var(--text); }
  .sub { font-size: 11.5px; color: var(--text-subtle); display: inline-flex; align-items: center; gap: 5px; }
  .scales { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px; }
  .scale { font-size: 12px; color: var(--text-dim); cursor: help; }
  .scale strong { color: var(--text); }
  .ma { font-size: 12px; }
  .ma-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 6px;
    padding: 5px 2px;
    border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .ma-row.head { color: var(--text-subtle); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .ma-row span:not(:first-child) { text-align: right; }
  .ma-out {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 2px 8px 10px;
    border-bottom: 1px solid var(--border);
    border-left: 2px solid color-mix(in srgb, var(--amber) 45%, var(--border));
  }
  .out-lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle); }
  .outhint { margin: 12px 0 4px; font-size: 10.5px; color: var(--text-subtle); }
  .outhint .est { color: var(--amber); font-weight: 600; }
  .est { color: var(--amber); display: inline-flex; gap: 4px; align-items: center; justify-content: flex-end; }
  .nat { color: var(--cyan); }
</style>
