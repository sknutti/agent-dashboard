<script lang="ts">
  // Production Library route (ADR-0007, Variant B — Explorer detail). Renders the
  // real /api/library/* read models: a left explorer grouped by Kind, a central
  // read-only Working-copy / Versions / allowed-Targets detail surface, and a
  // right status rail. Drift + per-target install records are out of v1 (Option
  // A / C2), so those cells/tabs are absent — not stubbed.
  import Badge from "../lib/components/ui/Badge.svelte";
  import Icon from "../lib/components/ui/Icon.svelte";
  import EmptyState from "../lib/components/ui/EmptyState.svelte";
  import { resource } from "../lib/resource.svelte";
  import {
    getLibraryStatus,
    getLibraryKindInfo,
    getLibraryTargetInfo,
    getLibraryPrimitives,
    getLibraryPrimitiveDetail,
  } from "../lib/api";
  import {
    filterPrimitives,
    groupByKind,
    selectionKey,
    parseSelection,
    dirtyCue,
    gitSummary,
    KIND_LABELS,
  } from "../lib/library";

  // Status gates everything — the route always 200s, so error here means the
  // bridge itself is unreachable.
  const status = resource("library:status", getLibraryStatus);
  const valid = $derived(status.data?.is_valid === true);

  // Capability tables + the primitive list load only once the library is valid;
  // an "idle" key resolves to empty so we never hit the bridge while unconfigured.
  const gate = (k: string) => (valid ? k : "library:idle");
  const kindInfo = resource(
    () => gate("library:kind-info"),
    (k) => (k === "library:idle" ? Promise.resolve(null) : getLibraryKindInfo()),
  );
  const targetInfo = resource(
    () => gate("library:target-info"),
    (k) => (k === "library:idle" ? Promise.resolve(null) : getLibraryTargetInfo()),
  );
  const primitivesRes = resource(
    () => gate("library:primitives"),
    (k) => (k === "library:idle" ? Promise.resolve([]) : getLibraryPrimitives()),
  );

  let query = $state("");
  let selected = $state<string | null>(null);
  // Kind sections the user has explicitly expanded — empty by default, so every
  // section starts collapsed. An active filter force-opens groups (below) so
  // matches are never hidden behind a collapsed header.
  let expanded = $state<Set<string>>(new Set());

  const primitives = $derived(primitivesRes.data ?? []);
  const filtered = $derived(filterPrimitives(primitives, query));
  const groups = $derived(groupByKind(filtered));
  const filtering = $derived(query.trim() !== "");

  function isOpen(kind: string): boolean {
    return filtering || expanded.has(kind);
  }
  function toggle(kind: string): void {
    const next = new Set(expanded); // reassign — Svelte tracks the binding, not mutation
    next.has(kind) ? next.delete(kind) : next.add(kind);
    expanded = next;
  }

  // On-demand detail, keyed by the selected kind/name (ADR: detail loads per
  // selection, file bytes are not bundled into the list payload). No
  // auto-selection — with every section collapsed by default, the detail pane
  // invites the user to pick rather than showing a primitive from a hidden group.
  const detailRes = resource(
    () => selected ?? "library:none",
    (k) => {
      const sel = parseSelection(k);
      return sel ? getLibraryPrimitiveDetail(sel.kind, sel.name) : Promise.resolve(null);
    },
  );
  const detail = $derived(detailRes.data);

  function kindTone(kind: string): "accent" | "cyan" | "amber" | "default" {
    if (kind === "skill") return "accent";
    if (kind === "agent") return "cyan";
    if (kind === "codex_agent") return "amber";
    return "default"; // command — avoid green (CVD)
  }
</script>

<div class="library">
  {#if status.loading && !status.data}
    <div class="muted">Loading…</div>
  {:else if status.error}
    <div class="panel pad">
      <EmptyState
        icon="book-open"
        title="Library unavailable"
        error={true}
        onRetry={status.reload}
      />
    </div>
  {:else if status.data?.unavailable}
    <div class="panel pad">
      <EmptyState icon="alert" title="Library bridge unavailable">
        {#if status.data.unavailable.code === "bridge_not_found"}
          The library bridge binary isn’t built. Run <code>cargo build</code> in the
          repo root to compile it, then reload.
        {:else}
          The library bridge couldn’t respond ({status.data.unavailable.message}).
        {/if}
        <div class="retry-row">
          <button type="button" class="retry-btn" onclick={status.reload}>Reload</button>
        </div>
      </EmptyState>
    </div>
  {:else if !status.data?.configured}
    <div class="panel pad">
      <EmptyState icon="book-open" title="No library configured">
        Set <code>library_path</code> in <code>config/library.yaml</code> (or the
        <code>CC_LIBRARY_PATH</code> env override) to a directory containing a
        <code>.prompt-library</code> marker, then reload.
      </EmptyState>
    </div>
  {:else if !valid}
    <div class="panel pad">
      <EmptyState icon="alert" title="Not a prompt-library directory">
        The configured <code>library_path</code> exists but has no
        <code>.prompt-library</code> marker. Point it at a real library directory,
        then reload.
      </EmptyState>
    </div>
  {:else}
    <div class="state-strip">
      <span class="mono">prompt library</span>
      <span>{primitives.length} primitives</span>
      <span>{gitSummary(status.data)}</span>
    </div>

    <section class="explorer-detail">
      <!-- Left: grouped explorer -->
      <aside class="explorer panel">
        <div class="panel-head">
          <h3>Library</h3>
          <Badge>{filtered.length} items</Badge>
        </div>
        <label class="search">
          <Icon name="search" size={14} />
          <input type="text" bind:value={query} placeholder="Filter primitives" />
        </label>

        {#if primitivesRes.loading && !primitivesRes.data}
          <div class="muted">Loading…</div>
        {:else if !primitives.length}
          <EmptyState icon="box" title="Library is empty" message="No primitives found in this library yet." error={primitivesRes.error} onRetry={primitivesRes.reload} />
        {:else if !filtered.length}
          <EmptyState icon="search" title="No matches" message={`Nothing matches “${query}”.`} />
        {:else}
          <div class="kind-groups">
            {#each groups as group (group.kind)}
              {@const open = isOpen(group.kind)}
              <section>
                <button
                  type="button"
                  class="group-head"
                  aria-expanded={open}
                  onclick={() => toggle(group.kind)}
                >
                  <span class="group-label">
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={13} />
                    {group.label}
                  </span>
                  <span class="group-count">{group.items.length}</span>
                </button>
                {#if open}
                  <div class="group-items">
                    {#each group.items as p (p.kind + "/" + p.name)}
                      {@const key = selectionKey(p.kind, p.name)}
                      {@const cue = dirtyCue(p.dirty)}
                      <button
                        type="button"
                        class="item"
                        class:selected={selected === key}
                        onclick={() => (selected = key)}
                      >
                        <span class="item-name">{p.name}</span>
                        {#if p.dirty}
                          <small class="cue" title={cue.label}>{cue.glyph} {cue.label}</small>
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      </aside>

      <!-- Center: read-only detail -->
      <main class="document panel">
        {#if detailRes.loading && !detailRes.data}
          <div class="muted">Loading…</div>
        {:else if detailRes.error}
          <EmptyState icon="file-text" title="Couldn’t load primitive" error={true} onRetry={detailRes.reload} />
        {:else if detail}
          {@const headCue = dirtyCue(primitives.find((p) => p.kind === detail.kind && p.name === detail.name)?.dirty ?? false)}
          <header>
            <div>
              <div class="doc-title">
                <Icon name="file-text" size={18} />
                <h2>{detail.name}</h2>
                <Badge tone={kindTone(detail.kind)}>{KIND_LABELS[detail.kind]}</Badge>
              </div>
              {#if detail.metadata.display_name}
                <p>{detail.metadata.display_name}</p>
              {/if}
            </div>
            <Badge tone={headCue.tone}>{headCue.glyph} {headCue.label}</Badge>
          </header>

          <div class="doc-tabs">
            <span class="active">Working copy</span>
            <span>Versions</span>
            <span>Targets</span>
          </div>

          <div class="file-frame">
            <div class="file-head">
              <span><Icon name="folder" size={14} /> working copy</span>
              <span class="mono">{detail.working.kind}</span>
            </div>
            {#if detail.working.kind === "md"}
              <pre>{detail.working.frontmatter ? `---\n${detail.working.frontmatter}---\n` : ""}{detail.working.body}</pre>
            {:else}
              <pre>{detail.working.text || "(empty)"}</pre>
            {/if}
          </div>

          <div class="versions">
            <h4>Versions</h4>
            {#if detail.versions.length}
              <div class="version-strip">
                {#each detail.versions as v (v)}
                  <span class:current={v === detail.current_version}>{v}</span>
                {/each}
              </div>
            {:else}
              <p class="muted-line">No published versions yet — working copy only.</p>
            {/if}
          </div>
        {:else}
          <EmptyState icon="file-text" title="Select a primitive" message="Choose a primitive from the explorer to view its working copy." />
        {/if}
      </main>

      <!-- Right: read-only status rail -->
      <aside class="rail panel">
        <h3>Read-only status</h3>
        {#if detail}
          <div class="rail-stack">
            <div>
              <span>Allowed targets</span>
              <strong>{detail.metadata.allowed_targets.length ? detail.metadata.allowed_targets.join(" / ") : "none set"}</strong>
            </div>
            <div>
              <span>Current version</span>
              <strong>{detail.current_version ?? "—"}</strong>
            </div>
            <div>
              <span>Author</span>
              <strong>{detail.metadata.author ?? "—"}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{detail.metadata.created_at.slice(0, 10)}</strong>
            </div>
            {#if detail.metadata.source_url}
              <div>
                <span>Source</span>
                <strong class="truncate">{detail.metadata.source_url}</strong>
              </div>
            {/if}
          </div>
        {/if}
        <div class="rail-git">
          <span><Icon name="git-branch" size={13} /> Git</span>
          <strong>{gitSummary(status.data)}</strong>
        </div>
        {#if targetInfo.data}
          <p class="rail-foot">Targets: {targetInfo.data.targets.map((t) => t.target).join(" / ")}</p>
        {/if}
      </aside>
    </section>
  {/if}
</div>

<style>
  .library {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .muted {
    color: var(--text-dim);
    font-size: 12.5px;
    padding: 12px 2px;
  }
  .muted-line {
    margin: 8px 0 0;
    color: var(--text-subtle);
    font-size: 12px;
  }
  .retry-row {
    margin-top: 12px;
  }
  .retry-btn {
    padding: 5px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
  }
  .retry-btn:hover {
    border-color: var(--border-glow);
  }
  .panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  .pad {
    padding: 16px;
  }
  .state-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-2) 74%, transparent);
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .state-strip span {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 0 8px;
    border-right: 1px solid var(--border);
  }
  .state-strip span:last-child {
    border-right: none;
  }
  .explorer-detail {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr) 230px;
    gap: 14px;
    align-items: start;
  }
  .explorer,
  .document,
  .rail {
    padding: 16px;
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .panel-head h3,
  .rail h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-subtle);
  }
  .search input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
  }
  .kind-groups {
    display: grid;
    gap: 6px;
    margin-top: 16px;
  }
  .versions h4 {
    margin: 0 0 7px;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  /* Collapsible Kind section header — click to expand/collapse. */
  .group-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 6px;
    border-radius: 7px;
    color: var(--text-subtle);
    text-align: left;
  }
  .group-head:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .group-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .group-count {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .group-items {
    display: grid;
    gap: 2px;
    margin: 2px 0 4px;
  }
  .group-items .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    padding-left: 19px;
    border-radius: 7px;
    color: var(--text-dim);
    text-align: left;
  }
  .group-items .item:hover,
  .group-items .item.selected {
    background: var(--surface-2);
    color: var(--text);
  }
  .item-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cue {
    color: var(--amber);
    font-family: var(--font-mono);
    font-size: 10px;
    white-space: nowrap;
  }
  .document header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .document h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
  }
  .document p {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }
  .doc-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .doc-tabs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .doc-tabs span {
    padding: 8px 9px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .doc-tabs .active {
    color: var(--accent-from);
    border-bottom: 1px solid var(--accent-from);
  }
  .file-frame {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  .file-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 11px;
    border-bottom: 1px solid var(--border);
    color: var(--text-subtle);
    font-size: 11px;
  }
  .file-head span {
    display: flex;
    gap: 7px;
    align-items: center;
  }
  pre {
    margin: 0;
    padding: 15px;
    max-height: 420px;
    overflow: auto;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .versions {
    margin-top: 14px;
  }
  .version-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .version-strip span {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  /* "current" uses cyan + a font-weight bump, not green (CVD). */
  .version-strip .current {
    color: var(--cyan, var(--accent-from));
    font-weight: 650;
    border-color: color-mix(in srgb, var(--accent-from) 40%, var(--border));
  }
  .rail-stack {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }
  .rail-stack div,
  .rail-git {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }
  .rail-stack span,
  .rail-git span {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .rail-stack strong,
  .rail-git strong {
    color: var(--text);
    font-size: 12px;
    text-align: right;
  }
  .rail-git {
    margin-top: 10px;
  }
  .truncate {
    min-width: 0;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail-foot {
    margin: 12px 0 0;
    color: var(--text-subtle);
    font-size: 11px;
  }
  @media (max-width: 1120px) {
    .explorer-detail {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
  }
</style>
