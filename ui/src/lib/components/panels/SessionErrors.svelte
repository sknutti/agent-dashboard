<script lang="ts">
  // Parsed Errors view (ADR-0005). For each errored tool call in a session, shows
  // the failing input + captured error text wrapped in a ±N readable-message
  // context window, fetched on demand from /api/sessions/:id/errors. Three states:
  // unsupported agent / missing log (a note → Messages), a non-errored Failure
  // (one-line explanation → Messages), and the populated windows. Red is ALWAYS
  // paired with the ✗ glyph (colorblind rule), reusing the .xmark convention.
  import { getSessionErrors, type DisplayMessage, type ErrorContext } from "../../api";
  import { resource } from "../../resource.svelte";
  import { navigate } from "../../router.svelte";
  import { readableInput } from "../../transcript";

  let { sessionId }: { sessionId: string } = $props();

  const res = resource(() => `errors:${sessionId}`, () => getSessionErrors(sessionId));
  const data = $derived(res.data);

  // The endpoint returns ~3 before / ~2 after; collapse to the rows NEAREST the
  // failure and let the reader grow the slice client-side (no extra fetch).
  const COLLAPSED_BEFORE = 1;
  const COLLAPSED_AFTER = 1;
  let expanded = $state<Record<number, boolean>>({});

  const beforeRows = (e: ErrorContext, i: number): DisplayMessage[] =>
    expanded[i] ? e.before : e.before.slice(-COLLAPSED_BEFORE);
  const afterRows = (e: ErrorContext, i: number): DisplayMessage[] =>
    expanded[i] ? e.after : e.after.slice(0, COLLAPSED_AFTER);
  const hiddenCount = (e: ErrorContext): number =>
    Math.max(0, e.before.length - COLLAPSED_BEFORE) + Math.max(0, e.after.length - COLLAPSED_AFTER);

  function toMessages(): void {
    navigate(`/session/${sessionId}`, "?tab=messages");
  }
</script>

{#snippet ctxRow(m: DisplayMessage)}
  <div class="ctx" class:tool={m.role === "tool"}>
    <span class="role">{m.role}</span>
    {#if m.role === "tool"}
      <span class="ctx-tool">{m.toolName}{#if m.isError} <span class="xmark">✗</span>{/if}</span>
    {/if}
    <span class="text">{m.text}</span>
  </div>
{/snippet}

<div class="errors-view">
  {#if res.loading && !data}
    <div class="note muted">Loading parsed errors…</div>
  {:else if res.error || !data}
    <div class="note">
      Couldn't load the parsed error view.
      <button class="link" onclick={toMessages}>Open Messages</button>
    </div>
  {:else if !data.supported}
    <div class="note">
      {data.note ?? "Parsed error view is unavailable for this agent."}
      <button class="link" onclick={toMessages}>Open Messages</button>
    </div>
  {:else if data.failureNote}
    <div class="note">{data.failureNote}</div>
  {:else if !data.errors || data.errors.length === 0}
    <div class="note muted">No errored tool calls in this session.</div>
  {:else}
    <div class="list">
      {#each data.errors as e, i (i)}
        <article class="card">
          {#each beforeRows(e, i) as m, j (`b${j}`)}{@render ctxRow(m)}{/each}

          <div class="error">
            <div class="head">
              <span class="xmark" title="errored tool call">✗</span>
              <span class="tool mono">{e.toolName}</span>
            </div>
            {#if e.toolInput}<pre class="input mono">{readableInput(e.toolInput)}</pre>{/if}
            {#if e.errorText}<pre class="err-text mono">{e.errorText}</pre>{/if}
          </div>

          {#each afterRows(e, i) as m, j (`a${j}`)}{@render ctxRow(m)}{/each}

          {#if hiddenCount(e) > 0}
            <button class="expand" onclick={() => (expanded[i] = !expanded[i])}>
              {expanded[i]
                ? "Show less context"
                : `Show ${hiddenCount(e)} more context message${hiddenCount(e) === 1 ? "" : "s"}`}
            </button>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .errors-view {
    height: 100%;
    overflow-y: auto;
    padding: 16px 24px;
  }
  .note {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }
  .note.muted { color: var(--text-subtle); }
  .link {
    color: var(--cyan);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:hover { color: var(--text); }

  .list { display: flex; flex-direction: column; gap: 18px; }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }

  .ctx {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 6px;
    font-size: 12px;
    color: var(--text-subtle);
    border-left: 2px solid var(--border);
  }
  .ctx.tool { color: var(--text-dim); }
  .role {
    flex: none;
    min-width: 64px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-subtle);
  }
  .ctx-tool { flex: none; color: var(--text-dim); font-weight: 560; }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 4.5em;
    overflow: hidden;
  }

  .error {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--red) 40%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--red) 6%, var(--surface));
  }
  .head { display: flex; align-items: center; gap: 8px; }
  /* Explicit ✗ glyph so an errored row is never signalled by red colour alone
     (Scott is red/green colourblind). Reuses the .xmark convention from DrillSheet. */
  .xmark { color: var(--red); font-weight: 700; }
  .tool { font-size: 13px; font-weight: 650; color: var(--text); }
  .input, .err-text {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg, #0a0a0f);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 14em;
    overflow: auto;
  }
  .input { color: var(--text-dim); }
  .err-text { color: color-mix(in srgb, var(--red) 70%, var(--text)); }

  .expand {
    align-self: flex-start;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .expand:hover { color: var(--text); border-color: var(--border-glow); }
  .mono { font-family: var(--mono, ui-monospace, monospace); }
</style>
