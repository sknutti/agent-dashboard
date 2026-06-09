# Gotchas

## Two latent Phase-1 bugs surfaced when Codex (2nd agent) landed
- Adding a 2nd agent exposed two single-agent assumptions invisible while Claude was
  the only agent (filter == total). BOTH were UI/aggregation, NOT the adapter seam:
  1. `BurnPanel.svelte` hardcoded the agent dropdown to `[all, claude_code]` → now
     data-driven from `getAgents` (agents with sessions>0).
  2. `routes.ts /api/burn` applied the `claude_code.cost.usage` OTEL native overlay
     UNCONDITIONALLY, so Claude's native $ bled into a Codex-filtered burn view.
     Fixed: overlay only when `agent === null || agent === "claude_code"`. The OTEL
     native metric is Claude-specific — any per-agent native overlay must be scoped
     to its agent. (Watch this in Phase 3: Pi has per-MESSAGE native in JSONL, a
     different path — don't route it through the Claude OTEL overlay.)
- Lesson: when adding agent N+1, audit every per-agent FILTER path (dropdowns,
  cross-agent overlays/totals), not just the ingest adapter.

## Codex token buckets OVERLAP — normalize to disjoint (Phase 2)
- Codex's cumulative `total_token_usage` buckets are NOT disjoint like Claude's:
  validated 300/300 files that `total_tokens == input_tokens + output_tokens`,
  `cached_input_tokens ⊆ input_tokens`, `reasoning_output_tokens ⊆ output_tokens`.
- The schema + cost engine assume DISJOINT buckets (`total = Σ buckets`, each bucket
  priced additively). `adapters/codex.ts` therefore subtracts: `input -= cached`,
  `output -= reasoning`, `cacheRead = cached`, `reasoning` kept, `cacheCreate = 0`.
  Mapping raw values would DOUBLE-price cached + reasoning tokens. Don't "simplify"
  by passing the raw fields.
- Use the LAST `token_count` whose `payload.info` is non-null (the FIRST token_count
  record carries `info: null`). 6/306 files have no token_count at all → 0 tokens,
  est cost NULL (handled).
- Codex `error_count` = count of `exec_command_end.exit_code ≠ 0` (181 in the test
  set). This is the SAME semantic as Claude's `tool_result.is_error` count, so a
  grep/test that exits non-zero flags the session 'errored' for BOTH agents — by
  design, consistent with `OUTCOME_CASE` in routes.ts. Not a Codex-only quirk.

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

## Pi (Phase 3): buckets DISJOINT, native==est, branchCount counts MESSAGES only
- **Disjoint buckets — the INVERSE of Codex.** Pi's `message.usage` is
  `{input, output, cacheRead, cacheWrite, totalTokens}` and validated 285/285
  assistant rows that `totalTokens == input+output+cacheRead+cacheWrite` with
  cacheRead ADDED on top of input (not a subset). So `adapters/pi.ts` maps the four
  buckets DIRECTLY (cacheWrite→cacheCreate), NO Codex-style `input -= cached`.
  Copying codex.ts's subtraction here would undercount. Don't.
- **Pi native USD == rack-rate estimate, exactly** ($8.3512575 both, delta 0).
  Pi is a multi-PROVIDER client (openai-codex/gpt-5.4 dominates; also bedrock
  opus-4-6, gemini-3.1-pro-preview) and its per-message `usage.cost.total` is
  computed at the provider's METERED LIST rate — the same rates in prices.yaml.
  So Pi's "subscription-savings delta" (native − estimated) is genuinely ~$0,
  unlike Claude (subscription billing → native < rack-rate → real savings). The
  dual-cost machinery is reused correctly; it just resolves to zero. NOT a bug —
  don't contrive a delta. gemini-3.1-pro-preview is left UNPRICED (never-guess
  rule); its 2 rows still carry exact native cost, only the estimate is NULL.
- **branchCount must count MESSAGE-record tips only.** Every record has `{id,
  parentId}`, but the `session` record is a disconnected ISLAND (the real chain
  starts at a `model_change` with parentId null) and control records
  (model_change/thinking_level_change) are a preamble. Counting any non-message
  node as a "tip" (id never used as a parentId) over-reports every linear session
  as 2. Fix: tip candidates = `message` ids only; collect parentId refs from all
  records. Real data is 100% linear (zero parentId fan-out) → branchCount=1.
- **Branch summation needs NO tree traversal.** Master §10.6's "sum all branches"
  is satisfied by emitting one `tokens` event per assistant ROW (unique `id`,
  counted once regardless of branch topology). Never traverse leaf-paths — that's
  the double-counting hazard. Proven by `adapters/pi.test.ts` on a synthetic
  multi-branch fixture (real data can't exercise it).
- Latent (not hit): the all-agents `/api/burn` overlay gates Claude's OTEL native
  on `d.nativeUsd == null`; now that Pi populates `burn_daily.cost_usd`, a date
  shared by a Pi session AND a Claude-OTEL day would drop Claude's OTEL native.
  No collision today (Pi data Mar–Apr, Claude OTEL June). Watch if Pi runs live.

## Schema init ownership: getDb() inits, openDb() does NOT
- `scripts/db.ts`: `openDb()` only opens a WAL connection; `getDb()` opens +
  runs `initSchema()` (thread-local singleton). Any entrypoint that touches the
  DB standalone (worker `--once`, doctor) must use `getDb()`, or it hits
  "no such table". CREATE TABLE IF NOT EXISTS is idempotent + WAL-safe, so the
  worker re-initing alongside the server is fine.
