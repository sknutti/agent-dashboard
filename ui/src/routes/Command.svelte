<script lang="ts">
  import Card from "../lib/components/ui/Card.svelte";
  import CollapsibleSection from "../lib/components/ui/CollapsibleSection.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
  import Accordion from "../lib/components/ui/Accordion.svelte";
  import FidelityBadge from "../lib/components/ui/FidelityBadge.svelte";
  import InfoModal from "../lib/components/ui/InfoModal.svelte";
  import KpiRow from "../lib/components/panels/KpiRow.svelte";
  import AgentCard, { type AgentMeta } from "../lib/components/panels/AgentCard.svelte";

  // The four agents (CONTEXT.md). Phase 0 can't yet know which are installed —
  // that detection arrives with the adapters — so all render "not detected".
  const AGENTS: AgentMeta[] = [
    { id: "claude_code", name: "Claude Code", otel: false, cost: "native", detected: false },
    { id: "codex", name: "Codex", otel: false, cost: "none", detected: false },
    { id: "pi", name: "Pi", otel: false, cost: "native", detected: false },
    { id: "antigravity", name: "Antigravity", otel: false, cost: "none", detected: false },
  ];
</script>

<div class="page">
  <KpiRow />

  <div class="block">
    <p class="kicker block-kicker">Agents</p>
    <div class="agent-grid">
      {#each AGENTS as a (a.id)}<AgentCard agent={a} />{/each}
    </div>
  </div>

  <CollapsibleSection id="live" title="Live sessions" subtitle="in-flight, across all agents">
    <Card title="Live sessions" icon="circle-dot" kicker="real-time">
      <EmptyState
        icon="circle-dot"
        title="No active sessions"
        message="When an agent is mid-run, it appears here with its tool timeline. Each row expands to a scrollable raw feed."
      />
      <div class="demo-acc">
        <Accordion scroll>
          {#snippet summary()}
            <span class="mono dim">example session row · expands to raw JSONL</span>
          {/snippet}
          <span class="dim">Raw event feed renders here in Phase 1.</span>
        </Accordion>
      </div>
    </Card>
  </CollapsibleSection>

  <CollapsibleSection id="tokens-burn" title="Token usage & Burn" subtitle="where the spend goes, and whether it's making you fluent">
    <div class="grid-2">
      <Card title="Token usage" icon="cpu" kicker="today · 7d · 30d">
        {#snippet actions()}<FidelityBadge fidelity="exact" />{/snippet}
        <EmptyState icon="cpu" title="No token data yet" message="Stacked daily bars (input · output · reasoning · cache), per agent, once the first sync lands." />
      </Card>
      <Card title="Burn" icon="gauge" kicker="fluent, or just expensive?">
        {#snippet actions()}<FidelityBadge fidelity="estimated" />{/snippet}
        <EmptyState icon="gauge" title="Nothing to burn yet" message="A bill tells you what happened — a burn view changes what you hand the computer tomorrow." />
      </Card>
    </div>
  </CollapsibleSection>

  <CollapsibleSection id="observability" title="Observability" subtitle="latency · cache · outcomes · pressure">
    <div class="grid-2">
      <Card title="Cache efficiency" icon="database" kicker="hit rate">
        {#snippet actions()}
          <InfoModal title="Cache efficiency">
            <p class="modal-p">Hit rate = cache-read tokens ÷ billable tokens. Target line at 70%. A "low sample" badge shows under 10K billable tokens so a tiny denominator can't masquerade as a real rate.</p>
          </InfoModal>
        {/snippet}
        <EmptyState icon="database" title="No cache data" message="Hit-rate trend with a 70% target line, once tokens flow." />
      </Card>
      <Card title="Session outcomes" icon="layers" kicker="ok · errored · limited">
        <EmptyState icon="layers" title="No sessions yet" message="Stacked daily bars: ok / errored / rate-limited / truncated / unfinished." />
      </Card>
    </div>
    <div class="grid-2">
      <Card title="Tool latency" icon="wrench" kicker="p50 · p95 · max">
        <EmptyState icon="wrench" title="No tool calls yet" message="Per-tool p50/p95/max + error rate, sorted by p95. Red flags at p95 ≥ 10s." />
      </Card>
      <Card title="Hook activity" icon="zap" kicker="fires per hook">
        <EmptyState icon="zap" title="No hook fires" message="Daily fires per hook with paired-duration estimates." />
      </Card>
    </div>
    <div class="grid-2">
      <Card title="Project breakdown" icon="box" kicker="by working dir">
        <EmptyState icon="box" title="No projects yet" message="Sessions grouped by cwd, home-dir collapsed to ~." />
      </Card>
      <Card title="Subscription savings" icon="dollar" kicker="estimated − native">
        {#snippet actions()}<FidelityBadge fidelity="estimated" />{/snippet}
        <EmptyState icon="dollar" title="No savings computed" message="For Claude & Pi: what the subscription saves vs. paying API rates." />
      </Card>
    </div>
    <Card title="Pressure" icon="alert" kicker="retries · compaction · api errors">
      <EmptyState icon="alert" title="No pressure signals" message="Retry exhaustion, compaction count, and the last 10 API errors with attempt counts." />
    </Card>
  </CollapsibleSection>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .block-kicker {
    margin: 0 0 12px 4px;
  }
  .agent-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  @media (max-width: 1080px) {
    .agent-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
    align-items: stretch;
  }
  @media (max-width: 860px) {
    .grid-2 {
      grid-template-columns: 1fr;
    }
  }
  .demo-acc {
    margin-top: 14px;
  }
  .dim {
    color: var(--text-subtle);
  }
  .modal-p {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-dim);
  }
</style>
