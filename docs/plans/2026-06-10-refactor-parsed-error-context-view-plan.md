# Parsed Error-Context View — Implementation Plan

- **Date:** 2026-06-10
- **Type:** refactor
- **ADR:** [docs/adr/0005-on-demand-parsed-error-context.md](../adr/0005-on-demand-parsed-error-context.md)
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Error vs Failure
- **Builds on:** ADR-0003 (agent-first read-only drill-downs)

## Overview

Clicking an **Error** today dead-ends at either the raw live-tail Messages feed (which throws
away the tools it fetches) or the drawer's tool timeline (error text hidden in a hover `title`).
Neither answers "what failed, and what was the agent trying to do?".

This refactor makes the session page **tabbed (Errors | Messages)**. Messages is the existing
`SessionFeed` live-tail, untouched. Errors is a new parsed view backed by a new on-demand
endpoint that re-reads the raw JSONL (where tool *input* survives — the DB's `tool_calls` dropped
it) and returns, per errored tool call: the failing input + captured error text + a readable
±N-message context window. Scope is the three text-JSONL agents (Claude Code, Codex, Pi);
Antigravity (protobuf, 0 errored sessions) falls back to Messages with a note.

The design is fully settled in the ADR. This plan is **HOW**, not WHAT.

## Key repository facts (verified)

- **`sessions.source_path` exists and is indexed** (`scripts/db.ts:262–268`, `idx_sessions_source_path`).
  It is the stable per-session key the re-parse gate already uses, and basename ≠ session_id for
  codex/pi/antigravity. **This is the enabler:** the new endpoint resolves the raw log per session
  agent-agnostically via a DB lookup — it does **not** need `findSessionFile` (which is hardcoded to
  `~/.claude/projects`, `scripts/routes.ts:1040`) and must not reuse it for non-Claude agents.
- **Tool input is NOT in the DB.** `tool_calls` stores `tool_name` + extracted `error` text only
  (`scripts/routes.ts:258–260`); `error` is e.g. `"exit_code 1"` (codex `codex.ts:304`),
  `"tool_error"` (pi `pi.ts:282`), or the result content slice (claude `claude_code.ts:213,264`).
  The failing input lives only in the raw `tool_use` / `function_call` / `toolCall` line.
- **Errored counts by agent:** claude_code 107, codex 9, pi 5, antigravity 0.
- **Ingest Adapters do not emit display messages.** They yield normalized `tokens`/`tool`/`session`
  events (`scripts/adapters/{claude_code,codex,pi}.ts`). The display parsers are a *separate* second
  consumer of the same log formats — the ADR is explicit they stay distinct.
- **Per-agent raw formats** (already documented in the adapter headers — the display parsers mirror
  these exact shapes):
  - **Claude** (`claude_code.ts:9–18,176–217`): `type:"assistant"` → `message.content[]` blocks
    (`text` | `thinking` | `tool_use{id,name,input}`); `type:"user"` → `message.content[]`
    `tool_result{tool_use_id,is_error,content}`; `type:"ai-title"`. Pair tool_use→tool_result by id.
  - **Codex** (`codex.ts:5–28,165–255`): `{type,timestamp,payload}` envelope. `response_item` →
    `function_call{call_id,name,arguments}` / `custom_tool_call`, paired with
    `function_call_output{call_id,output}`; failure via `exec_command_end.exit_code≠0`
    (event_msg) or `status:"failed"`. User/assistant text is in `response_item` message payloads.
  - **Pi** (`pi.ts:9–48,201–258`): `type:"message"` with `message.role ∈ {assistant,toolResult,user}`;
    assistant `content[]` has `toolCall{id,name,input}`; `toolResult{toolCallId,toolName,isError,content}`.
    Tree-structured (`parentId`) but real sessions are linear — display can read in file order.
- **Router is pathname-only** (`router.svelte.ts:15` stores `window.location.pathname`; `navigate`
  pushes a path). No query handling today. Extend minimally to read `?tab=errors`.
- **Click sources** all currently `navigate(\`/session/${id}\`)`:
  - `FailuresPanel.svelte:31` — whole row.
  - `SessionsTablePanel.svelte:117` — whole row (outcome pill at `:123`, no stopPropagation today).
  - `AgentCard.svelte:116` — errors cell calls `drill("errors","errored")` → opens `DrillSheet`.
  - `DrillSheet.svelte:104` — list row calls `openDetail(id)` (in-drawer detail, never navigates).
- **Test harness exists both sides:** backend `bun test scripts` (e.g. `scripts/routes.test.ts`,
  `scripts/adapters/*.test.ts` parse real/synthetic fixtures); UI `vitest + jsdom` with runes
  compiled via `*.svelte.test.ts` (`ui/vitest.config.ts`, `ui/src/lib/resource.svelte.test.ts`).
- **Colorblind convention (Scott):** red is always paired with the `✗` glyph, never color-alone.
  Reuse the existing `.xmark`/`✗` pattern (`DrillSheet.svelte:88,156`, `FailuresPanel.svelte:35`).

## Assumptions (labeled — not verified in code)

- **A1.** `source_path` is reliably populated for the in-scope agents' errored sessions (the gate
  depends on it, so this is very likely, but the plan includes a fallback to a 404 + Messages note
  if a row has a null/missing path). **Validate in Phase 1.**
- **A2.** "Readable parsed context" = the human-facing text of surrounding messages (user prompts,
  assistant text/thinking, tool calls), not raw JSON. The ADR says "readable" repeatedly; the parser
  flattens each entry to `{role, text, isError, toolInput}`.
- **A3.** ±N defaults to ~3 before / ~2 after per the SCOPE note, expandable client-side. The window
  is computed over the parser's *readable-message* sequence (tool_use/result blocks collapse into
  their owning message), not raw JSONL lines.
- **A4.** The endpoint returns ALL errored tool calls in a session (107-error sessions exist but an
  individual session's error count is small); no pagination needed initially.
- **A5.** Deep-linking uses `?tab=errors` as a query param on the existing `/session/:id` path (per
  SCOPE), not a new path segment — so `sessionIdFromPath` is unaffected.

## Open questions

- **Q1 (non-blocking, proceeding with A2/A3):** For Codex, the failing "tool input" for a shell tool
  is the command string; for `apply_patch` it's the patch. Display shows the raw `arguments`/command
  verbatim (truncated like the adapter's 500-char error slice). Confirm no redaction is wanted —
  these are local logs, app is localhost-only, so I'm assuming verbatim is fine.

## Proposed Plan

Planning depth: **standard-to-comprehensive** (cross-cutting: new backend endpoint + new parser
module + tabbed page + 4 click-source rewrites). Sequenced backend-first so the UI builds against a
real contract, with the display parser landing test-first since it is the riskiest new surface.

---

### Phase 1: Display-parser module + fixtures (backend, test-first)

- **Objective:** A standalone per-agent display parser that turns a raw session log into an ordered
  list of readable messages with errored tool calls flagged and their input attached — the data the
  endpoint will window over. No HTTP yet.
- **Why first:** This is the highest-risk new surface (three formats, must mirror the adapters
  exactly) and is independently unit-testable against the same fixture style the adapter tests use.
- **Changes:**
  - New module `scripts/error_context.ts` (display parsers, deliberately separate from
    `scripts/adapters/`). Export `parseDisplay(agent, filePath): Promise<DisplayMessage[]>` plus a
    pure `windowErrors(messages, before=3, after=2): ErrorContext[]` that locates each
    `isError` tool entry and slices its context window.
  - `DisplayMessage = { role: "user"|"assistant"|"tool"; text: string; isError: boolean; toolName?: string; toolInput?: string }`.
  - `ErrorContext = { toolName, toolInput, errorText, before: DisplayMessage[], after: DisplayMessage[], index }`.
  - Three per-agent readers (claude/codex/pi) mirroring the format notes above; a `switch(agent)`
    dispatch. Antigravity throws a typed `UnsupportedAgentError` (the endpoint maps it to the
    fallback note, Phase 2).
- **Affected areas:** `scripts/error_context.ts` (new); `scripts/error_context.test.ts` (new).
- **Dependencies:** none — reads files directly, reuses the `createReadStream`/`readline` streaming
  pattern from the adapters.
- **Risks:** Format drift between display parser and adapter. Mitigate by deriving fixtures from the
  same real-data shapes the adapter tests already encode (`scripts/adapters/{claude_code,codex,pi}.test.ts`).
- **Validation (write first):**
  - For each agent: a fixture log with ≥1 errored tool call → assert the error entry carries the
    failing input + error text and the correct ±N surrounding readable messages.
  - Window clamps at file start/end (error in first or last message yields a short window, no crash).
  - A session with zero errored tool calls → `windowErrors` returns `[]`.
  - Malformed/again-unparseable line is skipped, never throws (mirrors adapter resilience).
  - Antigravity agent → `UnsupportedAgentError`.

### Phase 2: `GET /api/sessions/:id/errors` endpoint + wire types

- **Objective:** Serve the windowed errors for a session on demand, resolving the raw log via
  `source_path`, agent-agnostically.
- **Changes:**
  - New handler in `scripts/routes.ts` near `/api/sessions/:id/details` (`:248`). Look up
    `SELECT agent, source_path, error_count, rate_limit_hit, stop_reason, ${OUTCOME_CASE} outcome
    FROM sessions WHERE session_id = ?`. **Resolve the file from `source_path`** (NOT
    `findSessionFile`). On `agent === "antigravity"` or no display parser → return
    `{ supported: false, note, outcome }`. On a non-errored Failure (rate_limited/truncated) →
    `{ supported: true, errors: [], failureNote, outcome }` (the one-line explanation; ADR
    "anchor only on Errors"). Else call `parseDisplay` + `windowErrors` and return
    `{ supported: true, errors, outcome }`.
  - 404 if session not found; graceful `{ supported:false, note }` if `source_path` missing/file gone
    (A1 fallback) rather than a 500.
  - Add the response shape to `scripts/wire.ts` and the matching `SessionErrors` interface + a
    `getSessionErrors(id)` fetcher to `ui/src/lib/api.ts` (kept in sync by hand per the file's header).
- **Affected areas:** `scripts/routes.ts`, `scripts/wire.ts`, `ui/src/lib/api.ts`.
- **Dependencies:** Phase 1.
- **Risks:** Multi-MB transcripts re-parsed on demand — acceptable per ADR (occasional view), and the
  parser streams line-by-line. No caching in v1.
- **Validation:**
  - `scripts/routes.test.ts` additions (in-memory DB + a temp fixture file as `source_path`):
    errored claude session → errors array with inputs/windows; antigravity → `supported:false`;
    rate-limited session (no errors) → `errors:[]` + `failureNote`; unknown id → 404; row with null
    `source_path` → `supported:false` note, status 200.

### Phase 3: Router `?tab=errors` support

- **Objective:** Read and write the active tab via the query string without disturbing pathname-only
  routing.
- **Changes:** In `ui/src/lib/router.svelte.ts`: add `search: window.location.search` to the
  reactive `router` state (or a derived `query` getter); update `navigate` to accept an optional
  query (e.g. `navigate("/session/x", "?tab=errors")` or accept a full URL) and set both
  `history.pushState` and the reactive fields; update the `popstate` listener to refresh `search`.
  Add a helper `tabFromSearch(search): "errors" | "messages"`.
- **Affected areas:** `ui/src/lib/router.svelte.ts`; callers in Phases 5–6.
- **Dependencies:** none (can land in parallel with Phase 1/2).
- **Risks:** The `navigate` early-return `if (path === router.path) return` (`:24`) would suppress a
  tab change when only the query differs — must compare path+search.
- **Validation:** New `ui/src/lib/router.svelte.test.ts`: `navigate` to same path with a new
  `?tab=errors` updates reactive state (does NOT early-return); `tabFromSearch` maps `?tab=errors`→
  `"errors"`, anything else → `"messages"`; popstate restores search.

### Phase 4: `<SessionErrors>` component + tabbed Session page

- **Objective:** Render the parsed errors view and host both tabs on the session page; deep-link via
  `?tab=errors`.
- **Changes:**
  - New `ui/src/lib/components/panels/SessionErrors.svelte` (single host: the session page).
    `{ sessionId }` prop; uses `resource(() => \`errors:${id}\`, () => getSessionErrors(id))`
    (the app's standard data primitive). Per `ErrorContext`: failing tool input (command/edit
    target), captured error text, and the readable context window (~3 before / ~2 after,
    **expandable** — a "show more" that grows the slice client-side). Red always paired with `✗`
    (reuse `.xmark` convention). Handle three states: `supported:false` → the "parsed error view
    unavailable for this agent" note + a link/affordance to the Messages tab; `errors:[]` +
    `failureNote` → the one-line failure explanation deferring to Messages; populated → the windows.
  - `ui/src/routes/Session.svelte`: introduce a tab strip (Errors | Messages). Default tab =
    Messages; initial tab read from `tabFromSearch`. Messages renders the **unchanged**
    `<SessionFeed sessionId={id} fill />`; Errors renders `<SessionErrors sessionId={id} />`.
    Switching tabs updates the URL query (so a reload/back preserves the tab) via the Phase 3
    `navigate`. Keep `SessionFeed` mounted-only-while-active is acceptable (it already manages its own
    SSE lifecycle on mount/unmount per its header) — but to honor "Messages stays complete," mount it
    when its tab is active; the live tail re-tails on mount.
- **Affected areas:** `ui/src/routes/Session.svelte`, new `SessionErrors.svelte`,
  `SessionFeed.svelte` (host only, no behavior change).
- **Dependencies:** Phases 2 + 3.
- **Risks:** Re-mounting `SessionFeed` on tab switch restarts its tail (loses prior scrollback). If
  that is undesirable, keep both tabs mounted and toggle visibility with CSS — decide during build;
  default to mount-on-active for simplicity unless the tail reset is jarring. (Non-blocking.)
- **Validation:** `ui/src/lib/components/panels/SessionErrors.svelte.test.ts` (vitest+jsdom, mock
  `getSessionErrors`): renders a window with `✗` next to error text and shows the tool input;
  `supported:false` renders the agent-unavailable note; `failureNote` branch renders the one-liner;
  expand control grows the visible context. Session page test: `?tab=errors` selects the Errors tab;
  default selects Messages.

### Phase 5: Click-source rewiring (per-location behavior)

- **Objective:** Route each entry point to the correct tab per the SCOPE matrix.
- **Changes:**
  - `FailuresPanel.svelte:31` — whole row → `navigate(\`/session/${id}\`, "?tab=errors")`.
  - `SessionsTablePanel.svelte` — wrap the **outcome pill** (`:123`) in its own click handler that
    `stopPropagation`s and navigates to `?tab=errors`; the rest of the row keeps the default
    Messages navigation (`:117`). The pill becomes interactive only for the `errored` outcome
    (rate-limited/truncated have no Errors → keep row default). **No new column.**
  - `AgentCard.svelte` — the errors cell still opens `DrillSheet` (unchanged `drill("errors","errored")`).
  - `DrillSheet.svelte` — only when the drill context is the **errors** drill (`drill.ctx?.outcome
    === "errored"`), a list-row click navigates to `/session/:id?tab=errors` **and closes the
    drawer** (`closeDrill()`), instead of `openDetail(id)`. Tokens/sessions/tools drills keep
    `openDetail` (in-drawer detail). This requires distinguishing the drill type — `drill.ctx.outcome`
    already carries `"errored"` for the errors cell (`AgentCard.svelte:116`).
  - `LiveSessionRow` — unchanged (Messages/default). (Confirm location; not in the key-files list, no
    edit expected.)
- **Affected areas:** `FailuresPanel.svelte`, `SessionsTablePanel.svelte`, `DrillSheet.svelte`
  (AgentCard unchanged in behavior).
- **Dependencies:** Phases 3 + 4.
- **Risks:** `stopPropagation` on a nested button inside a `<button>` row is invalid HTML (button in
  button). The row is currently a `<button>` (`SessionsTablePanel.svelte:117`) — making the pill a
  nested button nests interactive elements. Mitigate: either make the pill a `<span role="button">`
  with a keydown/click handler, or restructure the row so the pill is a sibling, not a descendant, of
  the row button. **Flag for a small structural decision during build.**
- **Validation:** Component tests asserting the navigate target per source: failures row →
  `?tab=errors`; sessions errored-pill click → `?tab=errors` and does not also trigger the row's
  Messages nav (stopPropagation); sessions non-pill row → default; errors-drill list row → navigates
  with `?tab=errors` and calls `closeDrill`; a tokens-drill row → still `openDetail` (no navigation).

### Phase 6 (deferred, not in this plan): "act on this Error"

Per ADR Consequences, an action affordance can slot into `<SessionErrors>` later without
restructuring. Out of scope here (stays read-only, ADR-0003).

## Acceptance Criteria

- [ ] `GET /api/sessions/:id/errors` resolves the raw log via `sessions.source_path` (not
      `findSessionFile`) and returns, per errored tool call, `{ toolName, toolInput, errorText,
      before[], after[] }` for claude_code / codex / pi.
- [ ] Antigravity (or any agent without a display parser) returns `supported:false` with the
      "parsed error view unavailable for this agent" note; the Errors tab shows it and points to Messages.
- [ ] A rate-limited / truncated Failure returns `errors:[]` + a one-line failure explanation; the
      Errors tab defers to Messages.
- [ ] The session page is tabbed Errors | Messages; Messages is the unchanged, complete, in-order
      `SessionFeed`; `?tab=errors` deep-links to Errors; normal nav defaults to Messages.
- [ ] FailuresPanel row → Errors tab; SessionsTablePanel errored-pill (stopPropagation) → Errors tab
      while the rest of the row → Messages; AgentCard errors drill → DrillSheet list whose pick
      navigates to the page Errors tab and closes the drawer; other drills keep in-drawer detail.
- [ ] Every red error indicator is paired with the `✗` glyph (no color-alone signaling).
- [ ] Display parsers live in a module separate from `scripts/adapters/`.
- [ ] `bun test scripts` and `cd ui && bun run test` (vitest) pass; `bun run check` is green.

## Risks and Dependencies

- **Format drift** between display parsers and ingest adapters (two consumers of each log format) —
  mitigated by fixture tests mirroring the adapter test data; called out as an ADR consequence.
- **`source_path` completeness (A1)** — the endpoint degrades to a `supported:false` note rather than
  500 if a path is missing; verify in Phase 1/2.
- **Nested-interactive HTML** in SessionsTablePanel (pill inside a row button) — small structural
  decision in Phase 5.
- **SessionFeed remount on tab switch** resets the live tail — decide mount-on-active vs.
  keep-mounted/CSS-toggle in Phase 4 (non-blocking).
- Sequencing: 1 → 2 → (3 ∥) → 4 → 5. Phase 3 can land any time before 4.

## References

- ADR: `docs/adr/0005-on-demand-parsed-error-context.md`
- Glossary: `CONTEXT.md` (Error vs Failure)
- Backend: `scripts/routes.ts` (`:248` details handler, `:1040` findSessionFile, `OUTCOME_CASE`
  `:116`), `scripts/db.ts:262–268` (`source_path`), `scripts/wire.ts`,
  `scripts/adapters/{claude_code,codex,pi}.ts`
- Frontend: `ui/src/routes/Session.svelte`, `ui/src/lib/router.svelte.ts`, `ui/src/lib/api.ts`,
  `ui/src/lib/components/panels/{SessionFeed,FailuresPanel,SessionsTablePanel,AgentCard,DrillSheet}.svelte`
- Tests: `scripts/routes.test.ts`, `scripts/adapters/*.test.ts`, `ui/src/lib/resource.svelte.test.ts`,
  `ui/vitest.config.ts`

## Next step

`/workflows:work docs/plans/2026-06-10-refactor-parsed-error-context-view-plan.md` — the plan is
execution-ready. Resolve Q1 (verbatim tool input, assumed yes) and the two non-blocking build-time
decisions (pill nesting, SessionFeed remount) inline during implementation.
