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

## /api/burn coerced unpriced est to $0 (latent, surfaced by Antigravity)
- `routes.ts /api/burn` summed daily estimate with `estUsd += cost_estimated_usd ?? 0`,
  so a day with NO priced rows reported `estUsd: 0` → the Burn panel rendered "**$0**
  est" (a FABRICATED money figure) while the AgentCard correctly showed "—". Invisible
  for the first 3 agents (Claude/Codex/Pi all have ≥1 priced model/day, so est was never
  a whole-day NULL); Antigravity is the FIRST uniformly-UNPRICED agent (gemini-3-flash-a),
  so it's the first to expose it — same "agent N+1 surfaces a latent single-/priced-agent
  assumption" pattern as the Phase-2/3 burn bugs. Fix: make `estUsd` NULL-preserving,
  EXACTLY mirroring `nativeUsd` (`if (cost_estimated_usd != null) estUsd = (estUsd ?? 0)
  + …`); `totalEst` = null when every day is unpriced. `usd(null)` already renders "—".
  ADR-0002: an unpriced figure is "—" (unknown), NEVER "$0" (a claim it's free).

## Antigravity (Phase 4): reading another app's WAL .db needs `immutable=1`
- Antigravity tokens live in a protobuf BLOB in `conversations/<conv>.db` (table
  `gen_metadata`), and those DBs are **WAL mode**. `new Database(path,{readonly:true})`
  throws **SQLITE_CANTOPEN** on a WAL file with no live `-wal` sidecar (bun:sqlite).
  Plain RW open throws SQLITE_MISUSE; `Database.deserialize(readFileSync)` also
  CANTOPENs (WAL file header). The ONE mode that works AND doesn't mutate the user's
  DB: the URI form `new Database(\`file:${encodeURI(path)}?immutable=1\`)` — no locks,
  no -wal/-shm created, treats the file as read-only immutable (reads a checkpointed
  snapshot; live -wal data is ignored, fine for an observability re-read each tick).
- **Token field map (gen_metadata BLOB, path top→f1→f4):** input = f1(system)+f2(ctx)+
  f6(overhead); f3 = total output with the invariant **f3 == f9+f10 (verified 89/89
  on this machine)**. We split disjointly: `reasoning = f9`, `output = f10` (so schema
  total = input+output+reasoning = input+f3 — the extractor's anchor). f9/f10 LABELS
  and f1-as-cache are INFERRED (gap #2) — surface input/total as solid, don't over-claim.
  Model id is a string at **top→f1→f19** (`gemini-3-flash-a`); pinned but UNPRICED (no
  Gemini rate in prices.yaml, never-guess) → both cost columns NULL = "model known,
  money-blind" (NOT "model unknown"). Verified vs `docs/antigravity_token_extractor.py`:
  in=618135, out+reason=22559, total=640694, exact.
- **Glob the .db, NOT the transcript** (departs from phase-4 doc's literal transcript
  glob). The .db basename = conv-id = session_id (clean id) AND is the token source;
  the transcript (`brain/<conv>/.system_generated/logs/transcript_full.jsonl`) is a
  SIBLING resolved for tools/latency. Globbing `transcript_full.jsonl` would collide
  (every file same basename → orchestrator's basename-keyed reparse gate can't tell
  sessions apart) and miss any .db-only conv. Cost: the .db basename (`<conv>.db`) ≠
  session_id (`<conv>`), so `reparseDecision` never short-circuits → antigravity
  re-parses **every tick**. Harmless at 2–3 sub-MB files; did NOT touch the shared
  gate (no regression risk to the other 3 agents).
- **Tool latency** = `created_at` delta between a `PLANNER_RESPONSE` step (carries
  `tool_calls:[{name}]`) and the very next step (the execution). No explicit durations;
  status is always `DONE` → errorCount stays 0 (no error signal in the transcript).
- **Empty/aborted conv** (0 gen rows AND no transcript, e.g. `8217e2ca`) → adapter
  yields nothing → no session row (parseAndWrite skips on `!agg.meta`). cwd ←
  `trajectory_metadata_blob` `file://` URI (decode via the same protobuf reader for
  exact length-delimited bounds; greedy regex over-captures the next tag byte).

## SSE streams die at 10s: Bun.serve idleTimeout closes idle connections (Phase 5)
- An SSE route that replays a backlog then goes quiet (sleeping, writing nothing)
  is closed by `Bun.serve` after its default **10s `idleTimeout`** → the browser
  reports `net::ERR_INCOMPLETE_CHUNKED_ENCODING`, EventSource auto-reconnects,
  the server re-replays its backlog, and (if the `{#each}` keys on event id) the
  re-arriving rows trigger a **`each_key_duplicate`** error burst. One root cause
  (idle close), two symptoms (reconnect storm + dup keys). Diagnosed via the
  server log line `[Bun.serve]: request timed out after 10 seconds`.
- Fix: write a **keepalive every loop tick** (`/api/firehose` sends
  `{event:"keepalive"}` each 1.5s idle tick) so bytes keep flowing < 10s; writes
  reset the idle timer. Plus client-side **dedupe by id** in `firehose.svelte.ts`
  (a `Set` of seen ids) so any future reconnect replay can't dup keys.
- **Same shape, also fixed:** `/api/sessions/live/:sid/stream` (Phase 1) only
  wrote when the JSONL file grew — a session idle >10s dropped identically. Now
  carries the same idle-tick keepalive (offset-unchanged → emit keepalive).

## Schema init ownership: getDb() inits, openDb() does NOT
- `scripts/db.ts`: `openDb()` only opens a WAL connection; `getDb()` opens +
  runs `initSchema()` (thread-local singleton). Any entrypoint that touches the
  DB standalone (worker `--once`, doctor) must use `getDb()`, or it hits
  "no such table". CREATE TABLE IF NOT EXISTS is idempotent + WAL-safe, so the
  worker re-initing alongside the server is fine.

## Claude JSONL repeats `usage` per content-block line → 2× token over-count
- Claude Code splits ONE assistant message (one API response: one `message.id` +
  `requestId`) across MULTIPLE JSONL lines — one per content block (thinking /
  text / tool_use) — and **every line repeats the identical full `usage` block**.
  Summing all lines (the original adapter) over-counts by the block count.
- **Measured on this machine (2026-06-10): 219/236 files affected, claude
  `total_tokens` 3.66B reported vs 1.76B true — 51.9% phantom.** Rack-rate cost
  was inflated proportionally.
- Fix (`adapters/claude_code.ts`): dedupe the `kind:"tokens"` emit by
  `${message.id}|${requestId}` (a `seenUsageKeys` Set), like ccusage. Still
  process content blocks / tool pairing on every line — the tool_use block lives
  on the message's LAST split line, so only the token emit is deduped, not the
  line. Lines with neither id nor requestId can't be deduped → always counted.
  First test for the reference adapter: `adapters/claude_code.test.ts`.
- **Operational:** an adapter parsing-logic change does NOT auto-correct already-
  ended sessions (the mtime gate won't re-parse them). Force once with
  `UPDATE sessions SET synced_at=NULL WHERE agent='claude_code'` then `bun run sync`.

## resource.svelte.ts — NEVER read reactive state inside the $effect's run() path
- **Froze the entire app** (blank page, NO console error — a frozen main thread).
  `resource()` runs `run()` synchronously inside its `$effect`. Batch 8 added
  `if (state.data === null) state.loading = true` to avoid skeleton flicker — that
  READ of `state.data` made it a DEPENDENCY of the effect. The fetch `.then` SETS
  `state.data` → effect re-runs → refetch → set → ∞. Because each cycle crosses a
  fetch `.then` (microtask), Svelte's SYNC effect-depth guard never trips, so it
  spins SILENTLY instead of throwing `effect_update_depth_exceeded`.
- **Rule:** inside the `$effect`/`run()` path, only READ keyFn() + dataEpoch (the
  intended deps) and WRITE state. The "first load?" gate must be a plain closure
  flag (`loadedOnce`), never a read of `state.data`/`state.loading`/`state.error`.
- **Debugging without a browser** (Chrome is TCC-blocked from localhost on this
  Mac): mount the built bundle in `@happy-dom/global-registrator` headlessly;
  bisect real-vs-`{}`-stubbed fetch to prove data-triggered; trip-wire
  `Array.prototype.push` at ~2M calls to catch a silent spin's stack; build with
  `build.sourcemap=true` + `source-map` pkg to resolve minified frames to source.
- No Svelte-runes unit-test seam exists (bun test can't compile `.svelte.ts`); a
  vitest + @testing-library/svelte harness would let this be locked with a test.
