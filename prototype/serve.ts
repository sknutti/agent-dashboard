// PROTOTYPE server — throwaway. Run: bun agent-dashboard/prototype/serve.ts
// Serves the single-file UI prototype on http://localhost:4321
const html = await Bun.file(new URL("./dashboard-prototype.html", import.meta.url)).text();
const port = 4321;
Bun.serve({
  port,
  fetch() {
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`▶ Command Centre UI prototype → http://localhost:${port}/?variant=A  (variants: A, B, C)`);
