<script lang="ts">
  // Parsed Messages view (ADR-0006, layout C). For an ENDED session it renders the
  // whole parsed Transcript as grouped-turn Message cards: each user prompt heads a
  // turn, with the agent's thinking / assistant / tool Messages nested beneath on a
  // left-gutter timeline. A still-LIVE session keeps the unchanged raw byte-tail
  // (SessionFeed) — the tab auto-branches on `data.live`, no raw/cards toggle.
  // Errored tool cards pair red with the ✗ glyph (colorblind rule); the role dots
  // use the luminance-ordered token palette, no red/green pairing.
  import { Button, Callout } from "../ui";
  import { getSessionMessages, type DisplayMessage } from "../../api";
  import { resource } from "../../resource.svelte";
  import { groupTurns, readableInput } from "../../transcript";
  import { relTime } from "../../format";
  import SessionFeed from "./SessionFeed.svelte";

  let { sessionId }: { sessionId: string } = $props();

  const res = resource(() => `messages:${sessionId}`, () => getSessionMessages(sessionId));
  const data = $derived(res.data);
  const turns = $derived(data && !data.live && data.messages ? groupTurns(data.messages) : []);

  // Long output is clamped with a max-height; the reader expands per entry. Gate the
  // toggle on text shape (no DOM measurement needed) — long body or many lines.
  let expanded = $state<Record<string, boolean>>({});
  const isLong = (s: string): boolean => s.length > 320 || (s.match(/\n/g)?.length ?? 0) > 6;
</script>

{#snippet entryCard(e: DisplayMessage, key: string)}
  <div class="entry" class:errored={e.role === "tool" && e.isError}>
    <span class="dot {e.role}" aria-hidden="true"></span>
    <article class="card">
      <header class="card-head">
        <span class="role-label">{e.role}</span>
        {#if e.role === "tool"}
          <span class="tool-name mono">{e.toolName}</span>
          {#if e.isError}<span class="xmark" title="errored tool call">✗</span>{/if}
        {/if}
        {#if e.ts}<time class="ts">{relTime(e.ts)}</time>{/if}
      </header>

      {#if e.role === "tool"}
        {#if e.toolInput}<pre class="input mono">{readableInput(e.toolInput)}</pre>{/if}
        {#if e.text}
          <pre class="output mono" class:clamped={isLong(e.text) && !expanded[key]}>{e.text}</pre>
          {#if isLong(e.text)}
            <Button size="sm" class="expand" onclick={() => (expanded[key] = !expanded[key])}>
              {expanded[key] ? "Show less" : "Show more"}
            </Button>
          {/if}
        {/if}
      {:else}
        <div class="text" class:clamped={isLong(e.text) && !expanded[key]}>{e.text}</div>
        {#if isLong(e.text)}
          <Button size="sm" class="expand" onclick={() => (expanded[key] = !expanded[key])}>
            {expanded[key] ? "Show less" : "Show more"}
          </Button>
        {/if}
      {/if}
    </article>
  </div>
{/snippet}

<div class="messages-view">
  {#if res.loading && !data}
    <Callout>Loading messages…</Callout>
  {:else if res.error || !data}
    <Callout>Couldn't load the parsed messages for this session.</Callout>
  {:else if data.live}
    <!-- Still live: the unchanged raw byte-tail (its own SSE lifecycle). -->
    <SessionFeed {sessionId} fill />
  {:else if !data.supported}
    <!-- This IS the Messages tab, so no "open Messages" affordance — just the note. -->
    <Callout>{data.note ?? "Parsed message view is unavailable for this session."}</Callout>
  {:else if turns.length === 0}
    <Callout>No messages in this session.</Callout>
  {:else}
    <div class="turns">
      {#each turns as turn, ti (ti)}
        <section class="turn">
          {#if turn.prompt}
            {@const pkey = `p${ti}`}
            <div class="prompt">
              <span class="dot user" aria-hidden="true"></span>
              <div class="prompt-body">
                <div class="prompt-row">
                  <div class="prompt-text" class:clamped={isLong(turn.prompt.text) && !expanded[pkey]}>{turn.prompt.text}</div>
                  {#if turn.prompt.ts}<time class="ts">{relTime(turn.prompt.ts)}</time>{/if}
                </div>
                {#if isLong(turn.prompt.text)}
                  <Button size="sm" class="expand" onclick={() => (expanded[pkey] = !expanded[pkey])}>
                    {expanded[pkey] ? "Show less" : "Show more"}
                  </Button>
                {/if}
              </div>
            </div>
          {/if}
          {#if turn.entries.length}
            <div class="timeline">
              {#each turn.entries as e, ei (ei)}
                {@render entryCard(e, `${ti}-${ei}`)}
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .messages-view {
    height: 100%;
    overflow-y: auto;
    padding: 16px 24px;
  }
  .turns { display: flex; flex-direction: column; gap: 22px; }
  .turn { display: flex; flex-direction: column; gap: 10px; }

  /* Prompt heads the turn. */
  .prompt {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .prompt-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .prompt-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .prompt-text {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-size: 13.5px;
    font-weight: 560;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Left-gutter timeline holding the nested entries. */
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-left: 5px;
    padding-left: 18px;
    border-left: 2px solid var(--border);
  }
  .entry {
    display: flex;
    gap: 10px;
    position: relative;
  }
  /* Type dot, sitting on the gutter line. Luminance-ordered palette — decodable by
     brightness + hue, never red/green (Scott's colorblind rule). */
  .dot {
    flex: none;
    width: 9px;
    height: 9px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--text-subtle);
  }
  .entry .dot { margin-left: -24px; }
  .dot.user { background: var(--cyan); }
  .dot.assistant { background: var(--accent-to); }
  .dot.thinking { background: var(--tok-reasoning); }
  .dot.tool { background: var(--text-dim); }

  .card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }
  /* Errored tool: red is ALWAYS paired with the ✗ glyph + tinted border, never
     colour alone (colorblind rule), mirroring the Errors view. */
  .entry.errored .card {
    border-color: color-mix(in srgb, var(--red) 40%, var(--border));
    background: color-mix(in srgb, var(--red) 6%, var(--surface));
  }
  .card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .role-label {
    flex: none;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-subtle);
  }
  .tool-name { font-size: 12.5px; font-weight: 650; color: var(--text); }
  .xmark { color: var(--red); font-weight: 700; }
  .ts {
    margin-left: auto;
    flex: none;
    font-size: 10.5px;
    color: var(--text-subtle);
  }

  .text {
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .input, .output {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .input { color: var(--text-dim); }
  .output { color: var(--text-subtle); }
  /* Clamp long content and fade the cut-off edge to transparent (masks the text
     itself, so it works over any card background) — a softer "there's more" cue
     than a hard clip; the Show more toggle reveals the rest. */
  .clamped {
    max-height: 14em;
    overflow: hidden;
    /* Alpha-only mask ramp: the colour channel is irrelevant (only the opaque →
       transparent alpha matters); use the floating-surface token as the opaque
       anchor so no raw hex lives in <style> (design-system gate). */
    -webkit-mask-image: linear-gradient(to bottom, var(--surface-floating) 70%, transparent);
    mask-image: linear-gradient(to bottom, var(--surface-floating) 70%, transparent);
  }

  /* The expand toggle (a Button) must not stretch in its flex-column parent. */
  .card :global(.expand),
  .prompt-body :global(.expand) {
    align-self: flex-start;
  }
  .mono { font-family: var(--mono, ui-monospace, monospace); }
</style>
