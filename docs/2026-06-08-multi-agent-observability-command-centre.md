# Multi-Agent Observability Command Centre — Master Guide & Build Spec

**Generated:** 2026-06-08
**Source Documents:**
- [Companion guide — "Reading Claude Code's Diary"](sources/build-your-own-dashboard-guide.html)
- [Build prompt — "Build Your Own Claude Code Dashboard"](sources/build-your-own-dashboard-prompt.md)
- [Token-Burn Dashboard guide (Nate Jones / unlock-ai)](https://unlock-ai.natebjones.com/guides/build-your-own-token-burn-dashboard)

---

## Executive Summary

You pay for AI coding agents and get back a billing number and almost nothing else — no tool latency, no MCP breakdown, no session history, no cache-hit rate, no sense of *where the money goes*. Yet every one of these agents already writes a detailed, forensic log of what it did to your own disk. Nothing is reading it.

This document specifies a **single local dashboard** — the "Command Centre" — that reads those logs, stores them in SQLite, and renders a dense, production-grade UI on `localhost`. It never phones home.

It combines three sources into one buildable spec, with two deliberate extensions requested during synthesis:

1. **The base** (Sources 1 + 2): a deep Claude Code observability + operations dashboard — 33 panels, Mission Control task dispatcher, human-in-the-loop approvals, Telegram pager, emergency stop. Python/FastAPI/SQLite backend, React/Vite frontend, macOS, localhost-only.
2. **A folded-in Burn view** (Source 3): a token-burn panel that reframes spend as a behavioral signal — "a bill tells you what happened; a burn dashboard changes behavior" — with daily heatmaps, trend lines, burn drivers, and scale equivalents.
3. **Multi-agent generalization** (synthesis request): the data layer becomes a pluggable **agent-adapter** model so the same dashboard tracks **Claude Code, Codex, Antigravity, and Pi** side by side, each labeled by measurement fidelity (exact vs. estimated).

The document is layered:
- **Part I — Orientation** explains *what this is and how the pieces connect* (narrative; read this first).
- **Part II — Multi-Agent & Burn Extension** specifies the new adapter model and Burn panel (synthesized design work).
- **Part III — Full Build Spec** is the exhaustive technical contract an engineer or coding agent builds from (appendices).

> **Provenance convention.** Throughout, `[guide]` = companion HTML, `[prompt]` = build prompt, `[burn]` = Nate Jones token-burn guide, `[synthesis]` = new design introduced to satisfy the multi-agent + folded-burn request.

---

# Part I — Orientation

## 1. The problem

On Pro/Max plans, Anthropic gives you a billing number and almost nothing else. No tool latency, no MCP server breakdown, no session history, no cache hit rate. `[guide]` The same blindness applies across every coding agent you run.

Meanwhile, burn rate is the most honest report card you have. It is "the clearest signal of whether you are getting fluent or just getting expensive." `[burn]` A bill tells you what happened last month; a live burn dashboard changes what you hand to the computer tomorrow.

The usual "solution" online rebuilds this as an eight-microservice war room with voice avatars and agent faces — a second full-time job to maintain. `[guide]` There is a quieter option: **read the data your agents already write to disk, and show it to yourself.**

## 2. Where the data lives — every agent keeps a diary

Each supported agent writes per-session logs locally. The dashboard ingests them. `[synthesis, grounded by research]`

| Agent | Path | Format | Token fidelity | Native USD cost | Telemetry |
|---|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<project-hash>/<session-id>.jsonl` | JSONL, one event per line | **Exact** | ✅ `total_cost_usd` | ✅ **built-in** — logs+metrics (traces beta) to your `/v1/*` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (`CODEX_HOME` default `~/.codex`) | JSONL `{type, timestamp, payload}` envelope | **Exact** | ❌ tokens only | ✅ **built-in, opt-in** — `[otel]` in `config.toml` |
| **Pi** ([pi.dev](https://pi.dev)) | `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl` (one dir per working dir; tree-structured `id`/`parentId`) | JSONL `{type, id, parentId, timestamp, message}` | **Exact** | ✅ per-message `usage.cost` | ⚙️ **plugin** — `pi install npm:pi-otel` |
| **Antigravity** (`agy` CLI) | `~/.gemini/antigravity-cli/conversations/<conv-id>.db` (SQLite) + `brain/<conv-id>/.system_generated/logs/transcript_full.jsonl` | SQLite (protobuf blobs) + JSONL step transcript | **Exact** (protobuf-decoded, §10.2) | ❌ (no native cost) | ❌ **Sentry→Google only** (no local OTLP — verified) |

> *Verified against real files on this machine: Claude Code (461 sessions), Codex (306), Pi (13), Antigravity/`agy` (3 conversations). **Antigravity corrections:** (1) `agy` stores under `~/.gemini/antigravity-cli/` (not `~/.gemini/antigravity/`). (2) **Token usage WAS reverse-engineered** from the conversation `.db` protobuf — `gen_metadata` holds one usage submessage per LLM generation; the field map is in §10.2 and the output invariant `f3 = f9 + f10` was validated across 89/89 generations. So Antigravity now contributes tool/latency **and** exact token counts; only USD cost is absent (no native cost field).* `[synthesis, grounded + RE]`

For Claude Code specifically there are **two** sources `[prompt]`:

- **Session JSONLs (always on).** One file per session; each line is a JSON event — every tool call, every token, every message. Inside: `user`/`assistant` messages with `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`); `tool_use` blocks (`id`, `name`, `input`); `tool_result` blocks (paired by `tool_use_id`); `result` events at session end (`total_cost_usd`, `duration_ms`, `is_error`, `stop_reason`).
- **OTEL telemetry (opt-in).** A real-time event firehose POSTed to any URL you specify — cleaner than JSONL. Your dashboard *is* the endpoint.

> **The clean architectural finding:** all four agents emit **JSONL**. The Claude Code JSONL ingest model (stash `tool_use` by id, pair `tool_result`, compute duration, roll up tokens by day) generalizes to every agent through a thin per-agent adapter. Only Claude Code layers OTEL on top. `[synthesis]`

### Fidelity is not optional `[burn]`

Some numbers are measured; some are estimated. **Do not let estimates cosplay as measurements.** Every token figure in the UI carries an explicit `exact` / `estimated` label. For the four CLI agents above, local logs give *exact* counts. If you later add chat surfaces (Claude chat, ChatGPT) that have no local token export, those are *estimated* — calibrated from message counts / exports — and must be visually distinguished.

## 3. How it connects — your laptop is both the source and the sink

The dashboard runs a small web server on `localhost:8765`, ingests every configured source, stores everything in one SQLite file, and renders the UI. **Zero outbound network calls.** `[guide]`

```
┌─ You use the agents normally ──────────────────────────────────────────┐
│  Claude Code → ~/.claude/projects/   (+ emits OTEL over HTTP POST)      │
│  Codex       → ~/.codex/sessions/                                       │
│  Antigravity → ~/.gemini/antigravity/brain/.../logs/                    │
│  Pi          → ~/.pi/agent/sessions/                                    │
└────────────────────────────────────────────────────────────────────────┘
                              │  (agent adapters scan JSONL + OTEL ingest)
                              ▼
                  ┌──────────────────────────┐
                  │  Local server            │
                  │  FastAPI on :8765        │
                  └──────────────────────────┘
                              │  raw SQL
                              ▼
                  ┌──────────────────────────┐
                  │  SQLite (one file, WAL)  │
                  └──────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────┐
                  │  Dashboard UI (React)    │
                  └──────────────────────────┘

  Optional extensions: Mission Control scheduler · HITL approvals ·
  Telegram pager · task dispatcher · emergency stop
```

The free build gets you ingest → store → render across all configured agents. The optional row (Mission Control, HITL, Telegram, emergency stop) is the operations layer. `[guide]`

## 4. What "OTEL" actually is (plain English) `[guide]`

**OpenTelemetry (OTEL)** is the standard most developer tools use to emit "what's happening right now" events. It's a spec — a shape for the data — plus an endpoint format (`POST /v1/logs`, `POST /v1/metrics`). Claude Code supports it. You tell Claude Code to send telemetry to *any* OTEL endpoint you want. The dashboard on your laptop **is** an OTEL endpoint. Point Claude Code at `http://localhost:8765` and you're suddenly reading your own agent's firehose — no hosted service, no enterprise plan, no paywall between you and your data.

## 5. What you'll see — the panels at a glance

The full build has 33 panels across three pages, plus the folded-in Burn view (34). The six that justify the whole project `[guide]`:

| # | Panel | Question it answers |
|---|---|---|
| 1 | **Live sessions** | "What's running right now?" |
| 2 | **Token usage** | "Where is my money going?" |
| 3 | **Tool latency** | "Which tool is slow?" |
| 4 | **MCP server drill-down** ★ centerpiece | "Which MCP is costing me real time?" — catches the 14-second Notion call everyone has and doesn't know about |
| 5 | **Session outcomes** | "How often does my work finish cleanly?" |
| 6 | **Cache efficiency** | "Am I getting value from prompt caching?" (target 70%+) |
| 34 | **Burn** ◆ folded-in | "Am I getting fluent, or just getting expensive?" — cross-agent daily burn, drivers, scale equivalents `[burn]` |

The remaining panels (activity heatmaps, telemetry firehose, skills economics, MCP schemas, HITL inbox, task board, schedules) are detailed in Part III.

## 6. Privacy model — why this stays on your Mac `[guide]` `[burn]`

- **Bind `127.0.0.1`.** The server is reachable only from your laptop. Never `0.0.0.0`.
- **No cloud.** No SaaS account, no remote database, no outbound sync.
- **SQLite on disk.** One file. Delete it anytime; it rebuilds on next sync.
- **Zero telemetry out.** The dashboard collects nothing about you, ever.
- **Keep raw exports out of any repo you publish.** `[burn]` If you ever deploy a *public* version, commit only normalized totals you're comfortable sharing — generic drivers, anonymized counts. Private dashboards can name real work; public ones cannot.

## 7. Prerequisites `[guide]` `[prompt]`

- **Platform:** macOS 12+ (JSONL paths + install script are macOS-specific today; Linux later).
- **Runtime:** Python 3.10+ (3.9 works with `from __future__ import annotations`). `brew install python@3.12` if needed.
- **At least one agent run once.** The installer reads `~/.claude/projects/` (and the other agents' dirs) — make sure they exist by running each agent at least once.
- **Node 20+** for the frontend build (Vite). `[burn]` (Node was Source 3's whole stack; here it's only the UI toolchain.)

## 8. How to enable it — 3 steps `[guide]`

The build ships a helper that does this for you, backing up your settings first.

1. **Add six env keys to `~/.claude/settings.json`** — turns on telemetry and points Claude Code at your local dashboard. The setup helper backs up the file first and only adds keys that aren't already there; it never overwrites your config.
2. **Quit Claude Code and reopen it.** Env vars apply only to new sessions.
3. **Run a prompt — events flow in ~30 seconds.** Open `http://localhost:8765`. First load may show empty panels for a few seconds (initial JSONL sync), then live data lights up.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:8765",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_LOG_TOOL_DETAILS": "1"
  }
}
```

> **Don't edit by hand.** The setup script backs up `settings.json` before writing and only adds missing keys. `[guide]` Codex, Antigravity, and Pi need no env changes — their JSONL is always on; the adapters just read it. `[synthesis]`

## 9. Two ways in `[guide]`

- **Option A · Free · Build it yourself.** Copy the build prompt (Part III), paste it into a fresh agent session, let it cook (~2 hours). You get a working version of all the panels on your own laptop. Keep it, tweak it, fork it.
- **Option B · Community · Skip the build.** The author's production build ships the parts the prompt leaves out — HITL approvals, scheduled tasks, Telegram pager, posture audits, emergency stop — plus support and office hours, installable in one command. (See `https://www.skool.com/ainative`.)

---

# Part II — Multi-Agent & Burn Extension `[synthesis]`

This part specifies the two requested additions. It sits *on top of* the Part III spec — read Part III for the base schema/API it extends.

## 10. The agent-adapter model

The base prompt hardcodes Claude Code. Generalize it. Introduce an **`AgentAdapter`** interface; each agent is a small module that knows how to find and parse its own logs into the shared row shapes.

### 10.1 Adapter interface

```python
# scripts/adapters/base.py
class AgentAdapter(Protocol):
    agent_id: str          # "claude_code" | "codex" | "antigravity" | "pi"
    display_name: str      # "Claude Code", "Codex", ...
    fidelity: str          # "exact" | "estimated"
    enabled: bool          # from config

    def session_glob(self) -> list[Path]: ...
    # Yield normalized events: token usage, tool_use/result pairs,
    # session start/end. The orchestrator writes rows to the shared tables.
    def parse_session(self, path: Path) -> Iterable[NormalizedEvent]: ...
    def supports_otel(self) -> bool: ...   # only Claude Code → True today
```

### 10.2 Concrete adapters — grounded field maps

The Claude Code, Codex, and Pi maps below were extracted from **real session files on this machine**; build directly against them. Antigravity is deferred (not installed).

**`claude_code`** — glob `~/.claude/projects/*/*.jsonl`. Full existing logic (Part III §15). OTEL on top. Cost from `result.total_cost_usd`.

**`codex`** — glob `$CODEX_HOME/sessions/**/*.jsonl` (date-bucketed `YYYY/MM/DD/`). Every record is `{type, timestamp, payload}`. Record `type` ∈ {`session_meta`, `turn_context`, `response_item`, `event_msg`}.

| Field needed | Source |
|---|---|
| `session_id` | `session_meta.payload.id` (UUID; also in filename) |
| `started_at` / `ended_at` | `event_msg/task_started.payload.started_at` / `task_complete.payload.completed_at` (+ `duration_ms`) |
| `cwd` | `session_meta.payload.cwd` / `turn_context.payload.cwd` |
| `model` | `turn_context.payload.model` (e.g. `gpt-5.4`); provider `session_meta.payload.model_provider` |
| tokens | `event_msg/token_count.payload.info.total_token_usage` → `input_tokens`, `cached_input_tokens` (→ cache_read), `output_tokens` (+ `reasoning_output_tokens`), `total_tokens`. **Use the last `total_token_usage` in the file as the session total** (cumulative). No `cache_create` concept. |
| tool calls + latency | `response_item/function_call` (`name`, `arguments`, `call_id`) ↔ `response_item/function_call_output` (`call_id`, `output`); shell tools also in `event_msg/exec_command_end` with real `duration`, `exit_code`, `command`, `call_id` |
| outcome | `task_complete` present → ok; `exit_code`≠0 / errors → flag |
| cost | none → tokens-only (hybrid policy, §11) |

**`pi`** — glob `~/.pi/agent/sessions/**/*.jsonl` (one dir per cwd-slug). Every record is `{type, id, parentId, timestamp, message}`; **tree-structured via `parentId`**. Record `type` ∈ {`session`, `message`, `model_change`, `thinking_level_change`}.

| Field needed | Source |
|---|---|
| `session_id` | `session` record `.id` (UUID; also in filename) |
| `cwd` | `session` record `.cwd` |
| `model` | `message.message.model` / `.provider` on `assistant` rows (or `model_change.modelId`) |
| tokens | `assistant` rows: `message.message.usage` → `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`. **Sum across ALL branches** (decision §10.6) |
| cost (USD) | `message.message.usage.cost.total` — **native per-message USD** ✅ |
| tool calls | `message.message` role `toolResult` → `toolName`, `toolCallId`, `isError`; latency = `toolResult.timestamp − issuing assistant.timestamp` (cap 10 min) |
| outcome | `assistant.stopReason`; any `toolResult.isError` → error_count |
| branches | count distinct branch tips (leaf `id`s) → store as session metadata |

**`antigravity`** (`agy` CLI) — data root `~/.gemini/antigravity-cli/`. Conversation id = `brain/<conv-id>/` dir name = `conversations/<conv-id>.db` filename. **Two parse paths, both grounded from real files:**

*Tool/step activity* — glob `brain/*/.system_generated/logs/transcript_full.jsonl`; each record `{type, content, created_at, source, status, step_index}`.

*Token usage (reverse-engineered)* — from `conversations/<conv-id>.db`, table **`gen_metadata`** (one BLOB row per LLM generation). Decode the protobuf with a raw wire-format reader (no `.proto` needed). Usage submessage is at path **field `1` → field `4`** (mirrored at `17.2`):

| Wire field | Pattern (verified) | Meaning | Confidence |
|---|---|---|---|
| `1` | constant `1020` | system-prompt tokens (cached/fixed) | high |
| `2` | variable | **input/context tokens** | high |
| `6` | constant `24` | fixed input overhead | medium |
| `3` | **`== 9 + 10`** (89/89 gens) | **total output tokens** | proven |
| `9` | variable | output split — reasoning/thoughts | label inferred |
| `10` | variable | output split — response text | label inferred |
| `8` | `{1:"sessionID", 2:<id>}` | session id kv | — |
| `11` | string | request id | — |

Per generation: **input = f1 + f2 + f6**, **output = f3**. Session totals = `SUM` over all `gen_metadata` rows. (`gen_metadata` is empty for trivial/aborted conversations — fall back to tools-only there.)

| Field needed | Source |
|---|---|
| `session_id` | conversation id (dir/`.db` name) |
| `cwd` | `trajectory_metadata_blob` protobuf (`file:///…`) or `history.jsonl` `workspace` (best-effort) |
| tool calls + latency | transcript step records (`type`, `step_index`, `created_at`, `status`) |
| **tokens** | ✅ `gen_metadata` protobuf, field `1.4` map above — `fidelity='exact'` |
| cost | ❌ none → tokens-only under the hybrid policy |

**Antigravity fidelity:** `tokens` exact (decoded), tools/latency exact, **no USD**. Write the protobuf reader defensively (per-row try/except; skip rows where `1.4` is absent). The f9/f10 *labels* and treating f1 as cache-read are inferences — the input/output **totals** are solid.

### 10.6 Pi branch accounting `[decided]`

Pi stores branches (re-runs, edits, `/tree` navigation) in one file as a parentId tree. **Burn sums every `assistant` row's `usage` across all branches** — you were billed for abandoned branches, so this is the true spend. The latest linear path is *not* used for totals. Branch count is kept as session metadata for context.

### 10.3 Configuration

A single config block enumerates adapters. `[synthesis]` Add to `.env` / `config` and a YAML for paths:

```yaml
# config/agents.yaml  (installer auto-detects + pre-enables present dirs)
agents:
  claude_code: { enabled: true,  path: "~/.claude/projects",     glob: "*/*.jsonl",          otel: true,  cost: native }
  codex:       { enabled: true,  path: "~/.codex/sessions",      glob: "**/*.jsonl",         otel: false, cost: none   }
  pi:          { enabled: true,  path: "~/.pi/agent/sessions",   glob: "**/*.jsonl",         otel: false, cost: native }
  antigravity: { enabled: true,  path: "~/.gemini/antigravity-cli", glob: "brain/*/.system_generated/logs/transcript_full.jsonl", otel: false, cost: none, tokens: protobuf_db }
```

The installer auto-detects which directories exist and pre-enables those; the others render a "not detected" empty state rather than erroring. (On this machine all four are present → enabled.) The `cost` flag drives the hybrid USD policy (§11.5): `native` → show real USD, `none`/`unknown` → tokens-only, never fabricated. `tokens: protobuf_db` tells the Antigravity adapter to read token usage by decoding the conversation `.db` protobuf (§10.2) rather than from the JSONL transcript; Antigravity now appears in token/burn aggregates (tokens-only, no USD) **and** tool-latency/session panels.

### 10.4 Schema deltas to the base spec

The base schema (Part III §14) is Claude-Code-centric via a `source` column (`ide`/`cowork`). Generalize:

- **`sessions`** — add `agent TEXT NOT NULL DEFAULT 'claude_code'` and `fidelity TEXT NOT NULL DEFAULT 'exact'`. Keep `source` for ingest-origin (`ide`/`cowork`) where it still applies; `agent` is the new primary grouping dimension.
- **`token_usage`** — change the rollup key from `(date, model, source)` to `(date, agent, model, source)`. Every burn/usage query groups or filters by `agent`.
- **`tool_calls`** — add `agent TEXT`. Index becomes `(agent, tool_name, ts)`.
- **`burn_daily`** *(new table)* — the normalized daily-burn rollup that backs the Burn panel (see §11.2).

All additions go through the existing idempotent `_migrate_add_column(conn, table, col, type)` helper — no destructive migration.

### 10.5 Sync orchestration

Replace the single `sync_sessions.py` with an orchestrator that fans out over enabled adapters:

- `scripts/sync_agents.py` — on boot and every 120s, for each enabled adapter: `session_glob()` → for each file newer than `synced_at` or with `ended_at IS NULL`, `parse_session()` → write `sessions` / `token_calls` / `token_usage` rows tagged with `agent` + `fidelity`.
- `scripts/sync_sessions.py` is retained as the **Claude Code adapter implementation** (the reference parser), now invoked through the orchestrator.
- OTEL ingest (`/v1/logs`, `/v1/metrics`) stays Claude-Code-only for now; rows carry `agent='claude_code'`.

## 11. The Burn panel (folded-in Source 3) `[burn]` `[synthesis]`

Source 3 was a standalone Node/Vercel app. Here its *ideas* become **Panel 34 — Burn**, a native panel in the existing React/FastAPI dashboard, fed by the multi-agent `burn_daily` table. No second stack, no Vercel.

### 11.1 What it shows (five sub-views, adapted from Source 3's five panels)

1. **Daily burn heatmap** — GitHub-style 30/90-day grid, **logarithmic color scale** for per-day total tokens. (Distinct from the existing activity HeatmapGrid: this one is spend-weighted and cross-agent.)
2. **Weekly trend line** — smoothed direction indicator on a **log y-axis**; "fluent or just expensive?" framing in the subtitle.
3. **Burn drivers** — categorize each day's spend by work type: `shipping` / `research` / `review` / `video` / `admin`. Driver is a tag on `burn_daily.driver`; default heuristic from dominant project/branch, user-overridable.
4. **Scale equivalents** — human-readable translations of token counts **with the math visible** ("≈ N novels", "≈ M hours of output at your avg rate"). Never hide the arithmetic.
5. **Moving-average table** — 30-day rolling receipts, **exact vs. estimated labels side-by-side per agent**. One row per day; columns per agent + total.

### 11.2 Data shape

Normalize daily totals into one row per local-timezone day `[burn]`:

```sql
CREATE TABLE IF NOT EXISTS burn_daily (
  date            TEXT NOT NULL,   -- YYYY-MM-DD, local time
  agent           TEXT NOT NULL,   -- claude_code | codex | antigravity | pi
  tokens          INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL,            -- NULL when agent has no native cost (hybrid policy, §11.5)
  fidelity        TEXT NOT NULL,   -- exact | estimated
  driver          TEXT,            -- shipping|research|review|video|admin
  evidence        TEXT,            -- scrubbed note
  PRIMARY KEY (date, agent)
);
```

This mirrors Source 3's normalized JSON (`date`, per-source tokens, `total`, `driver`, `evidence`) but as a queryable table keyed by `(date, agent)`. `cost_usd` is populated only for agents with native cost (Claude Code, Pi); `NULL` for Codex/Antigravity, which display tokens-only. "Get this right and the UI becomes straightforward." `[burn]`

### 11.3 API

- `GET /api/burn?range=30d|90d&agent=all|<id>` — daily rows, per-agent breakdown + totals, each tagged `exact`/`estimated`, plus computed scale-equivalents and the moving average. Local-time bucketing.
- `PATCH /api/burn/{date}` — set/override `driver` and `evidence` for a day.

### 11.4 Placement

On the **Command page (index.tsx)**, add the Burn panel as a collapsible section directly under **Token usage (panel 6)** — they answer adjacent questions ("where is my money going?" → "is that spend making me fluent?"). Reuse `CollapsibleSection`, the log-scale chart helpers, and the `StatePill` for fidelity badges.

### 11.5 Behavioral framing (copy, not just charts) `[burn]`

The panel's empty/low-data state should *teach*: "A bill tells you what happened. A burn dashboard changes behavior." When estimates are present, show the interview prompt ethos — the dashboard earns its keep when it changes what you hand to the computer tomorrow, so make drivers easy to annotate.

## 12. OTEL ingest, generalized `[synthesis, verified 2026-06-08]`

Three of the four agents are first-party OTEL emitters. This makes OTEL a *second ingest path* alongside JSONL — **OTEL-first where available, JSONL as the always-on fallback and historical backfill.** Each agent points its OTLP exporter at the dashboard's `/v1/*` endpoints; the server already accepts OTLP/HTTP JSON.

### 12.1 Per-agent OTEL status & enablement

| Agent | OTEL | How to enable | What you get |
|---|---|---|---|
| **Claude Code** | ✅ built-in (core) | 6 env keys in `~/.claude/settings.json` `env` (§8); add traces with `OTEL_TRACES_EXPORTER=otlp` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | logs (`/v1/logs`), metrics (`/v1/metrics`), traces beta (`/v1/traces`) |
| **Codex** | ✅ built-in, opt-in | `[otel]` block in `~/.codex/config.toml` (`exporter = "otlp-http"`, endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT`, `log_user_prompt = false`) | logs (API/SSE/tool approvals+results) + metrics (counters + duration histograms); `service.name = codex-cli`. Note ≤ v0.117.0 `codex exec`/`mcp-server` lacked metrics — this machine runs v0.121.0 (re-verify live) |
| **Pi** | ⚙️ plugin | `pi install npm:pi-otel`, then `/otel start`; config in `~/.pi/agent/settings.json` + `OTEL_*` env | traces/metrics/logs over OTLP — one trace tree per turn; metrics include token usage (input/output/cache), LLM latency, tool-exec time; logs `pi.session.start/end`, `pi.tool.error` |
| **Antigravity** | ❌ none usable | only an `enableTelemetry` boolean → ships to Google (Sentry, hardcoded `antigravity-unleash.goog`). **No `OTEL_EXPORTER_OTLP_ENDPOINT`, no local OTLP** (verified statically + live: zero local POSTs). | — not needed: tokens come from the `.db` protobuf (§10.2), tools from the JSONL transcript. Do **not** enable the toggle (leaks to Google) |

### 12.2 Claude Code emits far more than the base spec consumes

The base `/api/activity/productivity` only reads commit/PR/LoC counters. Claude Code's real OTEL surface (authoritative, docs dated 2026-06-05):

- **Metrics** — `claude_code.session.count`, `claude_code.token.usage` (attr `type` = input|output|cacheRead|cacheCreation), **`claude_code.cost.usage`** (USD; attrs `model`, **`mcp_server.name`, `mcp_tool.name`, `skill.name`, `agent.name`, `plugin.name`**), `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`, `claude_code.lines_of_code.count`, `claude_code.{commit,pull_request}.count`. Default export interval **60s**; temporality **delta** (so `SUM(value)` is correct — matches the spec's productivity note).
- **Log events** (`event.name`, **namespaced**) — `claude_code.user_prompt`, `claude_code.api_request`, `claude_code.api_error`, `claude_code.api_refusal`, `claude_code.tool_result`, `claude_code.tool_decision`, `claude_code.permission_mode_changed`, `claude_code.mcp_server_connection`. Export interval **5s**.
- **Traces (beta)** — spans `claude_code.interaction` / `claude_code.llm_request` (token + `ttft_ms` + cache attrs) / `claude_code.tool` (with `tool.blocked_on_user` + `tool.execution` children) / `claude_code.hook`.
- **Redaction is default-off** — `OTEL_LOG_TOOL_DETAILS=1` (already in §8) unlocks MCP tool names + tool args; `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_RAW_API_BODIES` stay off (privacy).

**Design implications** (apply in Part III):
1. **Token usage, cost, MCP attribution, skill economics, and edit-acceptance can be sourced directly from OTEL metrics** — pre-tagged with `mcp_server.name`/`skill.name`, no `mcp__server__tool` string-parsing. Treat OTEL metrics as the *enrichment/precise* source and JSONL as the always-on baseline.
2. **The ingest parser must match both bare and `claude_code.`-namespaced `event.name`** (`tool_result` *and* `claude_code.tool_result`).
3. **Add a `POST /v1/traces` endpoint** (the spec only had `/v1/logs` + `/v1/metrics`). Store spans in an `otel_spans` table (or fold into `otel_events`); traces give cleaner tool/hook latency than JSONL timestamp-pairing. Beta — guard against schema drift.
4. **Subprocesses don't inherit `OTEL_*`.** The Mission Control dispatcher's `_build_env()` setting telemetry env for each spawned `claude -p` is load-bearing, not incidental (§18).

### 12.3 OTEL-first vs JSONL-fallback (the rule)

For each agent, per dimension: **prefer OTEL when telemetry is on and the event is present; fall back to JSONL otherwise.** JSONL is never removed — it's the only source for history before telemetry was enabled, and the only source at all for Antigravity. Sync orchestration (§10.5) writes both; queries coalesce (OTEL precise → JSONL pairing → legacy), exactly as the MCP per-tool endpoint already specifies.

---

# Part III — Full Build Spec (Appendix)

> This is the exhaustive build contract, drawn from the build prompt `[prompt]`, with multi-agent deltas from Part II marked inline as `[+MA]`. To build with an agent, you can paste this part wholesale. Where Part II generalizes a Claude-Code-specific detail, the Part II version wins.

## 12. Mission, audience, stack

**Mission.** Rebuild a daily-driver Claude Code command centre as an exact-fidelity local clone. Quality bar: Linear / Raycast / Vercel — dense signal, dark theme, dialed-in typography, tasteful motion, production-grade polish. Runs entirely on the laptop; no cloud, no account, no outbound telemetry. `[+MA]` Generalize ingest to track Claude Code, Codex, Antigravity, and Pi.

**Audience.** A solo developer on Pro/Max who wants to see what their agents are doing, queue tasks, approve decisions from a dashboard, get pinged on Telegram when things break, and kill runaway sessions with one button — without maintaining eight microservices.

**Stack (directive).**
- **Backend:** Python 3.10+ (3.9 works with `from __future__ import annotations`), FastAPI, uvicorn, SQLite with WAL mode, single `.db` file, raw SQL (no ORM).
- **Frontend:** Vite + React 18 + TypeScript + Tailwind CSS + TanStack Router (file-based) + React Query (30s polling) + Framer Motion + `lucide-react`. Pre-built `ui/dist/` served by FastAPI as static.
- **Testing:** Playwright e2e in `ui/tests/e2e/` covering main pages, command palette, schedule composer, theme toggle.
- **No:** Postgres, Supabase, Pinecone, external auth, WebSockets for observability (SSE where needed), Cloudflare tunnels, voice interfaces, agent avatars.

## 13. Project layout

```
command-centre/
├── scripts/
│   ├── server.py            FastAPI app, all /api/*, /v1/logs, /v1/metrics
│   ├── db.py                SQLite schema + idempotent migrations helper
│   ├── sync_agents.py       [+MA] orchestrator: fan out over enabled adapters
│   ├── adapters/            [+MA] base.py + claude_code.py + codex.py + antigravity.py + pi.py
│   ├── sync_sessions.py     Claude Code adapter (reference JSONL parser)
│   ├── sync_cowork.py       Scrape Cowork audit.jsonl (optional)
│   ├── sync_skills.py       Rebuild skills registry
│   ├── live_sessions.py     In-flight session detection
│   ├── mcp_analyzer.py      MCP stats + per-server/per-tool latency
│   ├── notifier.py          Telegram outbound (30s loop, idempotent)
│   ├── setup_otel.py        Interactive OTEL wizard (backup + merge)
│   ├── setup_telegram.py    Interactive Telegram wizard (BotFather flow)
│   └── doctor.py            Deterministic health check (no LLM)
├── config/
│   └── agents.yaml          [+MA] per-adapter enable + path + otel flags
├── ui/
│   ├── src/
│   │   ├── routes/          index.tsx, activity.tsx, skills.tsx, __root.tsx
│   │   ├── components/
│   │   │   ├── ui/          Card, Button, Sheet, Badge, StatePill, Tooltip, CollapsibleSection
│   │   │   ├── panels/      All 33 panels (+ BurnCard [+MA])
│   │   │   └── layout/      AppShell, CommandPalette, nav
│   │   ├── hooks/useQueries.ts
│   │   └── lib/api.ts
│   ├── tests/e2e/
│   └── dist/
├── .claude/skills/
│   ├── mission-control/     dispatcher.py, heartbeat.py, task_tracker.py, skill_router.py, session_state_hook.py
│   └── telegram/            telegram_handler.py, telegram_bot.py, telegram_send.py, dash_router.py, message_db.py
├── templates/launchd/       com.commandcentre.{mission-control,telegram-bot}.plist.template
├── data/                    SQLite DB (created on install)
├── install.sh               One-command installer with wizard
├── cc                       Launcher shim: cc start|stop|restart|doctor|setup|sync|logs
├── requirements.txt         fastapi, uvicorn, pydantic, pyyaml, requests, python-dotenv
├── .env.example
├── README.md
├── ARCHITECTURE.md
└── HANDOVER.md
```

## 14. Database schema

All `CREATE TABLE IF NOT EXISTS`, WAL mode, idempotent `_migrate_add_column(conn, table, col, type)`. Core tables:

- **`sessions`** — one row per session. `session_id` PK, `source` (`ide`/`cowork`), **`agent` `[+MA]`**, **`fidelity` `[+MA]`**, `cwd`, `git_branch`, `model`, `started_at`, `ended_at`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_create_tokens`, `total_tokens`, `effective_tokens`, `cost_usd`, `duration_ms`, `error_count`, `rate_limit_hit`, `stop_reason`, `title`, `synced_at`.
- **`token_usage`** — daily rollup per **`(date, agent, model, source)` `[+MA]`** (was `(date, model, source)`). `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_create_tokens`.
- **`tool_calls`** — per invocation. `session_id`, **`agent` `[+MA]`**, `tool_use_id`, `tool_name`, `ts`, `duration_ms` (nullable), `error` (nullable). Index `(agent, tool_name, ts)`.
- **`burn_daily`** `[+MA]` — see §11.2.
- **`otel_events`** — every OTLP log event. Cols: `event_name`, `session_id`, `prompt_id`, `timestamp`, `model`, `tool_name`, `tool_success`, `tool_duration_ms`, `tool_error`, `cost_usd`, `api_duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_create_tokens`, `speed`, `error_message`, `status_code`, `attempt_count`, `skill_name`, `skill_source`, `prompt_length`, `decision`, `decision_source`, `request_id`, `tool_result_size_bytes`, `mcp_server_scope`, `plugin_name`, `plugin_version`, `marketplace_name`, `install_trigger`, `mcp_server_name`, `mcp_tool_name`, `received_at`.
- **`otel_metrics`** — `metric_name`, `metric_type`, `value`, `session_id`, `model`, `timestamp`.
- **`ops_tasks`** — task queue. `id` PK, `title`, `description`, `status` (`pending`/`awaiting_approval`/`running`/`done`/`failed`/`cancelled`), `priority`, `assigned_skill`, `model`, `execution_mode` (`classic`/`stream`), `scheduled_for`, `requires_approval`, `risk_level`, `dry_run`, `quadrant` (`do`/`schedule`/`delegate`/`archive`), `approved_at`, `session_id`, `started_at`, `completed_at`, `duration_ms`, `cost_usd`, `output_summary`, `error_message`, `consecutive_failures`, `created_at`.
- **`ops_schedules`** — `id`, `name`, `cron_expression`, `task_title`, `task_description`, `assigned_skill`, `enabled`, `next_run_at`, `last_run_at`, `created_at`.
- **`ops_decisions`** — HITL Q&A. `id`, `task_id`, `session_id`, `prompt`, `answer`, `status` (`pending`/`answered`), `created_at`, `answered_at`. Partial `UNIQUE(session_id, prompt) WHERE session_id IS NOT NULL` to dedupe marker lines.
- **`ops_inbox`** — non-blocking messages. `id`, `task_id`, `session_id`, `direction` (`agent_to_user`/`user_to_agent`), `body`, `read`, `created_at`.
- **`activities`** — append-only log. `event_type`, `detail`, `metadata` (JSON), `created_at`. Types: `heartbeat`, `notifier_heartbeat`, `sync_loop_heartbeat`, `loop_detected`.
- **`live_session_state`** — realtime state from a hook. `session_id`, `state`, `current_tool`, `updated_at`.
- **`mcp_stats`** — `server`, `tools`, `total_tokens`, `error`, `measured_at`.
- **`mcp_schemas`** — `server`, `tool`, `schema_json`, `tokens`, `collected_at`.
- **`skills`** — `name`, `environment` (`ide:project`/`ide:global`/`cowork:plugin`/`cowork:scheduled`), `description`, `path`, `autonomy_level` (`auto`/`review`/`manual`), `user_invocable`, `script_count`, `last_modified`.
- **`system_state`** — KV. `key`, `value`, `updated_at`. Known keys: `emergency_stop` (`"1"`/`"0"`).
- **`notification_log`** — Telegram dedupe. `event_type`, `event_key`, `sent_at`, `chat_id`, `telegram_message_id`, `snoozed_until`. `UNIQUE(event_type, event_key, chat_id)`.

## 15. Ingest layer

### JSONL sync — Claude Code reference (`scripts/sync_sessions.py`)

On boot and every 120s (lifespan loop), scan `~/.claude/projects/*/*.jsonl`. For each session:
- Parse line-by-line.
- On `tool_use`: stash `(id, name, timestamp)` in a per-session map.
- On `tool_result`: look up by `tool_use_id`, compute duration (**cap at 10 min** — longer is an orphan from a crashed session), write row to `tool_calls`.
- Accumulate token usage by model; write daily rows to `token_usage` with **`DATE(timestamp, 'localtime')` bucketing** (local time everywhere — UTC bucketing breaks evening sessions).
- On session end: upsert `sessions` row with totals. Re-parse if `ended_at IS NULL` (still active) or JSONL mtime > `synced_at`.

### `[+MA]` Multi-agent orchestration (`scripts/sync_agents.py`)

Same cadence; fan out over enabled adapters from `config/agents.yaml`. Each adapter yields normalized events; the orchestrator writes `sessions`/`tool_calls`/`token_usage`/`burn_daily` rows tagged with `agent` + `fidelity`. Per-adapter try/except so one agent's malformed log never blocks the others.

### OTEL ingest (`/v1/logs`, `/v1/metrics` in `server.py`)

Receive OTLP/HTTP JSON. For each `LogRecord`:
- Parse `attributes` into a dict.
- **Per-row try/except** so one malformed event doesn't drop the batch. Count drops, log to stderr. **Claude Code doesn't retry on 200 — the endpoint must be fault-tolerant and always return 200.**
- For `event.name='tool_result'` with `tool_name='mcp_tool'`, parse the `tool_parameters` JSON attribute to extract `mcp_server_name` + `mcp_tool_name` (only present when `OTEL_LOG_TOOL_DETAILS=1`). Fall back to parsing `mcp__<server>__<tool>` from the JSONL side when OTEL is off.
- INSERT into `otel_events`. Metrics → `otel_metrics` with `metric_name`, `metric_type` (counter/gauge), `value`, `timestamp`.

Event names to handle (match **both** bare and `claude_code.`-prefixed forms): `tool_result`, `api_request`, `api_error`, `api_refusal`, `user_prompt`, `tool_decision`, `permission_mode_changed`, `mcp_server_connection`, `hook_execution_start`, `hook_execution_complete`, `compaction`. Metrics: `claude_code.token.usage` (type=input|output|cacheRead|cacheCreation), `claude_code.cost.usage` (USD + mcp/skill/agent attrs), `claude_code.session.count`, `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`, `claude_code.{commit,pull_request,lines_of_code}.count`. All delta temporality → `SUM(value)` correct. `/v1/traces` (beta): spans `claude_code.{interaction,llm_request,tool,hook}` → optional `otel_spans` table. See §12 for the full catalog + OTEL-first/JSONL-fallback rule.

### Antigravity adapter — reference implementation (`scripts/adapters/antigravity.py`)

Tools/latency parse from the JSONL transcript (standard step-record loop). **Tokens require decoding the conversation `.db` protobuf** — no `.proto` schema needed; read the wire format directly. This is verified, runnable code (validated: invariant `f3 == f9 + f10` across 89/89 generations). The full standalone version with a CLI lives alongside this spec at `docs/antigravity_token_extractor.py`; the adapter embeds the core:

```python
# scripts/adapters/antigravity.py  — token usage from gen_metadata protobuf
import sqlite3, glob, os

def _read_varint(b, i):
    shift = val = 0
    while True:
        x = b[i]; i += 1
        val |= (x & 0x7F) << shift
        if not (x & 0x80):
            return val, i
        shift += 7

def _parse(b):
    """Minimal protobuf wire-format reader -> {field_num: [(wire_type, value), ...]}."""
    out = {}; i = 0; n = len(b)
    while i < n:
        try:
            tag, i = _read_varint(b, i)
        except IndexError:
            break
        fn, wt = tag >> 3, tag & 7
        if wt == 0:   v, i = _read_varint(b, i)           # varint
        elif wt == 2: ln, i = _read_varint(b, i); v = b[i:i+ln]; i += ln  # length-delimited
        elif wt == 1: v = b[i:i+8]; i += 8                # 64-bit
        elif wt == 5: v = b[i:i+4]; i += 4                # 32-bit
        else: break
        out.setdefault(fn, []).append((wt, v))
    return out

def _sub(p, fn):                       # first length-delimited child as a submessage
    return next((_parse(v) for wt, v in p.get(fn, []) if wt == 2), {})

def _vint(p, fn):                      # first varint child
    return next((v for wt, v in p.get(fn, []) if wt == 0), None)

def session_tokens(db_path):
    """Sum exact token usage for one Antigravity conversation .db.
    Usage submessage path: top.field(1).field(4)
      f1=system(const~1020)  f2=input/context  f6=overhead(const24)
      f3=output (== f9+f10)   ->  input = f1+f2+f6 ; output = f3
    """
    rows = sqlite3.connect(db_path).execute(
        "SELECT data FROM gen_metadata ORDER BY idx").fetchall()
    inp = out = gens = 0
    for (data,) in rows:
        if not data:
            continue
        usage = _sub(_sub(_parse(data), 1), 4)
        f1, f2, f3, f6 = (_vint(usage, k) for k in (1, 2, 3, 6))
        if f2 is None or f3 is None:   # gen_metadata empty/aborted -> skip (tools-only)
            continue
        gens += 1
        inp += (f1 or 0) + f2 + (f6 or 0)
        out += f3
    return {"input": inp, "output": out, "total": inp + out, "generations": gens,
            "fidelity": "exact", "cost_usd": None}   # no native USD for Antigravity
```

The orchestrator (§10.5) calls `session_tokens()` per conversation `.db`, writes `sessions`/`token_usage` rows with `agent='antigravity'`, `fidelity='exact'`, `cost_usd=NULL`, and gets `cwd` + tool/latency from the transcript path. Wrap each row in try/except (defensive) and re-decode when the `.db` mtime advances. Soft spots (do not block burn): f9/f10 labels and f1-as-cache are inferred; totals are solid.

## 16. API surface

All endpoints under `127.0.0.1:8765`. JSON. No auth. Observability endpoints accept `?range=today|7d|30d` and use local-time bucketing. `[+MA]` Usage/burn/session endpoints also accept `?agent=all|<id>`.

**OTEL ingest:** `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/traces` (beta) — OTLP/HTTP JSON, always 200. Accept both bare and `claude_code.`-namespaced `event.name`. `claude_code.token.usage` / `claude_code.cost.usage` metrics feed token/burn/MCP/skill panels directly (pre-attributed); traces feed tool/hook latency (§12).

**System + health:**
- `GET /api/health` — quick liveness.
- `GET /api/system/health` — uptime, memory, last OTEL event age, daemon last-tick age, notifier/sync loop ages, tzname.
- `GET /api/system/state` — read `system_state` KV.
- `POST /api/system/emergency-stop` — SIGTERM dispatcher-launched `claude -p` children ONLY (see §18). Returns `{stopped, processes_killed, interactive_spared}`.
- `POST /api/system/emergency-resume` — clear emergency flag.
- `GET /api/attention` — aggregated issue feed (stuck loops, failed tasks, dispatcher stale, decisions pending).
- `GET /api/firehose` — SSE stream of recent OTEL events.

**Sessions:**
- `GET /api/sessions` — paginated, filters (range, source, model, **`agent` `[+MA]`**).
- `GET /api/sessions/{id}/details` — tool-call timeline + token breakdown.
- `GET /api/sessions/live` — active in last 5 min.
- `GET /api/sessions/live/{sid}/state` — current live state row.
- `GET /api/sessions/live/{sid}/stream` — SSE line-by-line feed.
- `POST /api/sessions/live/{sid}/message` — queue follow-up into `.tmp/mission-control-queue/{sid}.jsonl`. Validate `session_id` is a UUID (block path traversal). Only for `stream`-mode sessions.
- `GET /api/summary` — top-level KPIs: today's sessions / tokens / tools / errors.
- `POST /api/sync` — manual trigger of sync loop.

**Observability:**
- `GET /api/usage/tokens` — daily breakdown by **`agent` `[+MA]`** + model + source, totals at top.
- `GET /api/usage/cache` — overall cache hit rate + daily trend. Low-sample badge below 10K billable tokens. Hit rate = `cache_read / (input + cache_read + cache_create)`. Target 70%+.
- `GET /api/burn` `[+MA]` — see §11.3.
- `GET /api/sessions/outcomes` — daily mutually-exclusive buckets in priority order `errored > rate_limited > truncated > unfinished > ok`. Must sum cleanly to day total.
- `GET /api/tools/latency` — per tool p50/p95/max/error-rate/call-count. Sort by p95 desc.
- `GET /api/hooks/activity` — `hook_execution_start` + `_complete` paired by `session_id` (FIFO queue per session, 60s outlier cap). Daily fires + paired-duration counts.
- `GET /api/sessions/by-project` — rollup by `cwd`: sessions, effective tokens, tool count.
- `GET /api/tools/agent-fanout` — sessions that dispatched Agent tool calls (subagent proxy).
- `GET /api/tools/edit-decisions` — accept/reject rate for Edit/MultiEdit/Write/NotebookEdit from `tool_decision`. Low-sample badge under N=10.
- `GET /api/activity/productivity` — OTEL counters `claude_code.{commit,pull_request,lines_of_code}.count`. These ARE delta-counters (verified non-monotonic) — `SUM(value)` is correct.
- `GET /api/system/pressure` — retry-exhaustion count (attempts ≥ `CLAUDE_CODE_MAX_RETRIES`, default 10, env-configurable with try/except ValueError fallback), compaction count, recent api_errors.

**MCP:**
- `GET /api/mcp` — servers with totals + avg latency + p95.
- `GET /api/mcp/{server}/tools` — per-tool breakdown (calls, p50, p95, max, error rate). Three sources in priority order: OTEL events with `mcp_server_name` (precise, post-`OTEL_LOG_TOOL_DETAILS=1`), `tool_calls.duration_ms` from JSONL pairing, legacy pre-generic-`mcp_tool` rows.
- `POST /api/mcp/sync` — rebuild `mcp_stats`.
- `POST /api/mcp/measure` — schema-size measurement per server.

**Skills:**
- `GET /api/skills` — list with filters (environment, user_invocable).
- `POST /api/skills/sync` — rebuild `skills`.
- `PATCH /api/skills/{name}/autonomy` — update autonomy level.

**HITL — Decisions:**
- `GET /api/decisions?status=pending|answered`.
- `POST /api/decisions` — create from dispatcher `DECISION:` markers. `INSERT OR IGNORE` on the partial UNIQUE index; return `{id, created}`.
- `POST /api/decisions/{id}/answer` — body `{answer}`. Write answer to queue file; dispatcher injects into stdin once. Return `{answered: true}`.

**HITL — Inbox:**
- `GET /api/inbox?unread=1&max_age_days=30`.
- `POST /api/inbox` — agent-to-user (from `INBOX:` markers).
- `POST /api/inbox/{id}/read` → `{read: true}`.
- `POST /api/inbox/{id}/reply` — writes to queue file → `{replied: true}`.

**Tasks:**
- `GET /api/tasks` — filtered (status, quadrant).
- `POST /api/tasks` — body `{title, description, priority, quadrant, requires_approval, risk_level, dry_run, model, execution_mode (stream default for UI-created), assigned_skill, scheduled_for}`.
- `PATCH /api/tasks/{id}` — validate status transitions.
- `DELETE /api/tasks/{id}`.
- `POST /api/tasks/{id}/approve` — `awaiting_approval` → `pending`, stamp `approved_at` → `{approved: true}`.
- `POST /api/tasks/{id}/rerun` — only if `status='failed'` (400 otherwise). Reset to `pending`, clear `error_message`/`completed_at`/`started_at`/`duration_ms`/`output_summary`/`session_id`. Preserve `consecutive_failures` → `{rerun: true, task_id}`.
- `POST /api/dispatcher/trigger` — spawn one-shot dispatcher via `subprocess.Popen(..., start_new_session=True)`, wrapped in `asyncio.to_thread`.

**Schedules:**
- `GET /api/schedules`.
- `POST /api/schedules`.
- `PATCH /api/schedules/{id}` — clears `next_run_at` on cron change for immediate recompute.
- `DELETE /api/schedules/{id}` → `{deleted: <schedule_id>}`.
- `GET /api/schedules/{id}/runs?limit=10`.
- `POST /api/schedules/parse-nl` — NL → cron via Haiku, wrapped in `asyncio.to_thread`.

## 17. The panels (33 + Burn)

Paired cards in 2-col grids use `grid auto-rows-fr ... [&>*]:h-full` so heights match.

### Command page (`index.tsx`)

Fixed at top (always visible):
1. **SystemHealthStrip** — uptime, memory, OTEL last-event age, daemon tick age, notifier/sync tick ages. Pills colored by health. `GET /api/system/health`.
2. **KpiRow** — today's sessions/tokens/tools/errors. 4 tiles, skeleton while loading. `GET /api/summary`.
3. **AttentionBar** — red banner: stuck loops, recent failed tasks, dispatcher staleness. Hides when clear. `GET /api/attention`.

Then collapsible sections (`CollapsibleSection`, localStorage-persisted `cc:section:<id>`, chevron rotates 90°, 220ms framer-motion height animation):
4. **Live sessions** — `LiveSessionsCard` + `LiveSessionDetail` slide-out drawer (right Sheet ~460px). Row: title (last user msg), cwd, model, token total, started-at. Drawer: tool-call timeline, input/output previews. Stream sessions get a follow-up box; classic sessions show "Read-only — re-queue as Interactive to reply."
5. **Posture** — *NOT in the free build.*
6. **Token usage** — `TokenUsageCard`. today/7d/30d toggle. Stacked daily bar (input+output+cache-read+cache-create). Totals at top. `[+MA]` add per-agent series/legend.
   - **Burn** `[+MA]` — `BurnCard` (Panel 34, §11). Placed directly under Token usage.
7. **Observability section**:
   - 2-col: `CacheEfficiencyCard` + `SessionOutcomesCard`
   - 2-col: `ToolLatencyCard` + `HookActivityCard`
   - 2-col: `ProjectBreakdownCard` + `AgentFanoutCard`
   - 2-col: `EditAcceptanceCard` + `ProductivityCard`
   - Full-width: `PressurePanel`
8. **HITL section**: 2-col `DecisionsCard` + `InboxCard`.
9. **Mission Control section**: full-width `TaskBoard` + `TaskComposer` (Sheet); full-width `SchedulesCard` + `ScheduleComposer` (Sheet).
10. **EmergencyStopBanner** — red header button + confirm dialog → `POST /api/system/emergency-stop`.

Observability panel details:
- **CacheEfficiencyCard** — today/7d/30d. Big-number hit rate, daily trend sparkline, target line at 70%, "low sample" badge if billable tokens < 10K.
- **SessionOutcomesCard** — stacked daily bars, 5 segments: errored (red)/rate_limited (amber)/truncated (orange)/unfinished (grey)/ok (green). Must sum to day total.
- **ToolLatencyCard** — per-tool p50/p95/max + error rate, sort by p95 desc. Red flag p95≥10s, green under 500ms. Show N per row.
- **HookActivityCard** — daily fires per hook + paired-duration estimate (cap 60s, FIFO per session). Empty-state when `totalFires===0`.
- **ProjectBreakdownCard** — sessions by `cwd`. Project name (basename or `~/...`), sessions, effective tokens, % of total. Home-dir strip `cwd.replace(/^\/Users\/[^/]+/, '~')` — never hardcode a username.
- **AgentFanoutCard** — sessions that ran the Agent tool. Title + Agent call count; fallback to `session:`-prefixed id when title null.
- **EditAcceptanceCard** — accept/reject for Edit/MultiEdit/Write/NotebookEdit from `tool_decision`. Low-sample badge under N=10.
- **ProductivityCard** — commits, PRs, lines added/removed. Empty when all zero AND daily empty.
- **PressurePanel** — retry exhaustion (threshold from `CLAUDE_CODE_MAX_RETRIES`, default 10, surface threshold in response), compaction count, last 10 api_errors with attempt counts.
- **DecisionsCard** — pending decisions, prompt preview, Answer modal. `GET /api/decisions?status=pending`, poll 5s.
- **InboxCard** — unread `agent_to_user` messages + reply box. Poll 10s.
- **TaskBoard** — 3 columns (pending/running/done). Card: title, description preview, skill badge, model badge, quadrant dot, risk pill, dry-run badge. Actions: Approve (awaiting_approval), Rerun (failed only — gate on `t.status==='failed'`), Delete.
- **TaskComposer** — Sheet. Fields: title (autofocus), description, model select (default "" → from skill), mode picker (Interactive/One-shot, **default Interactive**), priority, quadrant, risk, requires_approval, dry_run (tooltip).
- **SchedulesCard** — name, cron preview, enabled toggle, next-run countdown, delete; expand for last 5 runs. TZ in header (`datetime.now().astimezone().tzname()`, env-overridable via `TZ`). Stale: `next_run_at < now-5min` → amber dot.
- **ScheduleComposer** — Sheet. Time picker (hour 0-23 + minute 0/15/30/45), Mon–Sun chips + quick-select (Every day/Weekdays/Weekends), live cron preview, task title/details, skill picker, enabled toggle. Cron derived client-side. Day-of-week uses Python `dt.weekday()` (Mon=0..Sun=6) to match the heartbeat parser.

### Activity page (`activity.tsx`)
11. **Patterns** — `HeatmapGrid` (30-day GitHub-style grid) + `ChartsStrip` (14-day stacked token charts by model). `[+MA]` add agent dimension.
12. **Telemetry firehose** — `OtelPanel` (SSE to `/api/firehose`, scrolling feed, filter by event_name).
13. **Top skills + failures** — `TopSkills` (most-used skills with token cost) + `UnifiedFailures` (crashed sessions + error messages).
14. **All sessions** — `SessionsTable` (searchable, paginated, filter by range/source/model/**`agent` `[+MA]`**). Optional `ActivityFirehose` full-page view.

### Skills & MCP page (`skills.tsx`)
15. **MCP servers** — `MCPPanel`. Servers with totals + avg latency + p95. Row click → per-tool table (p50/p95/max/err/N). p95≥10s: `· slow` red tag; sub-500ms: `· fast` green. Fetch `GET /api/mcp/{server}/tools?range=7d|30d` on expand. **Make this extraordinary — it's the centerpiece.** When you open it you should see your Notion MCP at 14s p95 and *feel* it.
16. **Skill economics** — `SkillCostCard`. Token cost per skill, sort by total.
17. **Context health + registry** — 3-col: `ContextHealthCard` (read-only scan of `~/.claude/settings.json` + `CLAUDE.md` — line/rule/MCP/hook count, file size; no LLM) + `SkillsRegistry` (col-span-2, all skills with autonomy controls).

### Shared UI components
- `CollapsibleSection` — `{id, title, subtitle?, summary?, defaultOpen}`, localStorage `cc:section:<id>`, chevron rotate, framer-motion height anim, proper aria-expanded/aria-controls.
- `Sheet` — right slide-out drawer, Esc-to-close, focus trap, aria-modal.
- `Card` primitives (`Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`) — rounded-xl, subtle border, surface bg.
- `Button` — primary (gradient)/secondary/ghost.
- `Badge`, `StatePill` — colored status pills (also fidelity exact/estimated `[+MA]`).
- `Tooltip` — hover-delay with arrow.
- `CommandPalette` — ⌘K, fuzzy-search pages + queue-a-task quick action.

## 18. Mission Control dispatcher

Separate process in `.claude/skills/mission-control/scripts/`.

**`heartbeat.py`** — launchd-driven, 120s. Each tick: (1) `task_tracker.claim_pending()` — atomic `UPDATE ops_tasks SET status='running' WHERE id=? AND status='pending'` with rowcount check (prevents daemon + manual `--once` racing); (2) materialize schedules `SELECT * FROM ops_schedules WHERE enabled=1 AND (next_run_at IS NULL OR next_run_at <= ?)` — create `ops_tasks`, update `next_run_at` via `parse_cron_simple()`, wrap in `BEGIN IMMEDIATE`; (3) `dispatcher.run_once()`; (4) write `activities(event_type='heartbeat')`.

**`dispatcher.py`** `run_once()`:
- Honors `system_state.emergency_stop` (early-return when set).
- `_sweep_stale_pids()` — clean `.tmp/mission-control-queue/pids/` of dead PIDs (signal 0 probe).
- For up to `MAX_CONCURRENT` (default 3) pending tasks: skill autonomy check (`manual`/`review` → `awaiting_approval`; `auto` → run). Branch by `execution_mode`:
  - **classic:** `subprocess.Popen(['claude','-p',prompt,...])`, `_mark_child_pid(proc.pid)`, `proc.communicate(timeout=...)`, `_unmark_child_pid` in finally. Capture stdout → `output_summary`. Handle `TimeoutExpired` by killing.
  - **stream:** `subprocess.Popen` with stdin/stdout/stderr=PIPE, `bufsize=1`. Reader threads drain stdout into a queue. Parse each JSON line. On `type='system', subtype='init'` stash `session_id`. On assistant text, scan for `DECISION:`/`INBOX:` markers (line-based, skip triple-backtick fences). `DECISION:` → create `ops_decisions` via `INSERT OR IGNORE`, block on poll (2s, up to `TASK_TIMEOUT_SECONDS`), inject answer via `proc.stdin.write` once. `INBOX:` → POST `/api/inbox`. Poll `.tmp/mission-control-queue/{sid}.jsonl` for user follow-ups, seek from last offset, inject each line.
- `_build_env()` sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTEL envs + `ATOMICOPS_DISPATCHED=1` (legacy marker; PID files are the real safety gate). **Create PID marker files in `.tmp/mission-control-queue/pids/{pid}` for every spawned child; delete on exit.**
- `resolve_model()` priority: `task.model` → skill frontmatter → `MISSION_CONTROL_DEFAULT_MODEL` env → CLI default.

**`task_tracker.py`** — `create_task(...)` INSERT; `claim_pending(task_id)` atomic UPDATE returning claimed row or None; `update_task`/`complete_task`/`fail_task`.
**`skill_router.py`** — Haiku skill picker for unassigned tasks (~$0.0001/pick).
**`session_state_hook.py`** — Claude Code hook target; writes `live_session_state` per lifecycle event (optional, referenced from settings.json hooks).

**Launchd plist** — `com.commandcentre.mission-control.plist.template` with `{{PYTHON}}`, `{{INSTALL_DIR}}`, `{{PROJECT_ROOT}}`, `{{PORT}}`, `{{DEFAULT_MODEL}}`. `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=30`. **Do NOT hardcode `/usr/bin/python3`** (that's 3.9 on macOS) — point to homebrew/venv Python.

## 19. Emergency stop

`POST /api/system/emergency-stop`:
1. Scan `.tmp/mission-control-queue/pids/` for PID files.
2. For each: `os.kill(pid, 0)` to verify alive; if dead, unlink.
3. Verify it's a `claude -p` process: `ps -p {pid} -o command=`, check argv contains `claude` and `-p` (defence against PID recycling).
4. SIGTERM alive `claude -p` PIDs. Unlink markers. Tally `killed`.
5. Set `system_state.emergency_stop = '1'`.
6. `UPDATE ops_tasks SET status='failed', error_message='Emergency stop triggered' WHERE status='running'`.
7. Return `{stopped, processes_killed, interactive_spared}`.

**Why PID files, not `ps eww` env scanning:** macOS 12+ restricts env disclosure to root, so the `ATOMICOPS_DISPATCHED=1` marker is invisible at user privilege. On-disk PID files are the only reliable way to identify dispatched children without false positives.

## 20. Telegram bridge (optional, opt-in at install)

**`scripts/setup_telegram.py`** — wizard: BotFather instructions + link → prompt bot token → show `@userinfobot` for chat_id → prompt chat_id → test token (`POST sendMessage` "✓ Command Centre is wired up.", abort on fail) → write `.claude/skills/telegram/references/messaging.yaml` with `allowed_user_ids` → append `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DASH_CHAT_ID` to install-dir `.env` (chmod 600) → remind to restart server + launchd agent.

**`scripts/notifier.py`** — 30s lifespan loop. Each tick check: pending `ops_decisions` → "❓ Decision waiting" + `✓ Approve`/`Snooze 30m`; `awaiting_approval` tasks → "🟡 Approval needed" + `✓ Approve`/`Dismiss`; failed tasks (last 24h) → "⚠️ Task failed" + `↻ Re-run`/`Dismiss`; overdue schedules → "⏰ Schedule overdue" + `Disable`/`Dismiss`; unread inbox → "📨 Inbox" + `✓ Mark read`/`Dismiss`. **Plain text only — no `parse_mode="markdown"`** (DB content with unescaped backticks fails markdown parsing silently → infinite retry loops). Dedupe via `notification_log` `UNIQUE(event_type, event_key, chat_id)`. Snooze = `UPDATE snoozed_until = now+30m`; `_already_notified()` re-fires when snooze elapses. Callbacks use `dash:<action>:<id>` (e.g. `dash:dec_approve:42`, `dash:task_rerun:17`, `dash:dismiss`).

**`.claude/skills/telegram/scripts/`** — `telegram_send.py` (reusable outbound + inline buttons), `telegram_handler.py` (polling `getUpdates`; whitelist via `allowed_user_ids`; text → Claude CLI, callback → `dash_router.py`), `telegram_bot.py` (`process_callback_query`: if `data.startswith("dash:")` route to `dash_router.route()` before Claude-chat flow), `dash_router.py` (`route(data, chat_id)`: parse `dash:<action>:<id?>`, POST to `DASHBOARD_URL` default `http://127.0.0.1:8765`; `_snooze()` returns real rowcount), `message_db.py` (per-chat state via SQLite `ops_messages` + `ops_conversations` `UNIQUE(platform, chat_id)`).

**Launchd plist (Telegram)** — `com.commandcentre.telegram-bot.plist.template`, only installed if opted in.

## 21. Setup UX

**`install.sh`** — single entry. Args: `--yes`, `--project-root=PATH`, `--port=N`, `--model=M`, `--no-otel`, `--no-launchd`, `--telegram`, `--no-telegram`, `--no-start`. Flow: (1) arg parse; (2) Python detection — prefer `/opt/homebrew/opt/python@3.12/libexec/bin/python3`, fall back `python3.13 → … → python3.9`, gate `>= 3.9` (warn on 3.9 for PEP 604 gotchas); (3) project-root resolution (`--project-root` → `$PWD/.claude` check → prompt); (4) Cowork auto-detect (`~/Library/Application Support/Claude/local-agent-mode-sessions/`); `[+MA]` (4b) detect agent dirs `~/.codex/sessions`, `~/.gemini/antigravity/brain`, `~/.pi/agent/sessions` and pre-enable in `config/agents.yaml`; (5) create `~/.command-centre/` layout; (6) copy `scripts/*.py` + `ui/dist/` + `.claude/skills/` + `requirements.txt`; (7) seed `config` + `.env`; (8) venv + pip install; (9) launcher scripts `start.sh`/`stop.sh`; (10) `cc` shim (`start`/`stop`/`restart`/`doctor`/`setup otel`/`setup telegram`/`sync`/`logs`); (11) symlink `bin/cc` → `~/.local/bin/cc`; (12) OTEL wizard unless `--no-otel`; (13) Telegram ask unless decided; (14) render+load launchd plists unless `--no-launchd`; (15) start server unless `--no-start`; (16) print next steps.

**`scripts/setup_otel.py`** — read `~/.claude/settings.json` (create empty if missing), diff against the six required keys (§8), show missing, prompt `[Y/n]` unless `--yes`, back up `settings.json.bak.<YYYYMMDD-HHMMSS>` via `shutil.copy2`, write merged JSON (**only add missing keys, never overwrite**), remind to restart Claude Code.

**`scripts/doctor.py`** — zero LLM. Green/red checks: Python version (warn <3.10); `claude` CLI on PATH; settings.json + all 6 OTEL keys; `~/.claude/projects/` exists + file count; `[+MA]` each enabled agent's dir exists + file count; `CC_PROJECT_ROOT`; port reachable (socket probe); `/api/system/health` render; `launchctl list` for `com.commandcentre.{mission-control,telegram-bot}`; Telegram `getMe` if token set. Exit 0 if all green, non-zero on critical failure.

## 22. Visual direction

Not "dark with one accent." Production-grade.

**Palette** — `--bg:#0a0a0f`, `--surface:#12121a`, `--surface-2:#1a1a27`, `--border:#2a2a3d`, `--border-glow:#3d3d5c`, `--text:#e8e8f0`, `--text-dim:#8888a0`, `--text-subtle:#5a5a70`. Accent gradient `linear-gradient(135deg,#4d7cff,#8b5cf6)`. Status: green `#10b981`, amber `#f59e0b`, red `#ef4444`, cyan `#06b6d4`. Layered radial-gradient background for depth.

**Typography** — Inter (400–800) for body; JetBrains Mono for labels/kickers/numeric/code. Uppercase mono section labels, 1.5–2px letter-spacing.

**Layout** — card-based, 14–16px radius, 24–32px padding. `auto-rows-fr` + `[&>*]:h-full` for matched paired-card heights.

**Motion** — panel fade-in (~300ms), CollapsibleSection 220ms ease-out height, chevron 90° rotate, button hover lift 2px + shadow. No scroll-jacking, parallax, or hero animations.

**Data display** — relative time ("3 min ago") with absolute on hover; numbers right-aligned in tables; loading skeletons (not spinners); empty states that teach, not just "no data." `[+MA]` `[burn]` Burn panel uses log scales and always shows scale-equivalent math; fidelity badges everywhere a token count appears.

**Icons** — `lucide-react`, one clean modern style. **Keyboard** — ⌘K palette, Sheets close on Esc, visible focus rings, forms submit on Enter.

## 23. Stop conditions

1. `./install.sh` runs clean on a fresh directory.
2. `http://localhost:8765` loads; all three routes (`/`, `/activity`, `/skills`) render; every panel shows real data or a proper empty state — no placeholders, layout jumps, or spinner-only states.
3. After enabling OTEL + restarting Claude Code, new events appear within 30s.
4. MCP panel: click a server → per-tool breakdown animates in smoothly.
5. Queue an Interactive task → dispatcher picks it up → runs end-to-end → output in TaskBoard done column.
6. Create a schedule → `next_run_at` populates → past the time → schedule materializes a task.
7. Emergency stop: dispatch a sleeping task → red button → that child SIGTERM'd AND a separate-terminal interactive `claude -p` survives.
8. `cc doctor` exits 0, all green.
9. `npx playwright test` passes.
10. `[+MA]` With ≥2 agents enabled, Token usage + Burn show per-agent breakdowns and the moving-average table labels each agent exact/estimated correctly.

## 24. Order of operations

1. Read the whole spec first; don't start until it clicks.
2. **Data layer:** read a handful of real JSONL files from `~/.claude/projects/` `[+MA]` plus a couple from `~/.codex/sessions/`, Antigravity, and Pi. Confirm shapes. Design the full schema with the `agent`/`fidelity` columns. **Show the schema before building more.**
3. **Ingest:** `sync_sessions.py` (Claude Code) `[+MA]` + the adapter orchestrator + `/v1/logs` + `/v1/metrics`. Verify with a real JSONL dump + manual OTEL POST.
4. **API:** every `/api/*`. Raw SQL. Per-row try/except on ingest. Local-time bucketing everywhere.
5. **Mission Control:** dispatcher + heartbeat + task_tracker + PID markers + DECISION:/INBOX: parser (fence-aware) + launchd template.
6. **Dashboard shell:** TanStack Router, AppShell, CollapsibleSection, Sheet, Card primitives, theme tokens, hooks.
7. **Panels:** display order; MCP drill-down last (save the centerpiece) `[+MA]` and Burn alongside Token usage.
8. **HITL:** DecisionsCard + InboxCard + LiveSessionDetail follow-up box.
9. **Telegram:** wizard + notifier + handler + dash router + launchd plist.
10. **Setup:** install.sh + setup_otel.py + doctor.py + cc shim `[+MA]` + agent auto-detect.
11. **Playwright:** main pages render, palette opens, schedule composer creates a schedule, theme persists.
12. **Verify** against every stop condition; run `cc doctor`; screenshot main view into README.md.

Build the whole thing. Don't strip features. Ship at the stated quality bar.

---

## Resolved Issues & Decisions

| # | Issue | Resolution |
|---|---|---|
| 1 | **Source 3 is a different project** (Node/Vercel multi-tool burn tracker) from Sources 1+2 (Python/FastAPI Claude Code command centre). Naive merge = contradictory two-stack Frankenstein. | **Decided (Scott):** fold Source 3 in *as a panel/widget* (Panel 34, "Burn", §11) inside the existing FastAPI/React dashboard — adopt its *ideas* (log-scale heatmap, burn drivers, scale equivalents, exact/estimated fidelity), drop its Node/Vercel stack. |
| 2 | Source 3's value was multi-tool tracking; base spec is Claude-Code-only. | **Decided (Scott):** generalize the data layer to a pluggable agent-adapter model (§10) covering Claude Code, Codex, Antigravity, Pi. |
| 3 | Unknown log locations/formats for Codex, Antigravity, Pi. | **Grounded from real files on this machine** (§10.2): Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; Pi `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`; Antigravity `~/.gemini/antigravity-cli/` (corrected path). Full field maps extracted, not guessed. |
| 4 | Output format: spec vs. narrative. | **Decided (Scott):** "both layered in one doc" — Part I orientation, Part II extension, Part III full spec. |
| 5 | `source` column (`ide`/`cowork`) can't express four agents. | Introduced `agent` + `fidelity` columns; `token_usage` rollup key gains `agent`; new `burn_daily` table. All via idempotent migration helper (§10.4, §14). |
| 6 | Estimates vs. measurements. | Adopted Source 3's hard rule — "do not let estimates cosplay as measurements." Every token figure carries fidelity. CC/Codex/Pi tokens are exact; Antigravity tokens are `unavailable` (protobuf-locked) and excluded from token aggregates. |
| 7 | Per-agent cost. | **Decided (Scott): hybrid.** Show native USD where the agent emits it (Claude Code `total_cost_usd`, Pi `usage.cost.total`); tokens-only for Codex/Antigravity; never fabricate USD. `burn_daily.cost_usd` nullable. |
| 8 | Pi branch (tree) totals. | **Decided (Scott): sum all branches** — you were billed for abandoned branches, so that's true burn. Branch count kept as metadata (§10.6). |
| 9 | Antigravity (`agy`) install + token access. | **Grounded:** installed at `~/.local/bin/agy`, data under `~/.gemini/antigravity-cli/`. Tool/step activity + latency extractable from JSONL transcript; **tokens locked in protobuf BLOBs** in the conversation `.db` (no field names) → token-unavailable until the proto is decoded. Tracked in Open Questions. |
| 10 | OTEL: built-in or plugin, per agent? Can OTEL feed the dashboard for non-Claude agents? | **Researched + verified (§12).** Claude Code = built-in (logs+metrics+traces-beta); Codex = built-in opt-in (`[otel]` in config.toml); Pi = plugin (`pi-otel`). All three can POST to the dashboard's `/v1/*`. **Antigravity has no configurable local OTLP** — verified statically (no OTLP-endpoint env in binary; Sentry→Google transport) and live (zero local POSTs with `OTEL_*` set). Also enriched the Claude Code catalog (token/cost metrics, namespaced events, `/v1/traces`). |
| 11 | Does OTEL rescue Antigravity's protobuf-locked tokens? | **Moot — tokens were decoded directly (Resolved #12).** OTEL was ruled out (`agy` ships only to Google), but it's no longer needed. |
| 12 | Antigravity token recovery from protobuf. | **SOLVED.** Reverse-engineered the `gen_metadata` protobuf without the `.proto`: usage submessage at field `1.4`, with `input = f1+f2+f6`, `output = f3`, and the invariant `f3 = f9+f10` validated across **89/89** generations. Antigravity tokens are now `exact` (§10.2). Remaining softness: f9/f10 labels + f1-as-cache are inferred; input/output totals are solid. No native USD (tokens-only). |

## Open Questions / Gaps

Most original open questions are now **resolved** (see Resolved Issues #3, #5, #7, #8, #9, #12). What genuinely remains:

1. **Antigravity token-field labels (minor).** Totals are solid (Resolved #12). Still inferred: which of f9/f10 is reasoning vs response, and whether f1 (constant 1020) should be reported as `cache_read`. Confirm by cross-checking one conversation's decoded total against the count shown in the `agy` UI when convenient. Does not block burn (input/output totals are exact).
2. **Codex cost.** Codex is tokens-only. If you later want USD for Codex, that requires a per-model price table (the option you declined for the general case) — revisit only if Codex spend becomes material.
3. **Antigravity `cwd` precision.** Workspace path is in `trajectory_metadata_blob` (protobuf, decodable — it holds `file:///…` paths) or `history.jsonl` `workspace`; wire it up for project-breakdown attribution.
4. **OTEL beyond Claude Code.** Only Claude Code emits OTLP. If Codex/Antigravity/Pi gain exporters later, `/v1/logs` already accepts them; revisit `otel_events.agent` tagging then.
5. **Linux support.** Paths are cross-platform (`~/.codex`, `~/.gemini`, `~/.pi`, `~/.claude`), but `install.sh`, launchd, and emergency-stop's `ps`/PID logic are macOS-bound. Deferred (matches `[guide]` "Linux later").
6. **Build vs. spec.** This document is the finalized synthesis/spec. Building the actual dashboard is a separate ~2-hour effort (Part III is the contract). Say the word if you want to start implementation.

---

### Grounding notes (for the multi-agent extension)

All four adapter field maps in §10.2 were **extracted from real session files on Scott's machine on 2026-06-08**, not from documentation. Counts at extraction: Claude Code 461, Codex 306, Pi 13, Antigravity 2 conversations.

Corrections vs. initial web research:
- **Pi** = [pi.dev](https://pi.dev) (confirmed by Scott), sessions at `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`, tree-structured with native per-message `usage.cost`.
- **Antigravity** (`agy` CLI) data is under **`~/.gemini/antigravity-cli/`** — *not* `~/.gemini/antigravity/` as web sources suggested. JSONL transcript at `brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`; tokens are protobuf-locked in `conversations/<conv-id>.db`.

Background web sources consulted before grounding: [ccusage — Codex guide](https://ccusage.com/guide/codex/), [codex-trace viewer](https://github.com/PixelPaw-Labs/codex-trace), [Google Antigravity docs](https://antigravity.google/docs/settings), [pi.dev](https://pi.dev).
