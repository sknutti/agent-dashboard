# Parsed Transcript Cards — Messages Tab (layout C) — Implementation Plan

- **Date:** 2026-06-10
- **Type:** feat
- **ADR:** [docs/adr/0006-parsed-transcript-cards-messages-tab.md](../adr/0006-parsed-transcript-cards-messages-tab.md) (amends [ADR-0005](../adr/0005-on-demand-parsed-error-context.md))
- **Glossary:** [CONTEXT.md](../../CONTEXT.md) — Message · Transcript (and the amended "Messages feed" note, line 85)
- **Builds on:** the landed Errors view (`error_context.ts`, `GET /api/sessions/:id/errors`, tabbed `Session.svelte`)

## Overview

For an **ended** session, the Messages tab should render the session's **Transcript** as
**Message cards** — one card per readable entry (user · assistant · thinking · tool), produced by
the same on-demand `parseDisplay` the Errors view already uses, laid out as **layout C (grouped
turns)**: each user prompt heads a turn section, with the agent's thinking / assistant / tool
Messages nested beneath on a left-gutter timeline. A still-**live** session keeps the existing raw
byte-tail `SessionFeed`; the tab auto-branches on session state with **no raw/cards toggle**.

The design is settled in ADR-0006. This plan is **HOW**, not WHAT.

## Key repository facts (verified)

- **The Errors infrastructure is fully landed** — this feature extends it, it is not greenfield:
  - `scripts/error_context.ts` exports `parseDisplay(agent, filePath): Promise<DisplayMessage[]>`,
    `windowErrors`, `DISPLAY_PARSER_AGENTS = {claude_code, codex, pi}`, and `UnsupportedAgentError`.
    `DisplayMessage = { role: "user"|"assistant"|"tool"; text; isError; toolName?; toolInput? }`
    (`error_context.ts:23-29`). **There is no `thinking` role and no `ts` field today** — ADR-0006
    requires both.
  - `parseClaude` currently **folds thinking into assistant text** (`error_context.ts:178-179`:
    `block.type === "thinking"` pushes into `curText`, the same buffer as `text`). ADR-0006 wants
    thinking as its own Message.
  - `GET /api/sessions/:id/errors` → `buildSessionErrors(db, id)` (`routes.ts:147-204`) resolves the
    raw log via `sessions.source_path` (NOT `findSessionFile`), branches on agent/outcome, and calls
    `parseDisplay` + `windowErrors`. The new messages endpoint mirrors this resolution + branching.
- **`sessions.source_path` is the agent-agnostic file key** (used by `buildSessionErrors`, indexed
  `idx_sessions_source_path`). basename ≠ session_id for codex/pi — must use `source_path`, never
  `findSessionFile` (hardcoded to `~/.claude/projects`, `routes.ts:1132`).
- **`ended_at` is available** on the session row (`SessionRow.ended_at`, `wire.ts:63`; selected in
  `/details`, `routes.ts:332`). The live-sessions query treats a session as live when
  `ended_at IS NULL OR ended_at >= now-5min` (`routes.ts:362-363`) — the existing live-window
  definition this tab should reuse.
- **The session page is already tabbed** (`ui/src/routes/Session.svelte:52-73`): an Errors | Messages
  tab strip, `activeTab = tabFromSearch(router.search)`, `selectTab` pushes `?tab=errors|messages`.
  **Messages currently renders `<SessionFeed sessionId={id} fill />` unconditionally** (`:71`) — the
  raw live tail, with no ended/live branch. That is the single line this feature changes on the host.
- **Router supports `?tab=` already** (`router.svelte.ts`): `tabFromSearch`, a path+search-aware
  `navigate`, and a `popstate` listener that refreshes `search`. No router change needed.
- **`SessionFeed`** is the raw EventSource tail (`SessionFeed.svelte`), unchanged by this work — it
  stays the live branch.
- **`SessionErrors`** is the layout reference: `resource(() => \`errors:${id}\`, () =>
  getSessionErrors(id))`, a `readableInput()` helper that pretty-prints tool input (command-bearing
  tools show the command; else indented JSON), `.xmark`/`✗` for errored tool calls, expand controls.
  Reuse these patterns; do not re-derive them.
- **Wire/api type duplication is hand-kept in sync:** canonical `DisplayMessage`/`ErrorContext` live
  in `error_context.ts`, re-exported by `scripts/wire.ts:20`, and **mirrored by hand** in
  `ui/src/lib/api.ts:93-99` (header: "keep the two in sync"). A `role`/`ts` change touches all three.
- **Fetchers** are one-liners over `getJson<T>` (`api.ts:301`): `getSessionErrors(id)` (`:326`),
  `getSessionDetail(id)` (`:325`). The new `getSessionMessages(id)` follows the same shape.
- **Test harness both sides:** backend `bun test scripts` — `scripts/error_context.test.ts` already
  has claude/codex/pi fixtures (`error_context.test.ts:31-140`, incl. a split thinking/text/tool_use
  claude message at `:37`) and `scripts/routes.test.ts`; UI `vitest + jsdom` runs `*.svelte.test.ts`
  (`Session.svelte.test.ts`, `SessionErrors.svelte.test.ts`, `errors-routing.svelte.test.ts`).
- **Colorblind convention (Scott, red/green):** red is ALWAYS paired with the `✗` glyph, never
  colour-alone. Errored tool cards reuse the `.xmark` pattern (`SessionErrors.svelte:184`).
- **No virtualization** (ADR): largest real sessions ~750 cards; render all, keep cards compact with
  truncate-and-expand for long tool output (the Errors `readableInput` + `max-height` pattern).

## Assumptions (labeled — not verified in code)

- **A1.** The "ended vs live" branch reuses the existing live-window rule (`ended_at IS NULL OR
  ended_at >= now-5min` ⟹ live → raw tail; else ended → cards). The endpoint can report this so the
  client doesn't re-derive the 5-minute threshold. **Confirm the threshold source in Phase 3.**
- **A2.** "Thinking is text-gated" ⟹ a `thinking` Message is emitted only when readable thinking text
  exists. In practice Claude-only: codex/pi store reasoning as `encrypted_content`, which the current
  parsers already don't read, so no code path emits empty thinking for them — text-gating is
  automatic, no placeholder suppression logic needed beyond "skip empty".
- **A3.** The Errors view's context windows should now show thinking as a **distinct** context Message
  (ADR Consequences: "thinking now appears in context windows"). This is a behavior change to
  `SessionErrors` rendering + its parser tests, not just Messages — folded into Phase 1/2.
- **A4.** `ts` is sourced from each format's existing per-line timestamp: claude top-level/`message`
  timestamp, codex envelope `timestamp` (`{type,timestamp,payload}`, `error_context.ts:219`), pi
  message `ts`/`timestamp`. Where a line has no timestamp, `ts` is the empty string / omitted and the
  card simply renders no time (rendered "subtly", ADR). **Verify each format's timestamp key in Phase 1.**
- **A5.** Grouping into turns (layout C) is a **pure client-side fold** over the flat ordered
  `DisplayMessage[]`: start a new turn at each `user` Message; thinking/assistant/tool nest under the
  current turn. The endpoint returns the same flat array as Errors, not pre-grouped — keeps the
  parser one-shaped and the grouping testable in isolation.
- **A6.** A *tool* card stays one card: call input (via `readableInput`) + result/output text + `✗`
  on error, long output truncated-and-expandable (borrow `SessionErrors`).

## Open questions

- **Q1 (non-blocking, proceeding with A1):** The live-window threshold — reuse the live-sessions
  query's `now-5min`, or treat any non-null `ended_at` as ended? They differ only for a session that
  ended in the last 5 minutes (a just-finished session would show the raw tail for up to 5 min, then
  flip to cards). I'm assuming **reuse the 5-min window** for consistency with `/sessions/live`; if
  you'd rather flip to cards the instant `ended_at` is set, say so — it's a one-line change.

## Proposed Plan

Planning depth: **standard** (one new endpoint reusing the landed parser + resolver; a parser
enrichment shared with Errors; one new card component + a client-side turn-grouping fold; one
host-line branch on the existing tabbed page). Sequenced backend-first so the card component builds
against a real contract; the parser enrichment lands test-first because it is shared with the live
Errors view and is the only change that can regress existing behavior.

---

### Phase 1: Enrich `parseDisplay` — `thinking` role + per-Message `ts` (backend, test-first)

- **Objective:** `parseDisplay` emits *thinking* as its own Message (text-gated) and attaches a `ts`
  to every Message — the two parser changes ADR-0006 requires, shared by both views.
- **Why first:** It is the only change that touches code the **live Errors view already depends on**
  (`SessionErrors` renders the windows; `windowErrors` slices them). Landing it test-first against the
  existing fixtures guarantees no Errors regression before any Messages UI exists.
- **Changes:**
  - `scripts/error_context.ts`: extend `DisplayMessage.role` to `"user"|"assistant"|"thinking"|"tool"`
    and add `ts: string` (empty when the line carries no timestamp).
  - `parseClaude`: stop folding `thinking` into the assistant text buffer (`:178-179`); when a
    `thinking` block has non-empty `thinking` text, flush the current assistant text and push a
    distinct `{ role: "thinking", text, ts }` Message. Capture `ts` from the claude line's timestamp.
  - `parseCodex` / `parsePi`: attach `ts` from the codex envelope `timestamp` / the pi message
    timestamp to each emitted Message. **Do not** emit thinking for these (encrypted reasoning, A2) —
    text-gating means no code path runs.
  - `windowErrors`: no logic change, but its output now naturally includes thinking Messages in
    `before`/`after` (A3) — verify the slicing still clamps correctly with the extra entries.
- **Affected areas:** `scripts/error_context.ts`, `scripts/error_context.test.ts`.
- **Dependencies:** none.
- **Risks:** **Errors-view regression** — the existing claude fixture folds thinking into
  `before[1].text` (`error_context.test.ts:63` asserts `before[1].text` contains "the match looks
  off"). That assertion must move to a now-distinct thinking Message; updating it is the ADR's
  intended ripple, not a break. Keep the codex/pi error tests green unchanged (no thinking).
- **Validation (write/adjust first):**
  - Claude fixture: a split thinking/text/tool_use message → asserts a `role:"thinking"` Message
    distinct from the `role:"assistant"` text Message, in order, both carrying `ts`.
  - Empty/absent thinking text → **no** thinking Message (text-gating).
  - Codex & pi fixtures: every Message carries `ts`; **no** thinking Message emitted.
  - `windowErrors` over a transcript containing a thinking Message → the thinking entry appears in
    the appropriate `before`/`after` slice; windows still clamp at file start/end.

### Phase 2: `GET /api/sessions/:id/messages` endpoint + wire/api types

- **Objective:** Serve the whole parsed Transcript for an **ended** session on demand, with the same
  agent/outcome/missing-file degradations as the Errors endpoint, plus an explicit live signal.
- **Changes:**
  - `scripts/routes.ts`: factor a `buildSessionMessages(db, id)` beside `buildSessionErrors`
    (`:147`), reusing the same `source_path` resolution and the `DISPLAY_PARSER_AGENTS` /
    `UnsupportedAgentError` / missing-file branches. New branch: **if the session is live** (A1 —
    `ended_at IS NULL OR ended_at >= now-5min`) return `{ supported: true, live: true, messages: [] }`
    so the client renders the raw tail; else return `{ supported: true, live: false, messages:
    parseDisplay(...) }`. Antigravity / missing log → `{ supported: false, note }` (same notes as
    Errors). Register `app.get("/api/sessions/:id/messages", ...)` next to the errors route (`:351`).
  - `scripts/wire.ts`: add `SessionMessagesResponse { supported; live; messages?: DisplayMessage[];
    note? }` (re-using the canonical `DisplayMessage`).
  - `ui/src/lib/api.ts`: mirror `SessionMessages` interface (hand-kept, per the file header) and add
    `getSessionMessages = (id) => getJson<SessionMessages>(\`/api/sessions/${id}/messages\`)`.
- **Affected areas:** `scripts/routes.ts`, `scripts/wire.ts`, `ui/src/lib/api.ts`.
- **Dependencies:** Phase 1.
- **Risks:** Multi-MB transcript re-parsed on demand — same trade-off the Errors endpoint already
  accepts (occasional view, streamed line-by-line, no caching v1). The ~750-card ceiling is in the
  no-virtualization budget.
- **Validation:** `scripts/routes.test.ts` additions (in-memory DB + temp fixture file as
  `source_path`, mirroring the errors tests): ended claude session → `live:false` + a `messages` array
  including a thinking Message; **live** session (null `ended_at`) → `live:true`, `messages:[]`;
  antigravity → `supported:false` + note; null/missing `source_path` on an ended session →
  `supported:false` note, status 200; unknown id → 404.

### Phase 3: Turn-grouping fold + `<SessionMessages>` card component (layout C)

- **Objective:** Render the parsed Transcript as grouped-turn Message cards; branch ended→cards /
  live→raw tail inside the Messages tab.
- **Changes:**
  - **Pure grouping helper** (testable in isolation), e.g. `groupTurns(messages: DisplayMessage[]):
    Turn[]` where `Turn = { prompt: DisplayMessage | null; entries: DisplayMessage[] }`. A new turn
    starts at each `user` Message; thinking/assistant/tool accrue into the current turn's `entries`.
    Messages before the first user prompt form a leading turn with `prompt: null`. Place in
    `ui/src/lib/` (e.g. `transcript.ts`) so it has a `*.test.ts` without a component.
  - New `ui/src/lib/components/panels/SessionMessages.svelte` (single host: the session page).
    `{ sessionId }` prop; `resource(() => \`messages:${id}\`, () => getSessionMessages(id))`.
    - **Live branch:** `data.live` → render `<SessionFeed sessionId fill />` (the raw tail, unchanged).
    - **Ended branch:** group `data.messages` via `groupTurns` and render layout C — each turn: the
      user prompt as the section head; beneath it a **left-gutter timeline** with type-coloured dots
      (user/assistant/thinking/tool — pick from the existing token palette; **avoid red/green
      pairings** for the dot legend per Scott's colorblind note, MEMORY.md), one card per entry.
      Tool cards reuse `SessionErrors`' `readableInput()` for the call input and the
      truncate-`max-height`-and-expand pattern for long output; an errored tool card pairs red with
      `✗` (`.xmark`). Each card shows its `ts` subtly (relTime via `format.ts`).
    - `supported:false` → the note + a stays-on-page explanation (this IS the Messages tab, so no
      "open Messages" link — degrade to the note, or fall through to the raw `SessionFeed` if a
      source_path-missing session is somehow still tail-able; default to the note).
  - `ui/src/routes/Session.svelte`: change the Messages branch (`:68-72`) from the unconditional
    `<SessionFeed>` to `<SessionMessages sessionId={id} />` (which internally chooses tail vs cards).
    Errors tab unchanged.
- **Affected areas:** `ui/src/lib/transcript.ts` (new), `ui/src/lib/transcript.test.ts` (new),
  `ui/src/lib/components/panels/SessionMessages.svelte` (new), `ui/src/routes/Session.svelte` (one
  branch swap). `SessionFeed.svelte` reused unchanged.
- **Dependencies:** Phase 2.
- **Risks:**
  - **`SessionFeed` remount on tab switch** restarts its tail (existing behavior; the tab already
    mounts-on-active). No change — live sessions keep today's UX.
  - **Card-type dot colours** must dodge red/green collisions (Scott). Use the Okabe-Ito / token
    palette already in the app; errored state stays the `✗` glyph, not a colour swap.
  - **Reuse vs copy** of `readableInput`: it currently lives inside `SessionErrors.svelte`'s
    `<script>`. To share it cleanly, lift it to `ui/src/lib/format.ts` (or `transcript.ts`) and import
    from both components — a small refactor that keeps one source of truth. **Flag during build.**
- **Validation:**
  - `ui/src/lib/transcript.test.ts`: messages with two user prompts → two turns, each carrying its
    following thinking/assistant/tool entries; leading non-user messages → a `prompt:null` turn;
    empty input → `[]`.
  - `ui/src/lib/components/panels/SessionMessages.svelte.test.ts` (vitest+jsdom, mock
    `getSessionMessages`): `live:true` renders `SessionFeed` (raw tail), NOT cards; `live:false`
    renders grouped turns with a user prompt head and nested cards; an errored tool entry shows `✗`;
    `supported:false` renders the note. Session-page test: Messages tab now mounts `SessionMessages`
    (extend `Session.svelte.test.ts`).

---

### Out of scope (per ADR, explicitly rejected — do not build)

- Raw ⇄ Cards toggle on ended sessions (auto-only).
- Incremental parsing of the live SSE tail into cards (live stays raw).
- "Reasoning hidden (encrypted)" placeholder cards for codex/pi (text-gating only).
- Virtualization / paging.
- Model/token metadata on cards (the token panels' job).

## Acceptance Criteria

- [x] `parseDisplay` emits a distinct `thinking` Message (text-gated, Claude-only in practice) and a
      per-Message `ts`; `DisplayMessage.role` includes `"thinking"`; the Errors view's context windows
      now include thinking Messages and its parser tests are updated to match (no Errors regression).
- [x] `GET /api/sessions/:id/messages` resolves the raw log via `sessions.source_path` (not
      `findSessionFile`); for an **ended** in-scope session returns the whole `DisplayMessage[]`; for a
      **live** session returns `live:true` with no messages; antigravity / missing log →
      `supported:false` + note; unknown id → 404.
- [ ] The Messages tab renders **layout C grouped turns** for ended sessions (user prompt heads each
      turn; thinking/assistant/tool nest on a left-gutter timeline) and the **unchanged raw
      `SessionFeed`** for live sessions — auto-branched, **no raw/cards toggle**.
- [ ] Tool cards show the call input (via the shared `readableInput`) + result/output, truncate long
      output with an expand control, and pair red with `✗` on error (no colour-alone signalling; dot
      legend avoids red/green).
- [ ] Each card renders its `ts` subtly; no model/token metadata on cards.
- [ ] Display parsing stays in `scripts/error_context.ts` (one parser, two views: whole vs windowed).
- [ ] `bun test scripts` and `cd ui && bun run test` (vitest) pass; `bun run check` is green.

## Risks and Dependencies

- **Shared-parser coupling tightens** (ADR Consequences): one parser now feeds Errors (windowed) and
  Messages (whole). Mitigated by keeping both test-pinned against the same `error_context.test.ts`
  fixtures; Phase 1 is test-first specifically to catch the Errors ripple.
- **Type duplication across three files** (`error_context.ts` → `wire.ts` → `api.ts`) is hand-kept;
  the `role`/`ts` change must land in all three or the client drifts.
- **`source_path` completeness** — endpoint degrades to a `supported:false` note rather than 500 if a
  path is missing/file gone (same A1 fallback the Errors endpoint already uses).
- **Live-window threshold (Q1)** — reuse the `now-5min` rule from `/sessions/live`; non-blocking,
  proceeding with reuse.
- **Colorblind palette** for the turn-timeline dots — must avoid red/green pairings (MEMORY.md).
- Sequencing: 1 → 2 → 3 (strictly ordered; the card UI needs the endpoint, the endpoint needs the
  enriched parser).

## References

- ADR: `docs/adr/0006-parsed-transcript-cards-messages-tab.md` (amends `0005-...md`)
- Glossary: `CONTEXT.md` (Message · Transcript; amended "Messages feed" note, line 85)
- Prior plan (landed): `docs/plans/2026-06-10-refactor-parsed-error-context-view-plan.md`
- Backend: `scripts/error_context.ts` (`parseDisplay`/`windowErrors`/`DISPLAY_PARSER_AGENTS`),
  `scripts/routes.ts` (`buildSessionErrors` `:147`, errors route `:351`, live-window `:362`),
  `scripts/wire.ts:20-91`, `scripts/db.ts` (`source_path`)
- Frontend: `ui/src/routes/Session.svelte` (tabbed host, Messages branch `:68-72`),
  `ui/src/lib/components/panels/{SessionFeed,SessionErrors}.svelte`, `ui/src/lib/api.ts`
  (`getSessionErrors` `:326`, `getJson` `:301`), `ui/src/lib/router.svelte.ts` (`tabFromSearch`,
  `navigate`), `ui/src/lib/format.ts`, MEMORY.md (red/green colorblind)
- Tests: `scripts/error_context.test.ts`, `scripts/routes.test.ts`,
  `ui/src/routes/Session.svelte.test.ts`, `ui/src/lib/components/panels/SessionErrors.svelte.test.ts`

## Next step

`/workflows:work docs/plans/2026-06-10-feat-parsed-transcript-cards-messages-tab-plan.md` — the plan
is execution-ready. Resolve Q1 (live-window threshold, assumed reuse-5min) and the `readableInput`
lift-to-shared decision inline during Phase 3.
