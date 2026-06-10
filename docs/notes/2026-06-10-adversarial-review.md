# Adversarial review — 2026-06-10

Five parallel adversarial reviewers (correctness, security, reliability/perf, architecture/types, product/UX).
Everything below was verified against code, not docs. Synthesis in the conversation; this is the full record.

## Critical — the dashboard shows wrong money/token numbers

1. **Native-cost merge is first-non-null, not per-source-per-agent** (`routes.ts:107-108`, `routes.ts:404-425`, `sync_agents.ts:133-141`).
   One `claude -p` print-mode session ($0.42 JSONL cost) on a day with $35 of OTEL native cost → SUM(cost_usd) is
   non-null ($0.42) → the OTEL overlay (`if (d.nativeUsd == null)`) is suppressed. Day shows $0.42 native instead of $35.
   Same shape at range level on AgentCard. Cross-agent variant: with agent=all, any date where Pi spent $0.01 blocks
   Claude's OTEL overlay for that date. Fix: merge per-agent (OTEL-vs-JSONL exclusive per agent, additive across agents).

2. **Claude resume/continue double-counts tokens** (`claude_code.ts:122-159`). `--resume`/`--continue` writes a new
   <uuid>.jsonl replaying prior usage lines; adapter sums every assistant usage block with no message.id/requestId dedup
   → two session rows each carrying the full original usage; rollups SUM both. Resume twice → triple. Also intra-file
   duplicate assistant messages (the reason ccusage dedupes). No claude_code.test.ts exists. Confidence 0.7 — verify
   against a real resumed session first.

3. **Antigravity tokens vanish when transcript is missing** (`antigravity.ts:263-319,390-399`; `sync_agents.ts:123-128,139`;
   `routes.ts:39-41`). No transcript → started_at NULL → excluded by `WHERE started_at IS NOT NULL` in both rollups and
   by every DATE(started_at) range predicate. Exact decoded tokens exist in sessions row but appear in zero aggregates,
   lists, charts. The .db glob exists precisely to not lose these conversations — then the orchestrator loses them.

4. **Re-parse gate is defeated for 3 of 4 agents** (`sync_agents.ts:276-281`) — found independently by three reviewers.
   Gate keys on basename minus `.jsonl`; Codex (`rollout-<ts>-<uuid>`), Pi (`<ts>_<uuid>`), Antigravity (`.db`) never
   match their session_ids. Smoking gun: tool_calls has 16,054 rows but MAX(id) ≈ 2,977,081 — ~3M rows of DELETE+INSERT
   churn already. Consequences: every tick re-reads ~52MB+ of history forever; price-table edits silently reprice
   Codex/Pi/Antigravity history but never ended Claude sessions (mixed price bases, nothing flags it).
   Fix: adapters expose pathToSessionId, or store source_path and gate on it.

5. **Live-session detection compares ISO 'T…Z' strings to SQLite 'YYYY-MM-DD HH:MM:SS'** (`routes.ts:178-187`).
   'T' > ' ' lexicographically → the 5-minute window degenerates to "ended on or after today's UTC date"; sessions
   that ended in the morning show as live until UTC midnight. Same mismatch at `routes.ts:102` (OTEL badge 7d).
   Fix: `datetime(ended_at) >= datetime('now','-5 minutes')`.

## Security (the "localhost-only" defense doesn't stop the browser)

6. **DNS rebinding = full read/write from any webpage** (`server.ts:35,123-127`; all routes). Zero Host/Origin
   validation anywhere. A rebinding page becomes same-origin with 127.0.0.1:<port> → reads /api/sessions (cwd paths,
   titles, costs), streams RAW transcripts via the live SSE (`routes.ts:190-224`), PATCHes burn/skill state.
   Fix: global middleware rejecting Host ∉ {127.0.0.1:<port>, localhost:<port>}; Origin check on mutations/SSE.

7. **Drive-by OTLP poisoning, no rebinding needed** (`server.ts:85-87`, `otel.ts`). `c.req.json()` parses regardless
   of Content-Type → a cross-origin `fetch(..., {mode:'no-cors', headers:{'Content-Type':'text/plain'}})` skips
   preflight; handler always 200s and inserts. Fabricated cost.usage metrics corrupt money figures; no rate/size cap
   → disk-fill. Fix: same Host/Origin middleware on /v1/*; optional per-install path token (setup_otel.ts writes the
   endpoint anyway); coarse ingest cap.

Verified solid: SQL fully parameterized/allowlisted; XSS clean (one static {@html} in Icon.svelte); SPA path traversal
defended; SSE sid regex-validated; setup_otel.ts non-destructive; context/health returns counts only.

## Reliability/performance

8. **No overlapping-tick guard** (`sync_agents.ts:361-362`): bare `setInterval(() => void tick())`. Once #4 pushes tick
   past 120s, ticks pile up N-deep. Fix: in-flight flag + tick-duration in heartbeat metadata.
9. **Worker death zombifies the server** (`server.ts:26-32`): no 'exit' handler, no respawn; `doctor.ts:46-52` checks
   heartbeat COUNT not AGE → reports healthy with a dead pipeline. (UI strip does go red after 300s — the one detector.)
   Fix: worker.on('exit') respawn with backoff; doctor checks heartbeat age.
10. **Live-session SSE re-reads the whole file every 1.5s per viewer** (`routes.ts:199-218`): `Bun.file(...).text()` +
    split; the "growth check" is size > 0 (always true), not size-changed. Multi-MB files stall the synchronous main
    thread. Fix: track size, read appended range only.
11. **Missing indexes**: no tool_calls(session_id) (`db.ts:96-106`) — per-session DELETE full-scans, multiplied by #4;
    sessions has no index beyond PK; otel_events indexed on received_at but queried by timestamp; otel_metrics/spans
    have no received_at index while /api/system/health MAX-over-UNION-ALL full-scans all three every 30s per client
    (`server.ts:48-57`). Fix: idx_tool_calls_session; rewrite health as MAX of three indexed sub-MAXes.
12. **All range predicates non-sargable** (`routes.ts:39-41`): `DATE(col,'localtime') >=` defeats any index; worst
    routes load whole ranges into JS (tools/latency 284-294, mcpCalls 906-931). Fix: precompute ISO bounds and compare
    raw column, or generated local-date column + index.
13. **No retention anywhere**: otel_* and activities grow forever (720 heartbeat rows/day). Fix: 90d sweep in tick.
14. Minor: OTLP inserts lack a per-batch transaction (`otel.ts:114-173`, 500 commits per batch); antigravity
    immutable=1 torn reads silently swallowed (bare catch, `antigravity.ts:380-382`) — log once; SessionFeed duplicates
    replayed lines on the 5-min SSE reconnect (`SessionFeed.svelte:12-21`, server replays 300 lines, no dedupe unlike
    firehose); widespread bare `catch {}` makes a revoked Full Disk Access indistinguishable from "no data"
    (`codex.ts:96-107` et al.) — log when a previously non-empty source goes empty.

## Architecture / type safety

15. **Confirmed shipping type drift, no enforcement** (`api.ts` vs `routes.ts`): (a) Burn types declare
    `estUsd: number` / `totals.estimatedUsd: number` (`api.ts:135,138`) while the route deliberately produces null
    per ADR-0002 (`routes.ts:404-432`) — first consumer to trust the type crashes; (b) `McpServers.source` carries
    the number 0 when calls is empty (`routes.ts:359` `calls.length && ...`) vs declared "otel"|"jsonl".
    Root cause: **49 `as any` DB reads in routes.ts** defeating strict mode at the only layer that matters.
    Fix: shared response types imported by both sides + `db.query<Row>` generics.
16. **Test reality: 10 tests, 2 files** (pi, antigravity). Untested: claude_code.ts (the reference adapter), codex.ts,
    cost.ts (the money engine), all of routes.ts, sync_agents.ts, otel.ts, entire UI. No CI, no typecheck script;
    tsc --noEmit and svelte-check pass today but nothing runs them.
17. **Agent identity hardcoded in ~9 places** — adding agent #5 touches: base.ts:39 AgentId, sync_agents.ts:40-73
    (buildRegistry hardcodes 4 constructors despite agents.yaml existing as the registry), routes.ts:22 AGENT_IDS,
    routes.ts:84-89 detected-paths (3rd copy of path facts — wrong if agents.yaml path overridden), routes.ts:113
    cost-mode ternary (duplicates agents.yaml `cost:` key, never read), api.ts:5, format.ts:65-70 AGENT_NAMES,
    Command.svelte:25, SessionsTablePanel.svelte:44. doctor.ts is the one data-driven exception. The seam held for
    *parsing*; it never existed for *identity*. Fix: buildRegistry iterates agents.yaml; serve agent metadata from one
    endpoint; delete the 5 UI/route lists.
18. **Agent leaks in generic code**: otel.ts stamps `$agent:"claude_code"` unconditionally (127,214,262) — Pi's
    pi-otel events would be misattributed to Claude with no error; burn overlay scoped to claude_code with hardcoded
    metric name (routes.ts:418,938); routes.ts:124 hardcodes fidelity "exact" instead of reading adapter.fidelity;
    4 OTEL-based routes ignore ?agent= entirely.
19. **Dead schema**: mcp_stats, mcp_schemas, live_session_state created, never touched; ~15 otel_events columns
    written never read; `PRAGMA foreign_keys=ON` with zero FKs declared. token_usage attributes whole session to
    start-day + final model (owned honestly in comment, will skew mixed-model charts).
20. **prices.yaml staleness undetectable**: last-updated lives in a comment; doctor only checks existence. Cheap fixes:
    parseable `last_updated:` + doctor warn; doctor report of observed-but-unpriced models
    (`SELECT DISTINCT model FROM sessions WHERE cost_estimated_usd IS NULL`).
21. Minor: TOOL_DURATION_CAP_MS duplicated in all 4 adapters while base.ts:112 falsely claims the orchestrator caps;
    routes.ts where[]/params[] assembly copy-pasted ~12×; failures predicate (routes.ts:759) restates OUTCOME_CASE
    semantics by hand; mixed priced/unpriced sessions store a partial estimate presented as full (sync_agents.ts:245-249);
    Codex Math.max(0,…) clamps mask counter anomalies silently (codex.ts:240-257); PATCH /api/burn mints phantom
    zero-token 'exact' rows for arbitrary dates that re-derivation never cleans (routes.ts:452-465); Codex cumulative
    event priced entirely at the session's LAST model — mid-session /model switch halves/doubles/nulls the estimate
    (codex.ts:166-169,240-257).

## Product / UX

22. **Fetch failures render as "no data"** — only KpiRow and Session route check res.error; 26 of 28 panels show
    "No sessions match" / "Nothing to burn yet" on a 500; PressurePanel renders a blank card body. A cost dashboard
    asserting zero spend when its API is down. Fix once: error state in Card/EmptyState when `res.error && !res.data`.
23. **Pi-looks-broken trap confirmed**: no last-seen affordance anywhere; AgentCard shows "No sessions in range" +
    0.66 opacity — indistinguishable from a broken adapter. The explanation lives in agent memory, not the product.
    Fix: agents API returns un-windowed lastSessionAt; card renders "No sessions in range · last seen Apr 14".
24. **DrillSheet hardcodes range:"30d"** (`DrillSheet.svelte:20`) regardless of the global toggle → cell counts and
    sheet contents disagree; its printed "query" line omits the range it uses.
25. **Dead-end rows**: SessionsTable and FailuresPanel rows are plain divs; the only link to /session/:id in the app
    is the live-session icon. A failures list you can't open. Burn heatmap/Outcomes/Patterns cells are tooltip-only
    (also keyboard-inaccessible); getSessions has no date filter to support a spike→sessions drill. No export/copy
    anywhere.
26. **BUG: duplicate Phase-0 drill sheet** — AppShell.svelte:54-64 still mounts a placeholder Sheet on the same store
    as the real DrillSheet (App.svelte:37): every drill opens two stacked aria-modal dialogs + two scrims, dueling
    autofocus. Delete the AppShell copy.
27. **Colorblind (Scott is red/green CVD)** — deliberate care exists (Okabe-Ito outcomes, cividis burn ramp, cyan-as-
    good convention) but leaks remain: HIGH CachePanel amber-vs-green pass/fail (`CachePanel.svelte:48-49,60-64` —
    amber/green is THE confusable pair; fix: one hue + text state, or blue #0072b2 vs orange #e69f00); MEDIUM
    AgentCard green-vs-gray cache % (`AgentCard.svelte:110,245-251` — green reads as gray); MEDIUM DrillSheet red-text-
    only error rows (`DrillSheet.svelte:84,150` — add ✗ like FailuresPanel does); LOW StatePill red-vs-amber dots
    (add "— stale" to value text); LOW KpiRow/Pressure red emphasis (redundant w/ numbers; prefer vermillion #d55e00);
    LOW swap Badge green tone / SavingsPanel green "saved" to blue/orange.
28. **Staleness**: panels never refresh after mount (resource refetches only on key change); KpiRow labeled "live" but
    keyed on a constant; KpiRow shows today under a "7d" kicker (Command.svelte:33 vs KpiRow.svelte:11-14). Health
    strip can be all-cyan while every number is hours old. Fix: piggyback reload on the 30s health poll.
29. **est-vs-native explained only in SavingsPanel's empty branch**; BurnPanel's two cost columns and "—" never
    explain themselves (native-"—" ambiguous between "no native concept" and "no OTEL that day" — AgentCard
    disambiguates, the table doesn't). Burn heatmap log scale normalizes to observed min→max with no legend.
30. Spec-vs-delivery: TokenUsage and Patterns drop the per-agent dimension the API already returns (api.ts:96,195-197);
    SkillEconomics renders uses, never cost (even when populated; API has no cost field); Sheet lacks the spec'd focus
    trap; SessionsTable missing the model filter (api supports it); docs/phases/INDEX.md still lists Phases 2-4 as
    "Planned". OTEL-starved panels' teaching empty states verified genuinely good.

## What's genuinely solid
- SQL injection / XSS / path traversal all defended; setup_otel.ts non-destructive.
- writeSession and rederiveRollups are real transactions; crash-mid-tick self-heals within one tick.
- Never-guess pricing + null-preserving folds enforced end-to-end; `—` vs $0 discipline in format.ts.
- Adapter/orchestrator split (pure parsers, injected baseDir, orchestrator owns writes) — exactly why adapters were testable.
- resource.svelte.ts stale-response nonce guard is correct; $effect discipline (9 uses, all external-system, commented).
- Okabe-Ito outcomes, cividis burn ramp, teaching empty states with N.

## Top 10 by leverage
1. Fix native-cost merge to per-agent (#1) — headline money figures.
2. Fix re-parse gate keying (#4) + tick overlap guard (#8) + tool_calls(session_id) index (#11) — one cluster.
3. Host/Origin middleware on everything incl /v1/* (#6,#7).
4. Shared wire types + db.query<Row> generics; kill the 49 `as any` (#15).
5. Panel error states via one shared wrapper (#22).
6. Dedup Claude usage on message.id+requestId (#2) — verify against a real resumed session first.
7. last-seen on AgentCard + DrillSheet uses global range (#23,#24).
8. Worker respawn + doctor heartbeat-age (#9); datetime() normalization for live window (#5).
9. CachePanel/AgentCard/DrillSheet CVD fixes (#27).
10. CI: tsc --noEmit && svelte-check && bun test; add claude_code/codex/cost/route tests (#16).
