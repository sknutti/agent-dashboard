import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Built to ui/dist and served as static by the Hono server. During UI dev,
// `bun run dev:ui` runs Vite on :5173 and proxies /api + /v1 to the live
// Command Centre server on :8765.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/v1": "http://127.0.0.1:8765",
    },
  },
});
