<script lang="ts">
  import OtelIndicator from "../ui/OtelIndicator.svelte";
  import { openDrill } from "../../stores.svelte";
  import { compact, usd, pct, shortDate} from "../../format";
  import { AGENT_NAMES } from "../../registry.svelte";
  import type { AgentCardData } from "../../api";

  let { agent }: { agent: AgentCardData } = $props();

  const name = $derived(AGENT_NAMES[agent.id] ?? agent.id);
  const hasData = $derived(agent.sessions > 0);
  // When there are no sessions in range, say WHY: an agent with older data
  // ("last seen <date>") is healthy-but-quiet, not broken/uninstalled (Pi's
  // Mar–Apr data is invisible at 7d/30d and otherwise reads as a dead adapter).
  const emptyReason = $derived(
    agent.lastSessionAt
      ? `No sessions in range · last seen ${shortDate(agent.lastSessionAt.slice(0, 10))}`
      : "No sessions yet",
  );

  // Token-mix segments (ADR-0003 gap #2: reasoning is first-class). The bar shows
  // segments; the input·output·reasoning·cacheR·cacheC breakdown is on hover.
  // EFFECTIVE-token segments only — cache-read is excluded (it's ~95% of raw and
  // would crush the rest; it lives in CachePanel). `dark` flags whether the
  // luminance-ramp colour (ADR-0004) needs light text for an in-segment label.
  const SEG_DEFS = [
    { key: "output", label: "output", color: "var(--tok-output)", dark: false },
    { key: "input", label: "input", color: "var(--tok-input)", dark: false },
    { key: "reasoning", label: "reasoning", color: "var(--tok-reasoning)", dark: true },
    { key: "cacheCreate", label: "cache write", color: "var(--tok-cache-write)", dark: true },
  ] as const;
  const effTotal = $derived(
    (agent.tokens.input + agent.tokens.output + agent.tokens.reasoning + agent.tokens.cacheCreate) || 1,
  );
  const segs = $derived.by(() => {
    const t = agent.tokens;
    return SEG_DEFS.map((s) => ({
      ...s,
      val: (t as any)[s.key] as number,
      pctOf: ((t as any)[s.key] as number) / effTotal,
    })).filter((s) => s.val > 0);
  });
  const mixTitle = $derived(
    segs.map((s) => `${s.label}: ${compact(s.val)} (${pct(s.pctOf, 0)})`).join("\n"),
  );

  function drill(metric: string, outcome?: string) {
    openDrill({
      title: `${name} · ${metric}`,
      subtitle: outcome ? `${outcome} sessions` : "sessions",
      agent: agent.id,
      outcome,
      query: `GET /api/sessions?agent=${agent.id}${outcome ? `&outcome=${outcome}` : ""}`,
    });
  }
</script>

<div class="agent-card" class:dim={!hasData}>
  <header>
    <span class="name">{name}</span>
    <OtelIndicator on={agent.otel} />
  </header>

  {#if !hasData}
    <p class="not-detected">{emptyReason}</p>
  {:else}
    <!-- Tokens + mix bar -->
    <button class="block-btn" onclick={() => drill("tokens")} title="Open this agent's sessions">
      <div class="tok-head">
        <span class="tok-total mono">{compact(effTotal)}</span>
        <span class="tok-label">effective tokens</span>
      </div>
      <div class="mixbar" role="img" title={mixTitle} aria-label="Token mix (effective): {mixTitle}">
        {#each segs as s (s.key)}
          <span
            class="mixseg"
            class:ondark={s.dark}
            style="width:{(s.pctOf * 100).toFixed(2)}%;background:{s.color}"
          >
            <!-- Two-tier label so the % never clips: name once it fits (~16%),
                 add the % only when there's room (~30%). -->
            {#if s.pctOf >= 0.16}<span class="mixlabel">{s.label}{#if s.pctOf >= 0.3} {pct(s.pctOf, 0)}{/if}</span>{/if}
          </span>
        {/each}
      </div>
    </button>

    <!-- Cost: estimated rack-rate (amber) + native (cyan). Fidelity reads from
         the value colour and the label text — no badges. -->
    <div class="cost-row">
      <div class="cost">
        <span class="cost-val mono">{usd(agent.costEstimatedUsd)}</span>
        <span class="cost-lbl">rack-rate · est</span>
      </div>
      <div class="cost">
        {#if agent.costUsd != null}
          <span class="cost-val mono native">{usd(agent.costUsd)}</span>
          <span class="cost-lbl">native</span>
        {:else}
          <span class="cost-val mono muted">—</span>
          <span class="cost-lbl">{agent.cost === "native" ? "native via OTEL" : "no native $"}</span>
        {/if}
      </div>
    </div>

    <!-- Stat cells (clickable drill-downs) -->
    <div class="cells">
      <button class="cell" onclick={() => drill("sessions")}>
        <span class="cell-val mono">{agent.sessions}</span>
        <span class="cell-label">sessions</span>
      </button>
      <button class="cell" onclick={() => drill("tools")}>
        <span class="cell-val mono">{compact(agent.tools)}</span>
        <span class="cell-label">tool calls</span>
      </button>
      <button class="cell" class:has-err={agent.errors > 0} onclick={() => drill("errors", "errored")}>
        <span class="cell-val mono">{agent.errors}</span>
        <span class="cell-label">errors</span>
      </button>
    </div>

    <div class="cache-line">
      <span class="cache-lbl">cache hit</span>
      <span class="cache-val mono" class:good={(agent.cacheRate ?? 0) >= 0.7}>{pct(agent.cacheRate)}{(agent.cacheRate ?? 0) >= 0.7 ? " ✓" : ""}</span>
    </div>
  {/if}
</div>

<style>
  .agent-card {
    display: flex;
    flex-direction: column;
    gap: 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    transition: border-color 0.2s var(--ease);
  }
  .agent-card:hover {
    border-color: var(--border-glow);
  }
  .agent-card.dim {
    opacity: 0.66;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .name {
    font-size: 14px;
    font-weight: 620;
    min-width: 0;
  }
  .not-detected {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-subtle);
  }
  .block-btn {
    display: flex;
    flex-direction: column;
    gap: 7px;
    text-align: left;
    width: 100%;
    /* Bare action button: strip the UA button chrome (ButtonFace fill, border,
       padding) that otherwise paints a gray slab behind the token total. */
    background: none;
    border: none;
    padding: 0;
    color: inherit;
  }
  .tok-head {
    display: flex;
    align-items: baseline;
    gap: 7px;
  }
  .tok-total {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
  }
  .tok-label,
  .cost-lbl,
  .cell-label,
  .cache-lbl {
    font-size: 10.5px;
    color: var(--text-subtle);
  }
  .mixbar {
    display: flex;
    height: 20px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    cursor: help;
  }
  .mixseg {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
  }
  /* Direct in-segment labels (ADR-0004): colour is redundant, the label names
     the category in place. Text colour flips with the luminance ramp so it
     stays legible on both light and dark segments. */
  .mixlabel {
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: clip;
    padding: 0 3px;
    color: #1a1208; /* on light (gold/amber) segments */
  }
  .mixseg.ondark .mixlabel {
    color: #eef3f8; /* on dark (teal/blue) segments */
  }
  .cost-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .cost {
    display: flex;
    align-items: baseline;
    gap: 5px;
    flex-wrap: wrap;
  }
  .cost-val {
    font-size: 14px;
    font-weight: 600;
    color: var(--amber);
  }
  .cost-val.native {
    color: var(--cyan);
  }
  .cost-val.muted {
    color: var(--text-subtle);
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    text-align: left;
    transition: all 0.15s var(--ease);
  }
  .cell:hover {
    border-color: var(--border-glow);
    background: color-mix(in srgb, var(--accent-from) 10%, var(--surface-2));
  }
  .cell.has-err .cell-val {
    color: var(--red);
  }
  .cell-val {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .cache-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cache-val {
    font-size: 12px;
    color: var(--text-dim);
  }
  /* "Good" is cyan (the app-wide cyan-as-good convention) + a ✓ glyph, not green:
     green-vs-gray text is the red/green-CVD confusable that read as just "gray". */
  .cache-val.good {
    color: var(--cyan);
  }
</style>
