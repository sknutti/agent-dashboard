<script lang="ts">
  // Git-derived session outcome — a compact, ESTIMATED strip of what the session
  // produced in git (commits / +ins / −del / files). Heuristic (CONTEXT.md
  // Fidelity), so it is always badged `≈ est` and never shows a fabricated 0:
  // an inapplicable session (no repo / live) gets a clear worded state instead.
  // Fetched via resource() (sanctioned external-sync wrapper — no raw $effect).
  // Distinct from the OTEL ProductivityPanel; do not conflate.
  import { getSessionGitOutcome } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact } from "../../format";

  let { id }: { id: string } = $props();

  const res = resource(() => `git-outcome:${id}`, () => getSessionGitOutcome(id));
  const o = $derived(res.data);

  const REASON_LABEL: Record<string, string> = {
    no_cwd: "no working directory",
    not_a_repo: "not a git repo",
    git_failed: "git unavailable",
    no_window: "no time window",
    live: "in progress",
  };
  const methodLabel = (m?: string): string =>
    m === "branch_window" ? "branch + time window" : "time window";
</script>

{#if res.loading && !res.data}
  <!-- quiet while the estimate loads -->
{:else if o?.applicable}
  <div
    class="gitout"
    title={`Estimated from local git history (${methodLabel(o.method)}). Heuristic — overlapping sessions on one repo may over- or under-count.`}
  >
    <span class="est">≈ est</span>
    <span class="fig">{o.commits} commits</span>
    <span class="sep">·</span>
    <span class="ins">+{compact(o.insertions)}</span>
    <span class="del">−{compact(o.deletions)}</span>
    <span class="sep">·</span>
    <span class="fig">{o.filesChanged} files</span>
  </div>
{:else if o}
  <div class="gitout muted">git output: {REASON_LABEL[o.reason ?? ""] ?? "—"}</div>
{/if}

<style>
  .gitout {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .gitout.muted { color: var(--text-subtle); }
  /* `est` badge: amber, the dashboard's estimate convention (never red/green). */
  .est {
    color: var(--amber);
    border: 1px solid color-mix(in srgb, var(--amber) 40%, var(--border));
    border-radius: 999px;
    padding: 0 6px;
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  /* insertions cyan / deletions amber — the colourblind-safe pos/neg pairing the
     ProductivityPanel uses; deliberately NOT red/green. */
  .ins { color: var(--cyan); }
  .del { color: var(--amber); }
  .sep { color: var(--text-subtle); }
  .fig { color: var(--text-dim); }
</style>
