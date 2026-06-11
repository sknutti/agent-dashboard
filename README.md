# Agent Dashboard — Multi-Agent Observability Command Centre

A local, single-laptop dashboard that reads the session logs your coding agents
already write to disk and turns them into something you can actually read —
token burn, tool latency, MCP cost, session outcomes, cache efficiency — across
**Claude Code, Codex, Antigravity (`agy`), and Pi**. No cloud, no account, no
outbound telemetry.

> **Status:** implementation in progress. The Bun/Hono backend, SQLite schema,
> per-agent adapters, and Svelte dashboard shell are live; the original build
> spec remains under [`docs/`](docs/). The planned Prompt Library consolidation
> is tracked as the **Library layer** in [`CONTEXT.md`](CONTEXT.md) and
> [`ADR-0007`](docs/adr/0007-prompt-library-rust-command-bridge.md), with the
> actionable stages in [`docs/library-consolidation-track.md`](docs/library-consolidation-track.md).

## Where the data comes from

All four agents store local JSONL session logs (verified against real files);
the dashboard ingests them through a per-agent adapter, OTEL-first where
available and JSONL as the always-on fallback.

| Agent | Tokens | Native USD | OTEL |
|---|---|---|---|
| Claude Code | exact | ✅ | built-in |
| Codex | exact | ❌ | built-in (opt-in) |
| Pi ([pi.dev](https://pi.dev)) | exact | ✅ | plugin (`pi-otel`) |
| Antigravity (`agy`) | exact (protobuf-decoded) | ❌ | none usable (Sentry→Google) |

Antigravity's token usage isn't in plain JSONL — it's in a protobuf blob inside
the conversation `.db`. It was reverse-engineered without the `.proto`; see the
runnable [`docs/antigravity_token_extractor.py`](docs/antigravity_token_extractor.py).

## Repo layout

```
agent-dashboard/
├── scripts/    # Bun/Hono backend, SQLite schema, ingest, adapters, routes
├── ui/         # Svelte dashboard UI
├── config/     # local agent registry and rack-rate price table
└── docs/       # original build spec, ADRs, and source material
```

## Start here

For the original product spec, read
**[`docs/2026-06-08-multi-agent-observability-command-centre.md`](docs/2026-06-08-multi-agent-observability-command-centre.md)**:

- **Part I — Orientation:** what this is and how the pieces connect.
- **Part II — Multi-Agent & Burn Extension:** the agent-adapter model, the
  token-burn panel, and the OTEL ingest design.
- **Part III — Full Build Spec:** the exhaustive contract (schema, API surface,
  33+ panels, Mission Control, setup) to build from.
