# Gotchas

## esbuild binary fails to install (corporate registry) + Svelte 5 incompat
- `bun install` in `ui/` 403s on scoped `@esbuild/darwin-arm64` from the default
  (corporate jfrog) registry → Vite build dies with "host version does not match
  binary version" or "could not be found".
- **Fix (committed):** `ui/bunfig.toml` scopes `@esbuild` to `https://registry.npmjs.org`.
  After that a clean `bun install --force` resolves the binary matching Vite's
  esbuild host (currently 0.25.12).
- **Do NOT** "fix" it by pinning esbuild to 0.28.0 — that version has a
  destructuring-downlevel regression that breaks Svelte 5's runtime at build.
- `*.lock` and any path containing `/bin/` are blocked by the damage-control
  hook; can't `rm bun.lock` (use `bun install --force`) or `rm ~/.local/bin/cc`.

## `*/` inside a `/** */` or `/* */` comment closes it early (hit twice)
- Writing a glob/path like `projects/*/<sid>` or `*/*.jsonl` inside a JSDoc/SQL
  block comment ends the comment at the `*/`, producing baffling "Unexpected ."
  parse errors a few lines later. `bun build <file>` shows the true line; the LSP
  diagnostics can lag and point at stale lines. Fix: reword the comment to avoid
  a literal `*/` (template literals/strings are fine — only comments break).

## Svelte 5 `resource()` key must be a function getter, not a string
- `lib/resource.svelte.ts` calls `key()` inside `$effect`. Passing a bare string
  (`resource("summary", …)`) makes `"summary"()` throw `TypeError: e is not a
  function` during the reactive flush, which **aborts the whole page's flush** —
  every panel freezes on "Loading…" and even unrelated components (health strip)
  stall. Hardened to accept `string | (() => string)`, but prefer the getter form.
  A single bad call site can take down an entire route; suspect it on mass "Loading…".

## Claude Code native cost (`total_cost_usd`) is NOT in interactive JSONL
- Phase-1 spec says "native cost from `result.total_cost_usd`", but interactive
  `~/.claude/projects/*/*.jsonl` sessions on this machine carry `total_cost_usd`
  only as a top-level **null** key (no `result`-type line at all). It is populated
  only by `claude -p` / print-mode SDK runs.
- Consequence: for the bulk of Claude sessions, **native cost comes from the OTEL
  `claude_code.cost.usage` metric, not JSONL.** The adapter still reads
  `result.total_cost_usd` when present (rare), else leaves `cost_usd` NULL.
  Rack-rate `cost_estimated_usd` (always computed from tokens) is the figure that
  always exists; "subscription savings" (native − estimated) only appears once OTEL
  is on. This is consistent with the OTEL-first / JSONL-fallback rule (master §12.3).

## Real model IDs in the JSONL (drives prices.yaml)
- Assistant lines carry `.message.model`. On this machine the real distribution is
  `claude-opus-4-7` (dominant), `claude-opus-4-8`, and a `<synthetic>` pseudo-model
  (quota/synthetic responses — must stay **unpriced → cost NULL**, never guess a rate).
- Token usage lives on assistant lines at `.message.usage`:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` (Claude has **no separate reasoning-token count** —
  thinking is folded into output; `reasoning_tokens` stays NULL for Claude).
- Tool calls: `tool_use` blocks on assistant lines (`{name,id}`); `tool_result`
  blocks on **user** lines (`{tool_use_id, is_error, content}`). MCP tools are named
  `mcp__<server>__<tool>`. Session title = `ai-title` line's `.aiTitle`.
- Spec glob `*/*.jsonl` captures the 228 main sessions; subagent transcripts live
  deeper at `<proj>/<sid>/subagents/agent-*.jsonl` (Phase 5, out of Phase-1 scope).

## Schema init ownership: getDb() inits, openDb() does NOT
- `scripts/db.ts`: `openDb()` only opens a WAL connection; `getDb()` opens +
  runs `initSchema()` (thread-local singleton). Any entrypoint that touches the
  DB standalone (worker `--once`, doctor) must use `getDb()`, or it hits
  "no such table". CREATE TABLE IF NOT EXISTS is idempotent + WAL-safe, so the
  worker re-initing alongside the server is fine.
