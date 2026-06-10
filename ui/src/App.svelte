<script lang="ts">
  import AppShell from "./lib/components/layout/AppShell.svelte";
  import Command from "./routes/Command.svelte";
  import Activity from "./routes/Activity.svelte";
  import Skills from "./routes/Skills.svelte";
  import Session from "./routes/Session.svelte";
  import DrillSheet from "./lib/components/panels/DrillSheet.svelte";
  import { router, ROUTES, sessionIdFromPath } from "./lib/router.svelte";
  import { loadRegistry } from "./lib/registry.svelte";

  // Hydrate the agent registry (names/order/filters from agents.yaml) once at boot
  // — here, not in AppShell, so the standalone /session/:id route gets it too.
  // Idempotent; call sites fall back to the raw id until it resolves.
  void loadRegistry();

  // Dynamic `/session/:id` pages render standalone (own full-height chrome);
  // everything else lives inside the app shell.
  const sessionId = $derived(sessionIdFromPath(router.path));
  const title = $derived(
    sessionId ? "Session" : (ROUTES.find((r) => r.path === router.path)?.label ?? "Command"),
  );

  // Keep the browser tab title in sync with the route (external-system sync).
  $effect(() => {
    document.title = `${title} · Command Centre`;
  });
</script>

{#if sessionId}
  <Session id={sessionId} />
{:else}
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
{/if}
