<script lang="ts">
  // PROTOTYPE: Three Library route variants, switchable via ?variant=, inside the existing dashboard shell.
  import Badge from "../lib/components/ui/Badge.svelte";
  import Icon from "../lib/components/ui/Icon.svelte";
  import PrototypeSwitcher from "../lib/components/ui/PrototypeSwitcher.svelte";
  import { router } from "../lib/router.svelte";

  type Kind = "Skill" | "Agent" | "Command" | "CodexAgent";
  type TargetName = "Claude" | "Pi" | "Codex";
  type DriftState = "clean" | "drift" | "missing" | "not_installed";
  type VariantKey = "A" | "B" | "C";

  interface PrimitiveRow {
    id: string;
    name: string;
    kind: Kind;
    summary: string;
    currentVersion: string;
    versionCount: number;
    targets: TargetName[];
    installSummary: string;
    drift: DriftState;
    files: number;
    modified: string;
    path: string;
    primaryFile: string;
    usage: string | null;
    branch: string;
  }

  const variants = [
    { key: "A", label: "Inventory console" },
    { key: "B", label: "Explorer detail" },
    { key: "C", label: "Lifecycle board" },
  ];

  const primitives: PrimitiveRow[] = [
    {
      id: "review-loop",
      name: "review-loop",
      kind: "Skill",
      summary: "Review workspace changes against local standards and specs.",
      currentVersion: "v7",
      versionCount: 7,
      targets: ["Claude", "Codex"],
      installSummary: "2 installed",
      drift: "clean",
      files: 5,
      modified: "today 09:12",
      path: "skills/review-loop",
      primaryFile: "SKILL.md",
      usage: "48 calls in 7d",
      branch: "main",
    },
    {
      id: "docs-steward",
      name: "docs-steward",
      kind: "Agent",
      summary: "Maintains project context docs and ADR follow-through.",
      currentVersion: "v4",
      versionCount: 4,
      targets: ["Claude", "Pi"],
      installSummary: "1 installed",
      drift: "drift",
      files: 3,
      modified: "yesterday 17:46",
      path: "agents/docs-steward",
      primaryFile: "agent.md",
      usage: null,
      branch: "main",
    },
    {
      id: "ship-notes",
      name: "ship-notes",
      kind: "Command",
      summary: "Turns completed work into a concise release-note draft.",
      currentVersion: "v3",
      versionCount: 3,
      targets: ["Claude", "Pi", "Codex"],
      installSummary: "3 installed",
      drift: "clean",
      files: 1,
      modified: "Jun 10 14:05",
      path: "commands/ship-notes",
      primaryFile: "ship-notes.md",
      usage: null,
      branch: "main",
    },
    {
      id: "rust-port",
      name: "rust-port",
      kind: "CodexAgent",
      summary: "Codex agent profile for small Rust migration slices.",
      currentVersion: "v2",
      versionCount: 2,
      targets: ["Codex"],
      installSummary: "not installed",
      drift: "not_installed",
      files: 1,
      modified: "Jun 9 11:21",
      path: "codex_agents/rust-port",
      primaryFile: "rust-port.toml",
      usage: null,
      branch: "main",
    },
    {
      id: "browser-check",
      name: "browser-check",
      kind: "Skill",
      summary: "Verifies localhost UI changes in the in-app browser.",
      currentVersion: "v5",
      versionCount: 5,
      targets: ["Claude"],
      installSummary: "missing install",
      drift: "missing",
      files: 4,
      modified: "Jun 8 19:33",
      path: "skills/browser-check",
      primaryFile: "SKILL.md",
      usage: "12 calls in 7d",
      branch: "main",
    },
    {
      id: "adr-capture",
      name: "adr-capture",
      kind: "Command",
      summary: "Captures a resolved architecture decision in the local ADR style.",
      currentVersion: "v1",
      versionCount: 1,
      targets: ["Claude", "Codex"],
      installSummary: "2 installed",
      drift: "clean",
      files: 1,
      modified: "Jun 7 10:18",
      path: "commands/adr-capture",
      primaryFile: "adr-capture.md",
      usage: null,
      branch: "main",
    },
  ];

  const kinds: Kind[] = ["Skill", "Agent", "Command", "CodexAgent"];
  const targetNames: TargetName[] = ["Claude", "Pi", "Codex"];

  let selectedId = $state("review-loop");
  const selected = $derived(primitives.find((p) => p.id === selectedId) ?? primitives[0]!);
  const requestedVariant = $derived(new URLSearchParams(router.search).get("variant"));
  const currentVariant = $derived(normalizeVariant(requestedVariant));
  const cleanCount = $derived(primitives.filter((p) => p.drift === "clean").length);
  const attentionCount = $derived(primitives.length - cleanCount);

  function normalizeVariant(value: string | null): VariantKey {
    if (value === "B" || value === "C") return value;
    return "A";
  }

  function rowsForKind(kind: Kind): PrimitiveRow[] {
    return primitives.filter((p) => p.kind === kind);
  }

  function rowsForTarget(target: TargetName): PrimitiveRow[] {
    return primitives.filter((p) => p.targets.includes(target));
  }

  function kindTone(kind: Kind): "accent" | "cyan" | "green" | "amber" {
    if (kind === "Skill") return "accent";
    if (kind === "Agent") return "cyan";
    if (kind === "Command") return "green";
    return "amber";
  }

  function driftTone(drift: DriftState): "green" | "amber" | "red" | "default" {
    if (drift === "clean") return "green";
    if (drift === "drift") return "amber";
    if (drift === "missing") return "red";
    return "default";
  }

  function driftLabel(drift: DriftState): string {
    if (drift === "clean") return "clean";
    if (drift === "drift") return "drift";
    if (drift === "missing") return "missing";
    return "not installed";
  }
</script>

<div class="library-prototype">
  <div class="state-strip">
    <span class="mono">variant {currentVariant}</span>
    <span>~/work/prompt-library</span>
    <span>{primitives.length} primitives</span>
    <span>{cleanCount} clean</span>
    <span>{attentionCount} need review</span>
  </div>

  {#if currentVariant === "A"}
    <section class="variant inventory-console" aria-label="Inventory console variant">
      <header class="route-head">
        <div>
          <p class="kicker">Library read model</p>
          <h2>Primitive inventory</h2>
          <p>File-backed Library status with live Drift and read-only observability cross-links.</p>
        </div>
        <div class="head-actions">
          <Badge tone="green">git clean</Badge>
          <Badge>main</Badge>
        </div>
      </header>

      <div class="metrics-row">
        {#each kinds as kind (kind)}
          <button class="metric" type="button">
            <span>{kind}</span>
            <strong>{rowsForKind(kind).length}</strong>
          </button>
        {/each}
      </div>

      <div class="inventory-grid">
        <section class="panel inventory-table">
          <div class="panel-head">
            <h3>All primitives</h3>
            <div class="chips">
              <span>all kinds</span>
              <span>all targets</span>
              <span>read-only</span>
            </div>
          </div>

          <div class="table">
            <div class="table-row table-head">
              <span>Name</span>
              <span>Kind</span>
              <span>Targets</span>
              <span>Version</span>
              <span>Drift</span>
              <span>Usage</span>
            </div>
            {#each primitives as primitive (primitive.id)}
              <button
                class="table-row"
                class:selected={selected.id === primitive.id}
                type="button"
                onclick={() => (selectedId = primitive.id)}
              >
                <span class="name-cell">
                  <strong>{primitive.name}</strong>
                  <small>{primitive.primaryFile}</small>
                </span>
                <span><Badge tone={kindTone(primitive.kind)}>{primitive.kind}</Badge></span>
                <span>{primitive.targets.join(", ")}</span>
                <span class="mono">{primitive.currentVersion}</span>
                <span><Badge tone={driftTone(primitive.drift)}>{driftLabel(primitive.drift)}</Badge></span>
                <span>{primitive.usage ?? "not observed"}</span>
              </button>
            {/each}
          </div>
        </section>

        <aside class="panel inspector">
          <div class="panel-head">
            <h3>{selected.name}</h3>
            <Badge tone={kindTone(selected.kind)}>{selected.kind}</Badge>
          </div>
          <p class="summary">{selected.summary}</p>
          <div class="detail-list">
            <div><span>Path</span><strong>{selected.path}</strong></div>
            <div><span>Current</span><strong>{selected.currentVersion} of {selected.versionCount}</strong></div>
            <div><span>Files</span><strong>{selected.files}</strong></div>
            <div><span>Modified</span><strong>{selected.modified}</strong></div>
          </div>
          <div class="target-list">
            {#each targetNames as target (target)}
              <div class:off={!selected.targets.includes(target)}>
                <span>{target}</span>
                <strong>{selected.targets.includes(target) ? "allowed" : "not allowed"}</strong>
              </div>
            {/each}
          </div>
        </aside>
      </div>
    </section>
  {:else if currentVariant === "B"}
    <section class="variant explorer-detail" aria-label="Explorer detail variant">
      <aside class="explorer panel">
        <div class="panel-head">
          <h3>Library</h3>
          <Badge>{primitives.length} items</Badge>
        </div>
        <label class="search">
          <Icon name="search" size={14} />
          <input type="text" value="" placeholder="Filter primitives" readonly />
        </label>
        <div class="kind-groups">
          {#each kinds as kind (kind)}
            <section>
              <h4>{kind}</h4>
              {#each rowsForKind(kind) as primitive (primitive.id)}
                <button
                  type="button"
                  class:selected={selected.id === primitive.id}
                  onclick={() => (selectedId = primitive.id)}
                >
                  <span>{primitive.name}</span>
                  <small>{primitive.currentVersion}</small>
                </button>
              {/each}
            </section>
          {/each}
        </div>
      </aside>

      <main class="document panel">
        <header>
          <div>
            <div class="doc-title">
              <Icon name="file-text" size={18} />
              <h2>{selected.name}</h2>
            </div>
            <p>{selected.summary}</p>
          </div>
          <Badge tone={driftTone(selected.drift)}>{driftLabel(selected.drift)}</Badge>
        </header>

        <div class="doc-tabs">
          <span class="active">Working copy</span>
          <span>Versions</span>
          <span>Install records</span>
          <span>Drift</span>
        </div>

        <div class="file-frame">
          <div class="file-head">
            <span><Icon name="folder" size={14} /> {selected.path}</span>
            <span>{selected.files} files</span>
          </div>
          <pre>{`# ${selected.name}

kind: ${selected.kind}
current_version: ${selected.currentVersion}
targets: ${selected.targets.join(", ")}

${selected.summary}

File bytes load on demand in the real read model.`}</pre>
        </div>

        <div class="version-strip">
          {#each Array(selected.versionCount) as _, i}
            <span class:current={i + 1 === selected.versionCount}>v{i + 1}</span>
          {/each}
        </div>
      </main>

      <aside class="rail panel">
        <h3>Read-only status</h3>
        <div class="rail-stack">
          <div>
            <span>Targets</span>
            <strong>{selected.targets.join(" / ")}</strong>
          </div>
          <div>
            <span>Install</span>
            <strong>{selected.installSummary}</strong>
          </div>
          <div>
            <span>Git</span>
            <strong>{selected.branch} - clean</strong>
          </div>
          <div>
            <span>Observed usage</span>
            <strong>{selected.usage ?? "none yet"}</strong>
          </div>
        </div>
      </aside>
    </section>
  {:else}
    <section class="variant lifecycle-board" aria-label="Lifecycle board variant">
      <header class="route-head">
        <div>
          <p class="kicker">Library lifecycle</p>
          <h2>Targets, drift, and usage by Kind</h2>
          <p>Every Kind gets equal first-class space, with detail only after selection.</p>
        </div>
        <div class="head-actions">
          <Badge>{targetNames.length} targets</Badge>
          <Badge tone="cyan">read-only</Badge>
        </div>
      </header>

      <div class="target-band">
        {#each targetNames as target (target)}
          <div>
            <span>{target}</span>
            <strong>{rowsForTarget(target).length}</strong>
            <small>allowed primitives</small>
          </div>
        {/each}
      </div>

      <div class="board-grid">
        {#each kinds as kind (kind)}
          <section class="lane">
            <header>
              <h3>{kind}</h3>
              <Badge tone={kindTone(kind)}>{rowsForKind(kind).length}</Badge>
            </header>
            <div class="lane-items">
              {#each rowsForKind(kind) as primitive (primitive.id)}
                <button
                  type="button"
                  class="primitive-card"
                  class:selected={selected.id === primitive.id}
                  onclick={() => (selectedId = primitive.id)}
                >
                  <span class="card-line">
                    <strong>{primitive.name}</strong>
                    <Badge tone={driftTone(primitive.drift)}>{driftLabel(primitive.drift)}</Badge>
                  </span>
                  <small>{primitive.targets.join(" / ")}</small>
                  <span class="mini-meta">
                    <span>{primitive.currentVersion}</span>
                    <span>{primitive.files} files</span>
                  </span>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </div>

      <footer class="board-detail panel">
        <div>
          <p class="kicker">Selected Primitive</p>
          <h3>{selected.name}</h3>
          <p>{selected.summary}</p>
        </div>
        <div class="detail-pills">
          <Badge tone={kindTone(selected.kind)}>{selected.kind}</Badge>
          <Badge>{selected.currentVersion}</Badge>
          <Badge tone={driftTone(selected.drift)}>{driftLabel(selected.drift)}</Badge>
          <Badge>{selected.installSummary}</Badge>
        </div>
      </footer>
    </section>
  {/if}
</div>

<PrototypeSwitcher {variants} current={currentVariant} />

<style>
  .library-prototype {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 54px;
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
  .variant {
    min-width: 0;
  }
  .route-head,
  .panel-head,
  .doc-title,
  .head-actions,
  .chips,
  .card-line,
  .mini-meta,
  .detail-pills {
    display: flex;
    align-items: center;
  }
  .route-head {
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 16px;
  }
  .route-head h2,
  .document h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
  }
  .route-head p,
  .document p,
  .summary,
  .board-detail p {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }
  .head-actions,
  .detail-pills {
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
  }
  .panel-head {
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .panel-head h3,
  .rail h3,
  .lane h3,
  .board-detail h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
  }
  .metrics-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }
  .metric {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 62px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
  }
  .metric span {
    color: var(--text-dim);
    font-size: 12px;
  }
  .metric strong {
    font-size: 24px;
    font-weight: 650;
  }
  .inventory-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 14px;
  }
  .inventory-table,
  .inspector,
  .explorer,
  .document,
  .rail,
  .board-detail {
    padding: 16px;
  }
  .chips {
    gap: 6px;
    flex-wrap: wrap;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .chips span {
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .table {
    display: grid;
    gap: 2px;
    overflow-x: auto;
  }
  .table-row {
    display: grid;
    grid-template-columns: minmax(170px, 1.35fr) 110px minmax(128px, 0.9fr) 70px 112px minmax(110px, 0.9fr);
    gap: 12px;
    align-items: center;
    min-width: 820px;
    padding: 10px 9px;
    border: 1px solid transparent;
    border-radius: 7px;
    color: var(--text-dim);
    text-align: left;
    font-size: 12px;
  }
  button.table-row:hover,
  button.table-row.selected {
    border-color: var(--border-glow);
    background: var(--surface-2);
    color: var(--text);
  }
  .table-head {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
  }
  .name-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name-cell strong {
    color: var(--text);
  }
  .name-cell small,
  .primitive-card small {
    color: var(--text-subtle);
  }
  .detail-list,
  .target-list,
  .rail-stack {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }
  .detail-list div,
  .target-list div,
  .rail-stack div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }
  .detail-list span,
  .target-list span,
  .rail-stack span {
    color: var(--text-subtle);
    font-size: 11px;
  }
  .detail-list strong,
  .target-list strong,
  .rail-stack strong {
    color: var(--text);
    font-size: 12px;
    text-align: right;
  }
  .target-list .off {
    opacity: 0.42;
  }
  .explorer-detail {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr) 230px;
    gap: 14px;
    align-items: start;
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
    gap: 16px;
    margin-top: 16px;
  }
  .kind-groups h4 {
    margin: 0 0 7px;
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .kind-groups button {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 8px;
    border-radius: 7px;
    color: var(--text-dim);
    text-align: left;
  }
  .kind-groups button:hover,
  .kind-groups button.selected {
    background: var(--surface-2);
    color: var(--text);
  }
  .kind-groups small {
    color: var(--text-subtle);
  }
  .document header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .doc-title {
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
    overflow: auto;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
  }
  .version-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 13px;
  }
  .version-strip span {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .version-strip .current {
    color: var(--green);
    border-color: color-mix(in srgb, var(--green) 40%, var(--border));
  }
  .target-band {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }
  .target-band div {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  .target-band span,
  .target-band small {
    display: block;
    color: var(--text-dim);
    font-size: 12px;
  }
  .target-band strong {
    display: block;
    margin: 4px 0;
    color: var(--text);
    font-size: 24px;
  }
  .board-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .lane {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 82%, transparent);
  }
  .lane header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
  }
  .lane-items {
    display: grid;
    gap: 8px;
  }
  .primitive-card {
    display: grid;
    gap: 8px;
    width: 100%;
    min-height: 106px;
    padding: 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-dim);
    text-align: left;
  }
  .primitive-card:hover,
  .primitive-card.selected {
    border-color: var(--accent-from);
    color: var(--text);
  }
  .card-line,
  .mini-meta {
    justify-content: space-between;
    gap: 8px;
  }
  .card-line strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-meta {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .board-detail {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    margin-top: 14px;
  }
  @media (max-width: 1120px) {
    .inventory-grid,
    .explorer-detail,
    .board-grid {
      grid-template-columns: 1fr;
    }
    .explorer-detail {
      align-items: stretch;
    }
  }
  @media (max-width: 760px) {
    .route-head,
    .document header,
    .board-detail {
      align-items: flex-start;
      flex-direction: column;
    }
    .metrics-row,
    .target-band {
      grid-template-columns: 1fr 1fr;
    }
    .inventory-table {
      padding: 12px;
    }
  }
  @media (max-width: 520px) {
    .metrics-row,
    .target-band {
      grid-template-columns: 1fr;
    }
    .state-strip span {
      border-right: none;
    }
  }
</style>
