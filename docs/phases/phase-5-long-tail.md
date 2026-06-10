# Phase 5 — Long-tail panels

> Status: ✅ Done · Depends on: 0–4 · Master refs: §16, §17 (Activity + Skills/MCP pages)

## Goal

Complete the **observability** surface. With all four agents flowing into the core panels, add the remaining panels — built **multi-agent from the start** (every panel gains the `agent` dimension), since all four adapters already exist.

## In scope (master §17)

- **Activity page** (`activity.tsx`): Patterns (`HeatmapGrid` 30-day + `ChartsStrip` 14-day, with agent dimension), Telemetry firehose (`OtelPanel`, SSE `/api/firehose`), Top skills + Unified failures, All-sessions table (searchable/paginated, filter by range/source/model/**agent**).
- **Command-page long-tail** (under the core section): Hook activity, Project breakdown (by `cwd`, home-dir strip — never hardcode a username), Agent fan-out, Edit-acceptance (`tool_decision`, low-sample badge), Productivity (OTEL `commit/PR/LoC` delta counters), Pressure (retry exhaustion + compaction + recent api_errors).
- **Skills & MCP page** (`skills.tsx`): Skill economics (`SkillCostCard`), Context health (read-only scan of `~/.claude/settings.json` + `CLAUDE.md`, no LLM) + Skills registry, MCP schema-size measurement (`/api/mcp/measure`).
- Corresponding API routes (master §16): `/api/hooks/activity`, `/api/sessions/by-project`, `/api/tools/agent-fanout`, `/api/tools/edit-decisions`, `/api/activity/productivity`, `/api/system/pressure`, `/api/skills*`.

## Out of scope

Operations features (Phase 6). Posture panel (explicitly **not** in the free build — master §17).

## Dependencies

Phases 0–4 (all adapters; panels gain the agent dimension uniformly).

## Deliverables

The long-tail panel components + their API routes, all agent-aware.

## Key decisions

- Built **after** cross-agent core visibility (breadth-first), so each long-tail panel is multi-agent on day one rather than retrofitted.
- Several long-tail panels are **Claude-richest** (Productivity/Edit-acceptance/Hooks lean on Claude OTEL); other agents show empty/low-sample states honestly.

## Stop conditions

1. All three routes render every long-tail panel with real data or proper empty states.
2. Agent-aware filters work (e.g. All-sessions table filters by agent; Patterns shows per-agent series).
3. Productivity counters use `SUM(value)` over delta-temporality OTEL metrics (master §12.2) and are correct.
4. No regression to core panels.

## Verification (demo)

Activity and Skills/MCP pages are fully populated; the All-sessions table filters across all four agents; Context health reflects the real `~/.claude` config.

## Risks & open questions

- **Agent coverage asymmetry** — OTEL-derived panels (Productivity, Edit-acceptance, Hooks) are Claude-only in practice; label empty states so it doesn't read as "broken."
- MCP schema measurement (`/api/mcp/measure`) can be slow — run off the request path.
