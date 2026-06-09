<script lang="ts">
  import type { Snippet } from "svelte";
  type Tone = "default" | "accent" | "green" | "amber" | "red" | "cyan";
  let {
    tone = "default",
    children,
  }: { tone?: Tone; children: Snippet } = $props();
</script>

<span class="badge {tone}">{@render children()}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.03em;
    border: 1px solid var(--border);
    color: var(--text-dim);
    background: var(--surface-2);
    white-space: nowrap;
  }
  .accent {
    color: #ffd9b3;
    border-color: color-mix(in srgb, var(--accent-from) 45%, var(--border));
    background: color-mix(in srgb, var(--accent-from) 14%, transparent);
  }
  .green {
    color: var(--green);
    border-color: color-mix(in srgb, var(--green) 40%, var(--border));
    background: color-mix(in srgb, var(--green) 12%, transparent);
  }
  .amber {
    color: var(--amber);
    border-color: color-mix(in srgb, var(--amber) 40%, var(--border));
    background: color-mix(in srgb, var(--amber) 12%, transparent);
  }
  .red {
    color: var(--red);
    border-color: color-mix(in srgb, var(--red) 40%, var(--border));
    background: color-mix(in srgb, var(--red) 12%, transparent);
  }
  .cyan {
    color: var(--cyan);
    border-color: color-mix(in srgb, var(--cyan) 40%, var(--border));
    background: color-mix(in srgb, var(--cyan) 12%, transparent);
  }
</style>
