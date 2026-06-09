<script lang="ts">
  import AppShell from "./lib/components/layout/AppShell.svelte";
  import Command from "./routes/Command.svelte";
  import Activity from "./routes/Activity.svelte";
  import Skills from "./routes/Skills.svelte";
  import DrillSheet from "./lib/components/panels/DrillSheet.svelte";
  import { router, ROUTES } from "./lib/router.svelte";

  const title = $derived(
    ROUTES.find((r) => r.path === router.path)?.label ?? "Command",
  );

  // Keep the browser tab title in sync with the route (external-system sync).
  $effect(() => {
    document.title = `${title} · Command Centre`;
  });
</script>

<AppShell {title}>
  {#if router.path === "/activity"}
    <Activity />
  {:else if router.path === "/skills"}
    <Skills />
  {:else}
    <Command />
  {/if}
</AppShell>

<!-- App-wide read-only drill-down drawer (ADR-0003) -->
<DrillSheet />
