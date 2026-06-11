# Parsed Transcript cards for the Messages tab (ended sessions)

For an **ended** session, the Messages tab renders the session's **Transcript** as **Message cards** — one card per readable entry (user · assistant · thinking · tool), parsed on demand from the raw log by the same `parseDisplay` the Errors view uses. A still-**live** session keeps the raw byte-tail feed; it switches to cards once it ends. Amends [ADR-0005](0005-on-demand-parsed-error-context.md).

## Status

accepted — amends ADR-0005's "Messages stays whole **and raw**" stance. Builds on the **Message** / **Transcript** terms now in [CONTEXT.md](../../CONTEXT.md).

## Context

ADR-0005 split the session page into **Errors** (parsed, windowed around errored tool calls) and **Messages** (the raw byte-tail JSONL feed — explicitly "the complete, in-order transcript", the un-parsed source of truth). In practice the raw feed is hard to read: one Claude message is split across several JSONL lines, a `tool_use` and its `tool_result` are separate lines, and the content is escaped JSON. For an *ended* session you want to *read* what happened, not scan raw lines.

Meanwhile `parseDisplay(agent, file)` already turns a raw log into an ordered `DisplayMessage[]` — exactly a Transcript. The Errors view just *windows* it. So parsed Messages is un-windowed `parseDisplay`, not a new parser.

Two facts shaped the decision:

- The raw feed is a **live byte-tail** (last ~300 lines, no random access) built for watching *active* sessions. A live tail can't be reassembled into Messages mid-stream (cross-line message reassembly + tool pairing need the whole file). So parsing only makes sense once the file is complete.
- Real reasoning text is **Claude-only**: Codex `reasoning` items and Pi `thinking` blocks store `encrypted_content` (verified: Codex `summary` populated 0/34 across 8 recent files; Pi `thinking: ""`). So a *thinking* card can carry content only for Claude.

## Decision

- **Ended → parsed Transcript cards; live → raw tail.** The Messages tab branches on `session.ended_at` (null / within the live window = live → raw `SessionFeed`; else → cards from a new `GET /api/sessions/:id/messages`). **Auto-only — no raw/cards toggle.**
- **Reuse `parseDisplay`, un-windowed.** The new endpoint returns the whole `DisplayMessage[]`; the Errors endpoint keeps `windowErrors`. One parser, two views (whole vs windowed). Antigravity (no parser) returns `supported:false`, same as Errors.
- **Four card types: user · assistant · thinking · tool.** `parseDisplay` is enriched to emit *thinking* as its own Message instead of folding it into assistant text. A *tool* stays one card (call input + result/output + `✗` on error). This ripples into the Errors view's context windows (thinking becomes a distinct context Message) — an improvement, and the Errors parser tests are updated to match.
- **Thinking is text-gated.** A thinking Message is emitted only when readable thinking text exists → Claude-only in practice. No reasoning parsing for Codex/Pi, no empty placeholder cards.
- **Each Message carries a timestamp** (`ts`), rendered subtly; no model/token metadata on cards (that's the token panels' job).
- **No virtualization/paging.** The largest real sessions yield ~750 cards (6 MB / 16k-line files) and per-card text is already clipped; render all, keep cards compact (long tool output truncated, expandable — the Errors-view pattern).

## Considered and rejected

- **Keep Messages raw (ADR-0005 as-is).** Readable only by squinting at escaped JSON across split lines. The whole point of this change. Rejected.
- **Incrementally parse the live SSE tail into cards.** Would reimplement the parser in streaming form (cross-line reassembly, tool pairing on a 300-line window with no earlier context) — high effort, high drift risk against the adapters, and wrong for the tail's missing-history case. Rejected; live stays raw.
- **Raw ⇄ Cards toggle on ended sessions.** Keeps the raw log one click away (useful when the parser is wrong). Rejected for now (auto-only) to keep the tab simple; the raw log is still on disk.
- **"Reasoning hidden (encrypted)" placeholder cards for Codex/Pi.** Surfaces that the model reasoned, but carries no content. Rejected — empty cards are noise; text-gating is honest.

## Chosen layout (prototype)

A throwaway prototype (3 variants on the real Messages tab, `?variant=`) settled the card layout: **C — Grouped turns**. Each **user** prompt heads a turn section; the agent's thinking / assistant / tool Messages nest beneath on a left-gutter timeline (type-coloured dots). Rejected: A (flat chat-stream of full-width cards) and B (dense one-line-per-message log rows, click-to-expand). C won for making the prompt→response *structure* legible — you scan to the turn that matters, then read what the agent did. Tool cards stay expandable for long output (borrow from B). The prototype is deleted; the layout is folded into the real `SessionMessages` component.

## Consequences

- `parseDisplay` gains a *thinking* role and a per-Message `ts`; the Errors view inherits both (thinking now appears in context windows). The shared-parser coupling that ADR-0005 called out tightens — one more reason both views must stay test-pinned against the same fixtures.
- The Messages tab is no longer a guaranteed-complete *raw* record in the UI; for an ended session the raw JSONL is reachable only on disk (auto-only, no toggle). Accepted: the parser is resilient and falls back to raw text it can't structure.
- Coverage stays Agent-dependent (Claude/Codex/Pi parse; Antigravity falls back to a note). Thinking coverage is narrower still — Claude-only by the encryption reality, not by choice.
