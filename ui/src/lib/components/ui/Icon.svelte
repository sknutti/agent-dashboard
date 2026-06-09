<script lang="ts">
  import { ICONS } from "../../icons";

  let {
    name,
    size = 16,
    stroke = 2,
    class: cls = "",
  }: { name: string; size?: number; stroke?: number; class?: string } = $props();
</script>

<svg
  class={cls}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {@html ICONS[name] ?? ""}
</svg>
