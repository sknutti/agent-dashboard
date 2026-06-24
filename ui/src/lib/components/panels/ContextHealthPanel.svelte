<script lang="ts">
  import Card from "../ui/Card.svelte";
  import { EmptyState } from "../ui";
  import { getContextHealth } from "../../api";
  import { resource } from "../../resource.svelte";

  const res = resource("context-health", () => getContextHealth());
  const d = $derived(res.data);

  function size(bytes: number): string {
    return bytes >= 1024 ? (bytes / 1024).toFixed(1) + " KB" : bytes + " B";
  }
</script>

<Card title="Context health" icon="info" kicker="settings.json + CLAUDE.md — read-only">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if res.error && !res.data}
    <EmptyState title="" error onRetry={res.reload} />
  {:else if d}
    <div class="grp">
      <div class="gh"><span class="gt">settings.json</span><span class="gs mono dim">{d.settings.exists ? size(d.settings.bytes) : "—"}</span></div>
      <div class="stats">
        <div class="st"><span class="sv mono">{d.settings.hooks}</span><span class="sl">hooks</span></div>
        <div class="st"><span class="sv mono">{d.settings.mcpServers}</span><span class="sl">MCP servers</span></div>
        <div class="st"><span class="sv mono">{d.settings.envKeys}</span><span class="sl">env keys</span></div>
        <div class="st">
          <span class="sv mono">{d.settings.permissions.allow}<span class="dim">/{d.settings.permissions.ask}/{d.settings.permissions.deny}</span></span>
          <span class="sl">allow / ask / deny</span>
        </div>
      </div>
    </div>
    <div class="grp">
      <div class="gh"><span class="gt">CLAUDE.md</span><span class="gs mono dim">{d.claudeMd.exists ? size(d.claudeMd.bytes) : "—"}</span></div>
      <div class="stats">
        <div class="st"><span class="sv mono">{d.claudeMd.lines}</span><span class="sl">lines</span></div>
        <div class="st"><span class="sv mono">{d.claudeMd.directives}</span><span class="sl">directives</span></div>
      </div>
    </div>
    <p class="note u-sub">Counts only — file contents never leave your machine.</p>
  {/if}
</Card>

<style>
  .grp { margin-bottom: 14px; }
  .gh { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .gt { font-size: 12px; font-weight: 600; color: var(--text-dim); font-family: var(--mono, monospace); }
  .gs { font-size: 11px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .st { display: flex; flex-direction: column; gap: 1px; }
  .sv { font-size: 18px; font-weight: 650; color: var(--text); }
  .sl { font-size: 10.5px; color: var(--text-dim); }
  /* Bare caption (not a boxed messagebox) — type from .u-sub; only the layout margin is local. */
  .note { margin: 4px 0 0; }
  .dim { color: var(--text-subtle); font-weight: 400; }
</style>
