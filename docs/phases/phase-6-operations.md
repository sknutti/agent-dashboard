# Phase 6 — Operations layer (Claude-only)

> Status: Planned · Depends on: 0, 1 · Master refs: §16, §17 (HITL/Mission Control sections), §18, §19, §20, §21 · Note: this is the **write** half — it does not generalize across agents.

## Goal

Add the operations layer: dispatch tasks, approve decisions, get paged, and kill runaway sessions. This is **Claude-Code-only** by nature — it spawns and kills `claude -p` processes — so it ships last and alone, independent of the agent adapters. It is the largest Claude-specific chunk, so it is **sub-sliced** (6a–6d) and built in dependency order.

## Sub-slices

Two design rules drive the ordering: **safety ships with the capability to spawn** (emergency stop is in the same slice that first launches `claude -p`), and **stream-mode subprocess plumbing is quarantined to one slice** (everything before it runs on classic dispatch only).

| Slice | Scope | Dispatch mode | Depends on |
|---|---|---|---|
| **6a — Dispatch spine + safety** | `ops_*` schema · `task_tracker` · dispatcher classic mode · PID markers · `_buildEnv` · **emergency stop** · minimal TaskBoard/Composer · mission-control launchd plist | classic | Phase 0, 1 |
| **6b — Schedules** | heartbeat schedule materialization · cron parsing (`parse_cron_simple`, NL→cron via Haiku) · SchedulesCard/Composer · `ops_schedules` flows | classic | 6a |
| **6c — HITL + stream mode** | **stream-mode dispatch** · fence-aware `DECISION:`/`INBOX:` parse+inject · `ops_decisions`/`ops_inbox` · Decisions+Inbox panels · LiveSessionDetail follow-up box · AttentionBar | **stream (isolated here)** | 6a |
| **6d — Telegram bridge** (opt-in) | `setup_telegram` wizard · `notifier` (30s, plain-text, dedupe) · handler/bot/dash_router · second launchd plist | — | 6a (+6b/6c for richer pages) |

6b and 6c are independent siblings on top of 6a — **swappable** if you want live HITL before recurring tasks. As written, classic dispatch covers 6a+6b and stream mode doesn't appear until 6c.

## In scope (by slice)

**6a — Dispatch spine + safety**
- **Schema** (deferred from Phase 0): `ops_tasks`, `activities`, `live_session_state`, `system_state`, `notification_log` (master §14).
- **Mission Control core** (`.claude/skills/mission-control/`, ported to TS): `heartbeat` (launchd 120s — claim pending, `dispatcher.runOnce()`), `dispatcher` **classic mode** (`Popen(['claude','-p',…])`, `proc.communicate`, capture stdout→`output_summary`), `task_tracker` (atomic claim), `skill_router` (Haiku picker), `session_state_hook`. `_buildEnv()` sets telemetry env for spawned children (master §18).
- **Emergency stop** (master §19) — PID-file SIGTERM of dispatcher-launched `claude -p` children only; verify via `ps` argv; spare interactive; set `system_state.emergency_stop`.
- **Minimal Tasks** — TaskBoard/TaskComposer; routes `/api/tasks*`, `/api/dispatcher/trigger`, `/api/system/emergency-stop`.
- **launchd** `com.commandcentre.mission-control.plist`.

**6b — Schedules**
- `ops_schedules`; heartbeat materialization (`BEGIN IMMEDIATE`, `next_run_at` via cron); SchedulesCard/ScheduleComposer (master §17); routes `/api/schedules*`, `/api/schedules/parse-nl` (Haiku).

**6c — HITL + stream mode**
- `ops_decisions`, `ops_inbox`; dispatcher **stream mode** (PIPE stdin/stdout, reader threads, per-line JSON, `system/init` session_id stash); fence-aware `DECISION:`/`INBOX:` marker parse → `ops_decisions` (`INSERT OR IGNORE`) / POST inbox, answer injection via stdin once; Decisions+Inbox panels, LiveSessionDetail follow-up box, AttentionBar; routes `/api/decisions*`, `/api/inbox*`, `/api/sessions/live/{sid}/message`.

**6d — Telegram bridge (opt-in)** (master §20)
- `setup_telegram` wizard; `notifier` (30s loop, **plain-text only**, dedupe via `notification_log`); handler/bot/`dash_router`; `com.commandcentre.telegram-bot.plist` installed only if opted in.

## Out of scope

Any multi-agent dispatch (only Claude is driveable). Posture panel (not in free build).

## Dependencies

Phase 0 (schema migration helper, server, launchd), Phase 1 (Claude OTEL env for `_buildEnv`, live-session state). **Independent of Phases 2–5.**

## Deliverables

`ops_*` migrations, Mission Control TS modules, emergency-stop endpoint, HITL/Tasks/Schedules panels + routes, Telegram bridge + wizard, launchd templates.

## Key decisions

- Deferred to last per the (B) decision: cross-agent **observability** was the priority; **operations** is the lowest-priority, most Claude-specific slice.
- **PID files, not env scanning**, for child identification (macOS 12+ restricts env disclosure — master §19).
- **Telegram notifier is plain-text only** (markdown parsing on DB content with backticks fails silently → retry loops — master §20).

## Interface / schema / API detail

Master §18 (dispatcher/heartbeat/task_tracker), §19 (emergency stop), §20 (Telegram), §16 (ops API routes), §17 (HITL/Mission Control panels), §21 (install flow for launchd + Telegram wizard).

## Stop conditions (master §23, ops subset — per slice)

**6a:** Queue a classic task → dispatcher runs it end-to-end → output in TaskBoard done column. Emergency stop: dispatch a sleeping task → red button SIGTERMs that child **and** a separate interactive `claude -p` survives. `cc doctor` green incl. `launchctl list` for the mission-control plist.
**6b:** Create a schedule → `next_run_at` populates → past the time → a task materializes and runs (classic).
**6c:** A stream-mode task emitting a `DECISION:` marker pauses and is answerable from the Decisions panel (answer injected once); an `INBOX:` message round-trips; a live follow-up reaches a running session.
**6d:** A pending decision pages the phone; an inline button round-trips through `dash_router`; notifier never enters a markdown-parse retry loop (plain-text only).

## Verification (demo)

Queue a task from the UI, watch the dispatcher pick it up and complete it; trigger a DECISION marker and answer it from the Decisions panel (and/or Telegram); hit emergency stop and confirm only dispatched children die.

## Risks & open questions

- **Subprocess env inheritance** — children don't inherit `OTEL_*` automatically; `_buildEnv()` is load-bearing (master §12.2 #4).
- **Stream-mode marker parsing** must be fence-aware (skip ``` blocks) to avoid false DECISION/INBOX triggers.
- This phase is the largest single chunk of Claude-specific surface — consider sub-slicing (dispatcher core → HITL → Telegram) if it grows unwieldy.
