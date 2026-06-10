<script lang="ts">
  import { slide } from "svelte/transition";
  import Card from "../ui/Card.svelte";
  import InfoModal from "../ui/InfoModal.svelte";
  import Badge from "../ui/Badge.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Icon from "../ui/Icon.svelte";
  import RangeToggle from "../ui/RangeToggle.svelte";
  import OtelIndicator from "../ui/OtelIndicator.svelte";
  import { getMcpServers, getMcpTools, type McpTools, type Range } from "../../api";
  import { resource } from "../../resource.svelte";
  import { ms, pct, compact } from "../../format";

  let range = $state<Range>("30d");
  const res = resource(() => `mcp:${range}`, () => getMcpServers(range));
  const servers = $derived(res.data?.servers ?? []);

  // Lazily fetched per-tool breakdowns, keyed by server. Expanding fetches once.
  let expanded = $state<string | null>(null);
  let toolCache = $state<Record<string, McpTools | "loading" | "error">>({});

  async function toggle(server: string) {
    if (expanded === server) {
      expanded = null;
      return;
    }
    expanded = server;
    const cacheKey = `${server}:${range}`;
    if (!toolCache[cacheKey]) {
      toolCache = { ...toolCache, [cacheKey]: "loading" };
      try {
        const data = await getMcpTools(server, range);
        toolCache = { ...toolCache, [cacheKey]: data };
      } catch {
        toolCache = { ...toolCache, [cacheKey]: "error" };
      }
    }
  }

  function flag(p95: number | null): "slow" | "fast" | "" {
    if (p95 == null) return "";
    if (p95 >= 10_000) return "slow";
    if (p95 < 500) return "fast";
    return "";
  }
</script>

<Card title="MCP servers" icon="plug" kicker="per-server → per-tool latency">
  {#snippet actions()}
    <RangeToggle value={range} options={["7d", "30d", "90d"]} onChange={(r) => (range = r)} />
    <InfoModal title="Why MCP is the centerpiece">
      <p class="modal-p">Each server expands to a per-tool table (p50 / p95 / max / error / N). A p95 ≥ 10s reads red (<code>· slow</code>); sub-500ms reads cyan (<code>· fast</code>). Attribution is OTEL-precise when telemetry is on (server &amp; tool names pre-tagged), falling back to parsing <code>mcp__server__tool</code> from JSONL — this is where the dashboard earns its keep.</p>
    </InfoModal>
  {/snippet}

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !servers.length}
    <EmptyState icon="plug" title="No MCP traffic in range" message="Servers with totals, avg + p95 latency. Click a server → per-tool breakdown. Slow tools (p95 ≥ 10s) flag red." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="src-row">
      <OtelIndicator on={res.data?.source === "otel"} />
      <span class="src">{res.data?.source === "otel" ? "OTEL-precise attribution" : "JSONL fallback (mcp__server__tool)"}</span>
    </div>
    <div class="list">
      {#each servers as s (s.server)}
        <div class="srv">
          <button class="srv-head" class:open={expanded === s.server} onclick={() => toggle(s.server)}>
            <span class="chev"><Icon name="chevron-right" size={14} /></span>
            <span class="srv-name">{s.server}</span>
            <span class="srv-meta">
              <span class="m">{s.tools} tools</span>
              <span class="m">{compact(s.calls)} calls</span>
              {#if s.errors > 0}<Badge tone="red">{s.errors} err</Badge>{/if}
            </span>
            <span class="srv-p95 mono" class:bad={flag(s.p95) === "slow"} class:good={flag(s.p95) === "fast"}>
              {ms(s.p95)}
              {#if flag(s.p95) === "slow"}<span class="tag slow">· slow</span>{:else if flag(s.p95) === "fast"}<span class="tag fast">· fast</span>{/if}
            </span>
          </button>

          {#if expanded === s.server}
            {@const td = toolCache[`${s.server}:${range}`]}
            <div class="tools" transition:slide={{ duration: 200 }}>
              {#if td === "loading" || !td}
                <div class="muted pad">Loading tools…</div>
              {:else if td === "error"}
                <div class="muted pad">Could not load tools.</div>
              {:else}
                <div class="trow head"><span>tool</span><span>N</span><span>p50</span><span>p95</span><span>max</span><span>err</span></div>
                {#each td.tools as t (t.tool)}
                  <div class="trow">
                    <span class="t-name" title={t.tool}>{t.tool}</span>
                    <span class="mono num">{t.calls}</span>
                    <span class="mono num">{ms(t.p50)}</span>
                    <span class="mono num" class:bad={flag(t.p95) === "slow"} class:good={flag(t.p95) === "fast"}>{ms(t.p95)}</span>
                    <span class="mono num dim">{ms(t.max)}</span>
                    <span class="mono num" class:bad={t.errorRate > 0}>{t.errors ? pct(t.errorRate, 0) : "0"}</span>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .pad { padding: 10px 13px; }
  .modal-p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-dim); }
  .src-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .src { font-size: 11px; color: var(--text-subtle); }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .srv { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); }
  .srv-head {
    display: grid;
    grid-template-columns: 18px 1fr auto auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 11px 13px;
    text-align: left;
    transition: background 0.15s var(--ease);
  }
  .srv-head:hover { background: color-mix(in srgb, var(--border) 30%, transparent); }
  .chev { display: grid; place-items: center; color: var(--text-subtle); transition: transform 0.18s var(--ease); }
  .srv-head.open .chev { transform: rotate(90deg); }
  .srv-name { font-size: 13px; font-weight: 600; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .srv-meta { display: inline-flex; align-items: center; gap: 10px; }
  .srv-meta .m { font-size: 11px; color: var(--text-subtle); }
  .srv-p95 { font-size: 13px; color: var(--text-dim); white-space: nowrap; }
  .tag { font-size: 9.5px; font-weight: 600; }
  .tag.slow { color: var(--red); }
  .tag.fast { color: var(--cyan); }
  .tools { border-top: 1px solid var(--border); background: var(--surface); }
  .trow {
    display: grid;
    grid-template-columns: 1fr 44px 56px 56px 56px 48px;
    gap: 6px;
    align-items: center;
    padding: 6px 13px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .trow.head { color: var(--text-subtle); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .t-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .num { text-align: right; }
  .dim { color: var(--text-subtle); }
  .bad { color: var(--red); }
  .good { color: var(--cyan); } /* "good/fast" is cyan, not green (colourblind-safe vs red) */
</style>
