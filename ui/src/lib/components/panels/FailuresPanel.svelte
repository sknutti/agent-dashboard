<script lang="ts">
  import { Badge } from "../ui";
  import Card from "../ui/Card.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import { getFailures } from "../../api";
  import { navigate } from "../../router.svelte";
  import { resource } from "../../resource.svelte";
  import { ui } from "../../stores.svelte";
  import { relTime, projectName} from "../../format";
  import { AGENT_NAMES } from "../../registry.svelte";

  const res = resource(() => `failures:${ui.range}`, () => getFailures(ui.range));
  const d = $derived(res.data);
  const failures = $derived(d?.failures ?? []);

  const LABEL: Record<string, string> = {
    errored: "errored",
    rate_limited: "rate-limited",
    truncated: "truncated",
  };
  // errored = red, rate-limited/truncated = amber (no green; colourblind-safe).
  const OUTCOME_TONE: Record<string, "red" | "amber"> = {
    errored: "red", rate_limited: "amber", truncated: "amber",
  };
</script>

<Card title="Failures" icon="alert" kicker="crashed · rate-limited · truncated sessions">
  {#if res.loading && !res.data}
    <div class="u-muted">Loading…</div>
  {:else if !failures.length}
    <EmptyState icon="alert" title="No failures in range" message="Sessions that errored, hit a rate limit, or were truncated land here with their failure signal." error={res.error} onRetry={res.reload} />
  {:else}
    <div class="cap">{d?.total} failed session{d?.total === 1 ? "" : "s"} in range · showing {failures.length}</div>
    <div class="scroll">
      {#each failures as f (f.session_id)}
        <!-- Failures land on the Errors tab — for an errored session that's the
             parsed windows; rate-limited/truncated get the one-line failure note. -->
        <!-- ds-allow-native: clickable list row opening the session detail page, not a form-control button -->
        <button class="row rowbtn" type="button" title="Open session" onclick={() => navigate(`/session/${encodeURIComponent(f.session_id)}`, "?tab=errors")}>
          <span class="c-title" title={f.title ?? f.session_id}>{f.title ?? `session:${f.session_id.slice(0, 8)}`}</span>
          <span class="c-agent u-subtle">{AGENT_NAMES[f.agent] ?? f.agent}</span>
          <span class="c-out"><Badge tone={OUTCOME_TONE[f.outcome] ?? "default"}>{LABEL[f.outcome] ?? f.outcome}</Badge></span>
          <span class="c-err mono" class:bad={(f.error_count ?? 0) > 0}>{f.error_count ? `${f.error_count}✗` : ""}</span>
          <span class="c-when u-subtle mono">{relTime(f.started_at)}</span>
        </button>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .cap { font-size: 11.5px; color: var(--text-subtle); margin-bottom: 8px; }
  .scroll { max-height: 320px; overflow-y: auto; font-size: 12px; }
  .row {
    display: grid;
    grid-template-columns: 1fr 90px 84px 34px 56px;
    gap: 8px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  /* Rows open the session detail page (was a failures list you couldn't open). */
  .rowbtn {
    width: 100%;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rowbtn:hover { background: var(--surface-2); }
  .c-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
  .c-agent { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-err, .c-when { text-align: right; }
  .bad { color: var(--red); }
</style>
