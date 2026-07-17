# AGENTS.md — agent contract for `command-centre` (agent-dashboard)

> **Thin, policy-free pointer.** This file names *how to verify, resume, and reason*
> about this repo. It does **not** restate what the repo is — for that, read the
> artifacts it points at. If a command below disagrees with reality, the command wins;
> fix this file.

## The one gate

**Green means `bun run check` exits 0.** Nothing ships that hasn't passed it.

It is a hermetic, network-free composite (`&&`-chained, fails fast):
`tsc --noEmit` → `bun test scripts` → `bun run check:ds` → `cd ui && svelte-check` → `cd ui && vitest run`.
No Rust, no server, no DB. ~30–60s. CI runs this exact command.

## Preflight (cold clone)

**`bun run doctor -- --preflight`** — zero-LLM, no running server required. Asserts the
clone is structurally sound and the toolchain is present *before* any agent starts
work. Exit 0 iff every critical check passes.

`bun run doctor` (no flag) remains the **live** health check — running server +
populated DB + heartbeat freshness. Use it to validate a deployment, not a checkout.

## Prepare (cold clone)

**`bun run .factory/harness/prepare.ts`** — frozen, two-step install. This repo is **not**
a Bun workspace (two lockfiles: `bun.lock` + `ui/bun.lock`), and the gate `cd`s into `ui/`,
so a single root `bun install` is not enough. The harness installs root **and** `ui/` with
`--frozen-lockfile` and asserts no lockfile drift. It builds no Rust bridge (the bridge is off
the gate — see Known seams).

## Eyes (behavioural verify)

The gate is blind to rendered UI. To *see*, drive **`playwright-cli`** over the codified
journeys in **`docs/journeys/`** (run by the `bowser-qa-agent`). It returns a structured
finding schema: `{title, severity, confidence, route, evidence, suggested_fix}`.
CVD rule is load-bearing: **colour is never the sole signal.**

## Intake & integration

- Branch: `fix|feat|docs|polish|refactor/<slug>` (lowercase, hyphenated).
- Commit: conventional-commit with scope — `fix(ui):`, `feat(library):`, `feat(bridge):`, `docs:`.
- Integrate: push branch to the solo remote, open a **draft** PR. CI runs `check` + `rust`.
- **Human gate: merge to `main` is human-only.** Everything up to the draft PR is autonomous.

## Definition of Done

A unit of work is done when: `bun run check` exits 0 **and** the relevant `docs/journeys/`
eyes-pass is clean **and** a draft PR is open against the solo remote. Merge is a separate,
human decision.

## Known seams (not covered by the gate)

- **Rust bridge** — `cargo build -p prompt-library-bridge` is deliberately OFF `check`
  (cold cargo builds add minutes). Verified by CI's separate `rust:` job. A stale/missing
  bridge ships green through `check` and surfaces at runtime as `unknown_command`.
  `doctor` warns on it.

## Read these to reason (don't rewrite them)

- `CONTEXT.md` — the ubiquitous-language glossary + relationships + flagged-ambiguity log. **Start here.**
- `docs/adr/` — 9 ADRs (stack, cost model, UI stance, bridge contract, flatten/overlay…).
- `docs/design-system-contract.md` + `ui/scripts/check-design-system.ts` — the DS poka-yoke (mechanical) and its rules.
- `.claude/skills/design-system-review/` — the DS *semantic* reviewer (the LLM half of the gate).
- `README.md` — human quickstart.
