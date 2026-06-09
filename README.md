# Agent Dashboard — Multi-Agent Observability Command Centre

A local, single-laptop dashboard that reads the session logs your coding agents
already write to disk and turns them into something you can actually read —
token burn, tool latency, MCP cost, session outcomes, cache efficiency — across
**Claude Code, Codex, Antigravity (`agy`), and Pi**. No cloud, no account, no
outbound telemetry.

> **Status:** design spec complete; implementation not started. Everything in
> this repo today is the buildable specification under [`docs/`](docs/).

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
└── docs/
    ├── 2026-06-08-multi-agent-observability-command-centre.md   # the spec — start here
    ├── antigravity_token_extractor.py                           # verified Antigravity token decoder
    └── sources/                                                 # original source material
        ├── build-your-own-dashboard-guide.html
        └── build-your-own-dashboard-prompt.md
```

## Start here

Read **[`docs/2026-06-08-multi-agent-observability-command-centre.md`](docs/2026-06-08-multi-agent-observability-command-centre.md)**:

- **Part I — Orientation:** what this is and how the pieces connect.
- **Part II — Multi-Agent & Burn Extension:** the agent-adapter model, the
  token-burn panel, and the OTEL ingest design.
- **Part III — Full Build Spec:** the exhaustive contract (schema, API surface,
  33+ panels, Mission Control, setup) to build from.
