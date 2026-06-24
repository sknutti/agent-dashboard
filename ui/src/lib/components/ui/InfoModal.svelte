<script lang="ts">
  import type { Snippet } from "svelte";
  import Sheet from "./Sheet.svelte";
  import IconButton from "./IconButton.svelte";
  // Info-modal affordance (ADR-0003 validated) — an "i" button that opens a
  // Sheet. Demonstrates Sheet reuse beyond the drill-down.
  let { title, children }: { title: string; children: Snippet } = $props();
  let open = $state(false);
</script>

<IconButton
  icon="info"
  label="More info"
  size={26}
  iconSize={15}
  onclick={() => (open = true)}
/>

<Sheet {open} {title} width={420} onClose={() => (open = false)}>
  {@render children()}
</Sheet>
