<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { Button, Input, Select } from "../ui";
  import Icon from "../ui/Icon.svelte";
  import { getSkills, setSkillAutonomy, syncSkills as apiSyncSkills, type SkillRow } from "../../api";
  import { resource } from "../../resource.svelte";

  const res = resource("skills", () => getSkills());
  let search = $state("");
  let env = $state("all");
  let overrides = $state<Record<string, string>>({});
  let syncing = $state(false);

  const all = $derived(res.data?.skills ?? []);
  const facets = $derived(res.data?.facets ?? []);
  const filtered = $derived(
    all.filter((s) => {
      if (env !== "all" && s.environment !== env) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
    }),
  );

  const ENV_LABEL: Record<string, string> = { "ide:global": "global", "ide:project": "project", "cowork:plugin": "plugin" };
  const LEVELS = ["auto", "review", "manual"];
  function autonomyOf(s: SkillRow): string {
    return overrides[s.name] ?? s.autonomy_level ?? "manual";
  }
  async function changeAutonomy(name: string, level: string) {
    overrides = { ...overrides, [name]: level };
    try {
      await setSkillAutonomy(name, level);
    } catch {
      /* leave optimistic value; a reload would reconcile */
    }
  }
  async function resync() {
    syncing = true;
    try {
      await apiSyncSkills();
      res.reload();
    } finally {
      syncing = false;
    }
  }
</script>

<Card title="Skills registry" icon="box" kicker="{res.data?.total ?? 0} skills · autonomy controls">
  {#snippet actions()}
    <div class="acts">
      <label class="search">
        <Icon name="search" size={13} />
        <Input class="search-field" placeholder="name or description…" ariaLabel="Search skills by name or description" bind:value={search} />
      </label>
      <Button size="sm" loading={syncing} onclick={resync} ariaLabel="Re-scan SKILL.md files">
        {syncing ? "syncing…" : "re-sync"}
      </Button>
    </div>
  {/snippet}

  <div class="chips">
    <!-- ds-allow-native: toggle-pill in a custom filter chip group, not a form-control button -->
    <button class="chip" class:on={env === "all"} onclick={() => (env = "all")}>all ({all.length})</button>
    {#each facets as f (f.environment)}
      <!-- ds-allow-native: toggle-pill in a custom filter chip group, not a form-control button -->
      <button class="chip" class:on={env === f.environment} onclick={() => (env = f.environment)}>
        {ENV_LABEL[f.environment] ?? f.environment} ({f.n})
      </button>
    {/each}
  </div>

  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !filtered.length}
    <EmptyState icon="box" title="No skills match" message="Adjust the search or environment filter." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="scroll">
      {#each filtered as s (s.name)}
        <div class="row">
          <div class="info">
            <div class="line1">
              <span class="name" title={s.path}>{s.name}</span>
              <span class="badge {s.environment.replace(':', '-')}">{ENV_LABEL[s.environment] ?? s.environment}</span>
              {#if (s.script_count ?? 0) > 0}<span class="scripts u-subtle mono">{s.script_count} files</span>{/if}
            </div>
            {#if s.description}<p class="desc" title={s.description}>{s.description}</p>{/if}
          </div>
          <Select
            class="auto"
            value={autonomyOf(s)}
            options={LEVELS}
            ariaLabel="Autonomy level for {s.name}"
            onchange={(e) => changeAutonomy(s.name, (e.currentTarget as HTMLSelectElement).value)}
          />
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .acts { display: flex; align-items: center; gap: 8px; }
  .search {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface-2); color: var(--text-subtle);
  }
  /* Input primitive sits inside the icon wrapper — strip its chrome, the wrapper
     provides the search-affordance border/background. */
  .search :global(.search-field) { border: none; background: transparent; color: var(--text); font-size: 12px; padding: 0; width: 160px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }
  .chip {
    padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px;
    background: transparent; color: var(--text-dim); font-size: 11px; cursor: pointer;
    transition: all 0.15s var(--ease);
  }
  .chip:hover { border-color: var(--border-glow); color: var(--text); }
  .chip.on { background: var(--surface-2); border-color: var(--cyan); color: var(--cyan); }
  .scroll { max-height: 460px; overflow-y: auto; }
  .row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 8px 4px; border-bottom: 1px solid var(--border);
  }
  .info { min-width: 0; }
  .line1 { display: flex; align-items: center; gap: 8px; }
  .name { font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9.5px; font-weight: 600; padding: 1px 6px; border-radius: 5px; background: var(--surface-2); color: var(--text-dim); flex: none; }
  .badge.ide-global { color: var(--cyan); }
  .badge.cowork-plugin { color: var(--amber); }
  .scripts { font-size: 10px; flex: none; }
  .desc {
    margin: 2px 0 0; font-size: 11px; line-height: 1.45; color: var(--text-dim);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  /* The autonomy Select keeps a flex:none so it doesn't shrink against the row. */
  .row :global(.auto) { flex: none; }
</style>
