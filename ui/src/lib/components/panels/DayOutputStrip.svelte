<script lang="ts">
  // One day's git-derived OUTPUT, shown inline in Burn when a day is expanded — the
  // pairing partner to that day's estimated cost ("did the spend produce anything?").
  // ESTIMATED and hash-deduped (a commit shared by overlapping sessions counts once),
  // so it's badged `≈ est` and never shows a fabricated 0. Fetched lazily via
  // resource() for the one selected day (no raw $effect; bounds git fan-out).
  // Distinct from the OTEL ProductivityPanel — do not conflate.
  import { getBurnDayOutput } from "../../api";
  import { resource } from "../../resource.svelte";
  import { compact } from "../../format";

  let { date }: { date: string } = $props();

  const res = resource(() => `dayout:${date}`, () => getBurnDayOutput(date));
  const o = $derived(res.data);
</script>

{#if res.loading && !res.data}
  <span class="dayout muted">computing…</span>
{:else if o && o.sessions === 0}
  <span class="dayout muted">no ended sessions</span>
{:else if o}
  <span
    class="dayout"
    title={`Estimated git output for ${o.date}, deduped by commit hash across the day's ${o.sessions} sessions. Heuristic — agent vs. human authorship isn't distinguished.`}
  >
    <span class="est">≈ est</span>
    <span class="fig">{o.commits} commits</span>
    <span class="sep">·</span>
    <span class="ins">+{compact(o.insertions)}</span>
    <span class="del">−{compact(o.deletions)}</span>
    <span class="sep">·</span>
    <span class="fig">{o.filesChanged} files</span>
  </span>
{/if}

<style>
  .dayout {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-dim);
  }
  .dayout.muted { color: var(--text-subtle); }
  /* est badge amber (estimate convention); ins cyan / del amber — never red/green. */
  .est {
    color: var(--amber);
    border: 1px solid color-mix(in srgb, var(--amber) 40%, var(--border));
    border-radius: 999px;
    padding: 0 6px;
    font-size: 9.5px;
    letter-spacing: 0.02em;
  }
  .ins { color: var(--cyan); }
  .del { color: var(--amber); }
  .sep { color: var(--text-subtle); }
  .fig { color: var(--text-dim); }
</style>
