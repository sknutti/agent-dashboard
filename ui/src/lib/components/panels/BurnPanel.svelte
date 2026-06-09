<script lang="ts">
  import Card from "../ui/Card.svelte";
  import FidelityBadge from "../ui/FidelityBadge.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getBurn, getAgents, type AgentId } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact, usd, shortDate, AGENT_NAMES } from "../../format";

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

  // Logarithmic intensity (master §11.1): per-day total tokens, log color scale.
  const logMax = $derived(Math.log1p(Math.max(1, ...(d?.daily ?? []).map((x) => x.tokens))));
  function intensity(tokens: number): number {
    if (tokens <= 0) return 0;
    return Math.max(0.08, Math.log1p(tokens) / (logMax || 1));
  }

  const recent = $derived((d?.daily ?? []).slice(-10).reverse());
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
    <FidelityBadge fidelity="estimated" />
  {/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !d || !d.daily.length}
    <EmptyState icon="gauge" title="Nothing to burn yet" message="A bill tells you what happened — a burn view changes what you hand the computer tomorrow." />
  {:else}
    <p class="caption">Each box is one local day. Color is log-scaled per-day token spend — darker is heavier.</p>
    <div class="heat">
      <div class="dow">
        <span></span><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span>
      </div>
      <div class="weeks">
        {#each cells as week, wi (wi)}
          <div class="week">
            {#each week as cell, di (di)}
              {#if cell}
                <div
                  class="cell"
                  style="--i:{intensity(cell.tokens)}"
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
        <span class="sub">tokens · {usd(d.totals.estimatedUsd)} <FidelityBadge fidelity="estimated" /> over {range}</span>
      </div>
      <div class="scales">
        {#each d.scaleEquivalents as s (s.label)}
          <span class="scale" title="{compact(d.totals.tokens)} ÷ {compact(s.divisor)} — {s.note}">
            ≈ <strong>{s.value.toLocaleString()}</strong> {s.label}
          </span>
        {/each}
      </div>
    </div>

    <div class="ma">
      <div class="ma-row head"><span>day</span><span>tokens</span><span>est $</span><span>native $</span></div>
      {#each recent as r (r.date)}
        <div class="ma-row">
          <span>{shortDate(r.date)}</span>
          <span class="mono">{compact(r.tokens)}</span>
          <span class="mono est">{usd(r.estUsd)} <FidelityBadge fidelity="estimated" /></span>
          <span class="mono nat">{r.nativeUsd != null ? usd(r.nativeUsd) : "—"}</span>
        </div>
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
  .caption { margin: 0 0 12px; font-size: 11.5px; color: var(--text-subtle); }
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
    background: color-mix(in srgb, var(--accent-from) calc(var(--i) * 85%), var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent-from) calc(var(--i) * 40%), var(--border));
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
  .est { color: var(--amber); display: inline-flex; gap: 4px; align-items: center; justify-content: flex-end; }
  .nat { color: var(--cyan); }
</style>
