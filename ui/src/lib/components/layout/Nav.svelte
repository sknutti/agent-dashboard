<script lang="ts">
  import Icon from "../ui/Icon.svelte";
  import { ROUTES, router, navigate } from "../../router.svelte";
</script>

<nav class="sidebar">
  <div class="brand">
    <span class="logo"><Icon name="gauge" size={18} stroke={2.2} /></span>
    <span class="brand-text">
      <span class="brand-name">Command Centre</span>
      <span class="brand-sub mono">phase 0 · foundation</span>
    </span>
  </div>

  <ul class="links">
    {#each ROUTES as r (r.path)}
      <li>
        <button
          class="link"
          class:active={router.path === r.path}
          onclick={() => navigate(r.path)}
          aria-current={router.path === r.path ? "page" : undefined}
        >
          <Icon name={r.icon} size={17} />
          <span>{r.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="foot">
    <p class="mono">localhost · zero outbound</p>
  </div>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 230px;
    flex: none;
    height: 100dvh;
    position: sticky;
    top: 0;
    padding: 22px 14px;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 55%, transparent);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 4px 8px 22px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    color: #fff;
    background: var(--accent-gradient);
    flex: none;
    box-shadow: 0 4px 16px color-mix(in srgb, var(--accent-from) 40%, transparent);
  }
  .brand-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .brand-name {
    font-size: 13.5px;
    font-weight: 650;
  }
  .brand-sub {
    font-size: 10px;
    color: var(--text-subtle);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .link {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 9px 10px;
    border: none;
    border-radius: 9px;
    background: none;
    color: var(--text-dim);
    font-size: 13.5px;
    font-weight: 500;
    transition: all 0.15s var(--ease);
  }
  .link:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .link.active {
    color: var(--text);
    background: color-mix(in srgb, var(--accent-from) 16%, transparent);
  }
  .link.active :global(svg) {
    color: var(--accent-from);
  }
  .foot {
    margin-top: auto;
    padding: 8px;
  }
  .foot p {
    margin: 0;
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-subtle);
  }
</style>
