<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  let {
    title,
    kicker,
    description,
    icon,
    children,
    actions,
    footer,
    class: cls = "",
  }: {
    title?: string;
    kicker?: string;
    description?: string;
    icon?: string;
    children?: Snippet;
    actions?: Snippet;
    footer?: Snippet;
    class?: string;
  } = $props();
</script>

<section class="card {cls}">
  {#if title || kicker || actions}
    <header class="card-head">
      <div class="head-text">
        {#if kicker}<p class="kicker">{kicker}</p>{/if}
        {#if title}
          <h3 class="card-title">
            {#if icon}<Icon name={icon} size={15} />{/if}
            {title}
          </h3>
        {/if}
        {#if description}<p class="card-desc">{description}</p>{/if}
      </div>
      {#if actions}<div class="head-actions">{@render actions()}</div>{/if}
    </header>
  {/if}

  <div class="card-body">
    {#if children}{@render children()}{/if}
  </div>

  {#if footer}<footer class="card-foot">{@render footer()}</footer>{/if}
</section>

<style>
  .card {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad);
    transition: border-color 0.2s var(--ease);
  }
  .card:hover {
    border-color: var(--border-glow);
  }
  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  .head-text {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  .card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .card-title :global(svg) {
    color: var(--text-dim);
    flex: none;
  }
  .card-desc {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .head-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-body {
    flex: 1;
    min-width: 0;
  }
  .card-foot {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
</style>
