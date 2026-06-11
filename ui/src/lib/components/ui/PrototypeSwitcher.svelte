<script lang="ts">
  import Icon from "./Icon.svelte";
  import { navigate, router } from "../../router.svelte";

  interface PrototypeVariant {
    key: string;
    label: string;
  }

  let {
    variants,
    current,
  }: {
    variants: PrototypeVariant[];
    current: string;
  } = $props();

  const isDev = import.meta.env.DEV;
  const currentIndex = $derived(Math.max(0, variants.findIndex((v) => v.key === current)));
  const currentLabel = $derived(variants[currentIndex]?.label ?? current);

  function setVariant(nextKey: string) {
    const params = new URLSearchParams(router.search);
    params.set("variant", nextKey);
    const search = `?${params.toString()}`;
    navigate(router.path, search);
  }

  function cycle(delta: number) {
    if (!variants.length) return;
    const next = (currentIndex + delta + variants.length) % variants.length;
    setVariant(variants[next]!.key);
  }

  function onKeydown(event: KeyboardEvent) {
    if (!isDev) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      cycle(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      cycle(1);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if isDev}
  <div class="switcher" role="group" aria-label="Prototype variants">
    <button type="button" aria-label="Previous variant" onclick={() => cycle(-1)}>
      <Icon name="arrow-left" size={15} />
    </button>
    <span class="label">{current} - {currentLabel}</span>
    <button type="button" aria-label="Next variant" onclick={() => cycle(1)}>
      <Icon name="arrow-right" size={15} />
    </button>
  </div>
{/if}

<style>
  .switcher {
    position: fixed;
    left: 50%;
    bottom: 18px;
    z-index: 120;
    display: flex;
    align-items: center;
    gap: 10px;
    transform: translateX(-50%);
    padding: 8px;
    border: 1px solid var(--border-glow);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 92%, black);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.34);
  }
  button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    background: var(--surface);
  }
  button:hover {
    color: var(--text);
    border-color: var(--accent-from);
  }
  .label {
    min-width: 178px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .switcher {
      right: 12px;
      left: 12px;
      transform: none;
      justify-content: space-between;
    }
    .label {
      min-width: 0;
      white-space: normal;
    }
  }
</style>
