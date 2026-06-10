<script lang="ts">
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
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
        <input type="text" placeholder="name or description…" bind:value={search} />
      </label>
      <button class="sync" onclick={resync} disabled={syncing} title="Re-scan SKILL.md files">
        {syncing ? "syncing…" : "re-sync"}
      </button>
    </div>
  {/snippet}

  <div class="chips">
    <button class="chip" class:on={env === "all"} onclick={() => (env = "all")}>all ({all.length})</button>
    {#each facets as f (f.environment)}
      <button class="chip" class:on={env === f.environment} onclick={() => (env = f.environment)}>
        {ENV_LABEL[f.environment] ?? f.environment} ({f.n})
      </button>
    {/each}
  </div>

  {#if res.loading && !res.data}
    <div class="muted">Loading…</div>
  {:else if !filtered.length}
    <EmptyState icon="box" title="No skills match" message="Adjust the search or environment filter." />
  {:else}
    <div class="scroll">
      {#each filtered as s (s.name)}
        <div class="row">
          <div class="info">
            <div class="line1">
              <span class="name" title={s.path}>{s.name}</span>
              <span class="badge {s.environment.replace(':', '-')}">{ENV_LABEL[s.environment] ?? s.environment}</span>
              {#if (s.script_count ?? 0) > 0}<span class="scripts dim mono">{s.script_count} files</span>{/if}
            </div>
            {#if s.description}<p class="desc" title={s.description}>{s.description}</p>{/if}
          </div>
          <select class="auto" value={autonomyOf(s)} onchange={(e) => changeAutonomy(s.name, e.currentTarget.value)}>
            {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
          </select>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .muted { color: var(--text-subtle); font-size: 13px; }
  .acts { display: flex; align-items: center; gap: 8px; }
  .search {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface-2); color: var(--text-subtle);
  }
  .search input { border: none; background: transparent; color: var(--text); font-size: 12px; outline: none; width: 160px; }
  .sync {
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface-2); color: var(--text-dim); font-size: 12px; cursor: pointer;
  }
  .sync:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
  .sync:disabled { opacity: 0.5; cursor: default; }
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
  .auto {
    flex: none; padding: 3px 6px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--surface-2); color: var(--text-dim); font-size: 11px; outline: none; cursor: pointer;
  }
  .auto:hover { border-color: var(--cyan); }
  .dim { color: var(--text-subtle); }
</style>
