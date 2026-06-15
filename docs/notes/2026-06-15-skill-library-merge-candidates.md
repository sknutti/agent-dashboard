# Skill-library merge candidates

_Date: 2026-06-15_

Audit of `~/.claude/skills` (global skill library, 39 skills at time of writing) to find
skills that overlap enough to merge or consolidate. Grouped by strength of the case.
Status column tracks what's already been actioned in this consolidation pass.

## Tier 1 — Near-duplicates, should merge

| Pair | Overlap | Status |
|------|---------|--------|
| `grill-me` → `grill-with-docs` | `grill-with-docs` opens with the *exact same* instruction text as `grill-me`, then adds a domain-awareness/ADR section. `grill-me` is a literal subset. | **DONE** — folded into `grill-with-docs` (owns the FORMAT assets), broadened its description to capture the "grill me" trigger, gated the docs/ADR behavior to code plans only, deleted `grill-me`. |
| `agent-browser` ↔ `playwright-bowser` | Both are headless-browser-automation CLIs doing the identical job (navigate, snapshot, click, screenshot, scrape, parallel sessions) via different binaries. `agent-browser` bills itself as "Alternative to Playwright MCP." They compete for the same triggers. | **PENDING** — parked; Scott researching which CLI to keep before retiring the other. |
| `tdd` ↔ `tdd-integration` | Both are red-green-refactor for new features; triggers collide ("implement", "build", "add feature"). Difference is *mechanism*: `tdd` teaches inline discipline (vertical slices, anti-horizontal-slicing); `tdd-integration` delegates each phase to `tdd-test-writer`/`tdd-implementer`/`tdd-refactorer` subagents. | **DONE** — merged into `tdd`: kept its philosophy/workflow/reference files, folded both trigger sets into the description, and added an "Execution modes" selector (Inline default vs Delegated subagent dispatch). Deleted `tdd-integration`. |

## Tier 2 — Real overlap + colliding triggers; consolidate or sharpen boundaries

| Cluster | Overlap | Status |
|---------|---------|--------|
| `continual-learning` ↔ `compound-docs` | Both capture knowledge across sessions. `continual-learning` = lightweight, always-on, captures anything (maps/patterns/gotchas/workflows). `compound-docs` = heavyweight 7-step solved-problem recorder with enum-validated YAML, ported from a Rails project (Rails enums, "Stage 0-6", `hotwire-native`, `skill-creator` refs, stale `codify-docs` self-reference) — misfit for this stack. | **RESOLVED** — deleted `compound-docs`; made `continual-learning` the source of truth (fixed its malformed frontmatter: added `name:`, folded `trigger:` into `description:`); aligned its reference-artifact path to `docs/` to match global `CLAUDE.md`. |
| `mentor` ↔ `teach` ↔ `study-plan` | All three claim "teach me"/"help me learn" triggers. `mentor` = inline conversational explanation (auto-triggered). `teach` = stateful multi-session workspace producing HTML lessons (command-only). `study-plan` = one-shot research-backed curriculum doc. `mentor` vs `study-plan` collide on auto-triggers. | **DONE (sharpened, not merged)** — outputs are genuinely distinct (live explanation vs. static curriculum vs. interactive course), so merging would lose capability. Carved three non-overlapping lanes in both the frontmatter descriptions and in-body "When to Activate" sections, and cross-linked them as stages (plan → deliver → explain): `mentor` = explain one thing now; `study-plan` = generate a curriculum to master a topic; `teach` = deliver lessons interactively over sessions (stays command-only). Resolved the `mentor`/`study-plan` trigger collision. |
| `brainstorm` ↔ `ideation` | Both explore "what to build" pre-implementation, trigger on brainstorm/explore-options phrasing. `brainstorm` = single-agent dialogue → design doc. `ideation` = heavyweight multi-agent team (Free Thinker/Grounder/Arbiter), requires experimental Agent Teams. | Open — keep both, mark `ideation` explicitly as the heavyweight variant so the lightweight one wins by default. |
| `improve` ↔ `improve-codebase-architecture` | Both survey a codebase read-only → improvement plans. `improve` = broad (bugs/security/perf/tests/tech-debt/roadmap). `improve-codebase-architecture` = narrow specialization (Ousterhout "deep module" refactors, informed by CONTEXT.md/ADRs) — essentially a mode of `improve`. | Open — make it a documented sub-mode, or sharpen its description to "architectural depth only." |

## Tier 3 — Families / minor overlap (optional)

| Cluster | Note | Status |
|---------|------|--------|
| `jira` / `jira-resolve-questions` / `jira-ticket-enrich` | Not duplicates (general CRUD vs. two narrow operations), but a candidate family to fold into one skill with sub-commands. | Open — low priority. |
| `review` ↔ `clean-architecture-react-review` | Both grab "review code", but `review` is a general standards+spec diff review and the other is a React/TS clean-architecture audit. Low risk; just a shared trigger phrase. | Open — low priority. |

## Deliberately NOT merged (look similar, aren't)

- `ast-grep` (code AST search) vs `qmd` (personal-notes RAG) — different domains.
- `synthesize` (combine docs into one) vs `handoff` (compact a conversation) vs `compound-docs` — different purposes.
- `plan` vs `document-review` vs `brainstorm` — sequential workflow stages, not alternatives.
