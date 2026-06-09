# Build the Command Centre in TypeScript/Svelte/Bun, not Python/FastAPI/React

We are building the dashboard as a **single always-on Bun process** (launchd-supervised) running **Hono** for HTTP, **`bun:sqlite`** (WAL) for storage, and a **Svelte 5** SPA for the UI — re-expressing the master spec's Python/FastAPI/SQLite/React contract in one TypeScript stack. Heavy JSONL ingest runs in a **worker thread**; OTEL ingest and API reads run on the main thread.

## Status

accepted

## Context

The master spec (`docs/2026-06-08-multi-agent-observability-command-centre.md`, Part III) is written entirely in Python/FastAPI with ready-to-paste code, including the Antigravity protobuf reader. Scott knows TypeScript and Rust, not Python, and the frontend was already React/TS — so the backend language was the open question.

## Decision drivers

- **One language Scott actually writes.** TS across backend + frontend; no Python.
- **OTEL ingest requires a continuously-listening localhost server** (Claude Code POSTs telemetry to `:8765` while you work and drops it on failure). This makes it a **long-running web server**, not a desktop app — which is why **Tauri + Leptos was rejected**: its backend lives only while the window is open, so you'd need a background daemon anyway, plus Leptos/WASM has a thin ecosystem for a chart-dense dashboard.
- **`bun:sqlite` is synchronous, raw-SQL, single-file** — an exact match for the spec's "raw SQL, no ORM, one .db, WAL" directive (arguably cleaner than Python's `sqlite3`).
- **Svelte 5 runes avoid the React `useEffect` footgun** that Scott's global rules ban and enforce via hook — a user-specific win.
- **Hono runs on both Bun and Node**, so the HTTP layer stays portable: if Bun's relative youth ever bites, swapping to Node + `better-sqlite3` is a runtime change, not a rewrite. This is the hedge that made Bun acceptable over the more battle-tested Node.

## Considered and rejected

- **Python/FastAPI/React (the spec as written)** — rejected: Scott doesn't write Python.
- **Tauri + Rust + Leptos (desktop app)** — rejected: OTEL needs an always-on background server (desktop model fights it), and the chart/component ecosystem for a dense dashboard is thin in Leptos/WASM. Rust's strengths (perf, protobuf) aren't this app's bottleneck (a few hundred mtime-filtered JSONL files).
- **Separate ingest daemon (two processes)** — rejected for now: a worker thread gives the same CPU isolation (keeping UI serving smooth during cold-backfill bursts) with one launchd service. Revisit only if ingest needs a lifecycle independent of the UI server.

## Consequences

- The entire Part III build contract must be re-expressed in TS per phase doc; the Python reference (incl. `antigravity_token_extractor.py`) becomes pseudocode to port (~30-line protobuf wire-reader ports directly).
- React-specific spec details (TanStack Router/Query, framer-motion, cmdk) map to Svelte equivalents (SvelteKit/`adapter-static`, TanStack Query Svelte adapter, svelte transitions, a Svelte ⌘K palette).
- WAL mode is load-bearing: it lets the ingest worker write while the main thread serves reads.
