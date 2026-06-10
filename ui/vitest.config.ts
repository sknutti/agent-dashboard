import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Svelte-runes unit test harness (separate from the build config so it never
// touches `vite build`). The svelte plugin compiles `*.svelte.ts` and
// `*.svelte.test.ts` files so $state/$effect/$derived work inside tests; jsdom
// gives effects a DOM to run against; the `browser` condition makes `svelte`
// resolve to its client runtime rather than the SSR build.
//
// Test files that use runes MUST be named `*.svelte.test.ts` (the plugin only
// compiles runes in `.svelte`/`.svelte.[jt]s` files). Use `flushSync` +
// `$effect.root` from "svelte" to drive effects synchronously (see
// resource.svelte.test.ts).
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{js,ts}"],
  },
});
