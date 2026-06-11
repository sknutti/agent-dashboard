# Agent Dashboard (Command Centre)

A localhost-only observability + operations dashboard that reads the on-disk session logs of multiple coding agents, stores them in one SQLite file, and renders a dense dashboard. Zero outbound network calls.

## Language

**Agent**:
One supported coding-agent CLI whose local logs we ingest. Exactly four: Claude Code, Codex, Pi, Antigravity.
_Avoid_: tool, assistant, model (a model is what an Agent runs, not the Agent itself).

**Adapter**:
A per-Agent module that finds and parses that Agent's own logs into the shared normalized row shapes. One Adapter per Agent.
_Avoid_: parser, connector, plugin.

**Fidelity**:
The measurement quality of a single *figure* — `exact` (counted from logs) or `estimated` (calibrated) — attached **per figure, not per Agent or session**. Within one Agent, tokens can be `exact` while cost is `estimated`. Token fidelity is the `fidelity` column; **cost fidelity is implicit** (a populated `cost_usd` is exact-native, a `cost_estimated_usd` is estimated-rack-rate). Each number is badged by its own fidelity; estimates must never visually pass as measurements.

**Burn**:
Token spend reframed as a behavioral signal ("am I getting fluent or just expensive?") — the cross-agent daily-spend view (Panel 34), not a raw token count.

**Native cost**:
The USD figure a vendor stamps on its own logs — Claude `total_cost_usd`, Pi `usage.cost.total`. Exact, but computed per-vendor under plan-specific semantics, so **not comparable agent-to-agent**. Only Claude and Pi emit it.
_Avoid_: real cost, actual cost (it's still notional under a subscription).

**Estimated cost (rack-rate)**:
A USD estimate **we** compute as `tokens × API list price` from a maintained per-model price table — the same method for **all four Agents**, so it *is* comparable. Answers "what would this work cost at API rates if I weren't on a subscription?" Always carries `estimated` Fidelity. The cross-agent money axis.
_Avoid_: estimated cost being merged into a total with Native cost.

**Subscription savings**:
For Agents with both figures (Claude, Pi): `Estimated cost − Native cost` — what the subscription saves vs. paying API rates.

**Effective tokens**:
The "work" token figure — `input + output + reasoning + cache-write` — i.e. **total minus cache-read**. Cache-read is replayed context, not new work, and on agentic workloads it's ~95% of raw tokens; excluding it is what makes the other categories legible. The `effective_tokens` DB column, the Project-breakdown rollup, and the token-mix bars all use this exact figure. Cache-read lives in the Cache panel, not the mix.
_Avoid_: "generative tokens" or any near-synonym that silently drops cache-write — effective tokens **keeps** cache-write.

**Observability layer**:
The read-only half of the product — ingest + panels that show what the Agents did (tokens, latency, MCP, cache, outcomes, Burn). Multi-agent by nature.
_Avoid_: monitoring, metrics.

**Operations layer**:
The write half — acting on agents: Mission Control dispatcher, HITL decisions/inbox, schedules, Telegram pager, emergency stop. **Claude-Code-only** (it spawns and kills `claude -p` processes); does not generalize across Agents.
_Avoid_: ops, control plane.

**Library layer**:
The reusable-content half — editing, versioning, installing, and drift-managing Prompt Library **Primitives** across downstream agent-tool **Targets**. Cross-Target and write-capable, but distinct from the Claude-only **Operations layer**.
_Avoid_: treating library writes as operations, prompt management.

**Primitive**:
A versioned content artifact owned by the **Library**, with a **Kind**, name, and current **Version**.
_Avoid_: artifact, asset, item.

**Kind**:
The shape of a **Primitive**: `Skill`, `Agent`, `Command`, or `CodexAgent`.
_Avoid_: type, category, primitive type.

**Agent Primitive**:
The Prompt Library **Primitive** whose **Kind** is `Agent`; not a dashboard **Agent**.
_Avoid_: Agent when the surrounding sentence could mean the coding-agent CLI.

**Target**:
A downstream agent-tool that consumes **Primitives**: `Claude`, `Pi`, or `Codex`.
_Avoid_: tool, destination, host.

**Target name**:
The Prompt Library value for a downstream install destination (`Claude`, `Pi`, `Codex`), kept distinct from dashboard **Agent** ids like `claude_code`.
_Avoid_: normalizing Targets into Agent ids.

**Library**:
The user-chosen directory holding all **Primitives**, identified by a `.prompt-library` marker file at its root.
_Avoid_: vault, store, project.

**Working copy**:
The editable in-progress content of a **Primitive**.
_Avoid_: draft, scratch.

**Version**:
A published, frozen snapshot of a **Primitive**.
_Avoid_: snapshot, release, revision.

**Overlay**:
Target-specific bytes that replace base content for one **Target** on one **Primitive**.
_Avoid_: variant, override.

**Materialized**:
The output of merging **Working copy** base content plus any **Overlay** for a **Kind**, **Target**, and name.
_Avoid_: rendered, built, baked.

**KindTarget**:
A legal (**Kind**, **Target**) pair backed by the install matrix.
_Avoid_: slot, install slot, kind/target pair.

**InstallLayout**:
Whether a **Materialized** **Primitive** lands on disk as a single file or a directory.
_Avoid_: shape, form, flatten flag.

**Install**:
The act of writing **Materialized** bytes for a **Primitive** to its on-disk **Target** destination.
_Avoid_: deploy, push, sync.

**Install record**:
A persisted entry tracking that a specific **Primitive** **Version** was installed to a specific **KindTarget**, with hashes and mtimes for **Drift** detection.
_Avoid_: install entry, deployment record.

**Drift**:
Divergence between an **Install record** and the current on-disk bytes at the install path.
_Avoid_: diff, mismatch, out-of-sync.

**Foundation**:
The agent-agnostic substrate every Agent rides on: the multi-agent schema, the Adapter seam + orchestrator, the dashboard shell, and the OTEL ingest endpoints. Contains no Agent-specific logic.

**Phase**:
One self-contained delivery slice, documented in its own file under `docs/phases/`. Phase 0 = Foundation; Phases 1–4 = one Agent each (Claude → Codex → Pi → Antigravity); Phase 5 = Operations layer.

**Library consolidation track**:
A staged delivery track for bringing Prompt Library into the dashboard: read-only bridge/backend, dashboard overview/detail UI, then write/editor/install parity.
_Avoid_: calling it Phase 5 or rewriting the existing Phase sequence.

**Error**:
A single failed tool call within a session — a `tool_result` the Agent marked `is_error` (a command that exit-coded non-zero, an Edit whose match failed, etc.). Code-actionable: it has a locatable point in the transcript, a failing tool input, and captured error text. Counted as `error_count`; the `errored` outcome means `error_count > 0`.
_Avoid_: using "error" for session-level operational stoppages (those are a Failure).

**Failure**:
The umbrella for any session that didn't finish cleanly — the union of three disjoint **outcomes**: `errored` (has Errors), `rate_limited` (hit a provider rate limit), and `truncated` (cut off at the token limit). Rate-limited and truncated Failures carry **no** Error — there's no failed tool call to point at, just a session-level signal. The Failures panel lists all three; the Errors view only opens windows on `errored` Failures.
_Avoid_: treating "Failure" and "Error" as synonyms — every Error implies a Failure, but not every Failure has an Error.

**Message**:
One readable entry in a session's **Transcript** — a *user* prompt, an *assistant* reply, a *thinking* step, or a *tool* call paired with its result. Parsed on demand from the raw log; **not** the same as a raw log *line* (one Agent message can span several lines, and a tool's call + result are two lines collapsed into one Message). A *thinking* Message exists only where the reasoning text is readable — **Claude only**; Codex and Pi store reasoning as `encrypted_content`, so no thinking Message is emitted for them (no empty placeholders).
_Avoid_: equating a Message with a JSONL line; calling the raw line a "message".

**Transcript**:
The full ordered list of **Messages** for one session, produced by re-parsing the raw log on demand (same parse the Errors view uses). The **Errors** view *windows* it around errored tool Messages; the **Messages** tab renders it *whole* as cards — but only for **ended** sessions. A still-live session shows the raw byte-tail feed instead (a live tail can't be reassembled into Messages mid-stream), switching to cards once it ends.
_Avoid_: "the feed" for both — the live raw tail and the parsed Transcript cards are different views chosen by session state.

## Relationships

- The **Foundation** defines the **Adapter** seam; each **Agent** contributes exactly one **Adapter**.
- The **Observability layer** spans all four **Agents**; the **Operations layer** covers only Claude Code.
- The **Library layer** manages reusable Prompt Library **Primitives** across downstream **Targets**; it is neither read-only **Observability** nor Claude-only **Operations**.
- The **Library layer** is being consolidated from the standalone Prompt Library app in stages; the Prompt Library Rust crates move into this repo, while the standalone app remains the reference implementation until dashboard parity.
- The file-backed **Library** remains the source of truth; dashboard SQLite may cache or index Library data but must not own it.
- The **Library layer** gets its own top-level Library route; the existing Skills & MCP route remains an **Observability layer** surface.
- A **Primitive** has exactly one **Kind** and zero-or-more allowed **Targets**.
- **Target names** stay in Prompt Library vocabulary; map them to dashboard **Agents** only for explicit cross-links.
- A **Primitive** has one **Working copy** and zero-or-more **Versions**.
- A **Working copy** has one base and zero-or-more **Overlays**.
- A (**Primitive**, **Target**) pair **Materializes** into bytes whose **InstallLayout** is determined by the **KindTarget** and bundle shape.
- An **Install** produces an **Install record**; later **Drift** is detected by comparing the install path against that record.
- Every token figure produced by an **Adapter** carries a **Fidelity**; **Burn** aggregates them per **Agent** per day.
- Every **Agent** gets an **Estimated cost** (rack-rate, uniform); only Claude and Pi also get a **Native cost**. The two are never summed into one total; **Estimated cost** is the cross-agent money axis, **tokens** the rawest one.
- A **Phase** delivers either the Foundation, one Agent's Adapter + panels, or the Operations layer — never a mix.
- The **Library consolidation track** is separate from the existing **Phase** sequence; it does not become Phase 5 or renumber Observability/Operations work.

## Example dialogue

> **Dev:** "Does adding Pi touch the Operations layer at all?"
> **Scott:** "No. Pi is an Agent — it gets an Adapter and lights up the Observability panels. The Operations layer is Claude-only and ships last, in its own Phase."
> **Dev:** "And Antigravity's tokens — are those exact?"
> **Scott:** "Exact, but decoded from a protobuf blob, not native. No USD cost though, so Burn shows it tokens-only."

## Flagged ambiguities

- "the dashboard" was used to mean both the whole product and the read-only Observability half — resolved: **Observability layer** vs **Operations layer** are distinct, and Phase ordering deliberately ships all Observability (Phases 0–4) before any Operations (Phase 5).
- "pull Prompt Library into the dashboard" could mean adding it to the **Operations layer** because it writes to local agent-tool homes — resolved: the imported capability is a separate **Library layer**, since it manages reusable content across downstream **Targets** rather than dispatching or killing running **Agents**.
- "Agent" now appears in two domains: dashboard **Agent** means a coding-agent CLI, while Prompt Library `Agent` is a **Kind** of **Primitive** — resolved: keep **Agent** for the CLI and say **Agent Primitive** or **Agent Kind** when discussing the reusable content kind.
- "pulling Prompt Library in" could mean a permanent companion integration or full product consolidation — resolved: pursue staged full consolidation into the dashboard, using the standalone Prompt Library as the reference implementation until parity.
- "Library consolidation" could be treated as Phase 5 because it writes to local agent-tool homes — resolved: it is a separate **Library consolidation track** and the existing Phase 5 remains the Claude-only **Operations layer**.
- "error" vs "failure" were used interchangeably (the Failures panel spans crashes/rate-limits/truncations, while the AgentCard "errors" cell counts only `error_count`) — resolved: an **Error** is one failed tool call (code-actionable); a **Failure** is any unclean session outcome (`errored` · `rate_limited` · `truncated`). The Errors view anchors context windows only on **Errors**; rate-limited/truncated **Failures** show a one-line explanation and defer to the Messages feed.
- "the Messages feed" originally meant the raw byte-tail JSONL stream (ADR-0005 made it the *raw* "source of truth", deliberately un-parsed) — amended: for **ended** sessions the Messages tab now renders the parsed **Transcript** as cards; the raw tail survives only for **live** sessions. The Errors and Messages views are now both *parsed* (windowed vs whole), no longer *parsed vs raw*. See ADR-0006.
