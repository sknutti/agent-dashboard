<script lang="ts">
  // One day's git-derived OUTPUT, shown inline in Burn — the pairing partner to that
  // day's estimated cost ("did the spend produce anything?"). PROP-driven: BurnPanel
  // fetches the whole grid's output ONCE (getBurnOutput) and passes each day's row in,
  // so there's no per-row network and no per-click git fan-out. ESTIMATED and
  // hash-deduped (a commit shared by overlapping sessions counts once) → badged
  // `≈ est`, never a fabricated 0. Distinct from the OTEL ProductivityPanel.
  import { compact } from "../../format";
  import type { DayOutputRow } from "../../api";

  let { outcome }: { outcome: DayOutputRow | undefined } = $props();
</script>

{#if !outcome}
  <!-- no rollup for this day (not computed / out of range): render nothing -->
{:else if outcome.sessions === 0}
  <span class="dayout muted">no ended sessions</span>
{:else}
  <span
    class="dayout"
    title={`Estimated git output for ${outcome.date}, deduped by commit hash across the day's ${outcome.sessions} sessions. Heuristic — agent vs. human authorship isn't distinguished.`}
  >
    <span class="est">≈ est</span>
    <span class="fig">{outcome.commits} commits</span>
    <span class="sep">·</span>
    <span class="ins">+{compact(outcome.insertions)}</span>
    <span class="del">−{compact(outcome.deletions)}</span>
    <span class="sep">·</span>
    <span class="fig">{outcome.filesChanged} files</span>
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
