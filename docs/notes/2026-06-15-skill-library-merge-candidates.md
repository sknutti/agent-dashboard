# Skill-library merge candidates

_Date: 2026-06-15_

Audit of `~/.claude/skills` (global skill library, 39 skills at time of writing) to find
skills that overlap enough to merge or consolidate. Grouped by strength of the case.
Status column tracks what's already been actioned in this consolidation pass.

## Tier 1 — Near-duplicates, should merge

| Pair | Overlap | Status |
|------|---------|--------|
| `grill-me` → `grill-with-docs` | `grill-with-docs` opens with the *exact same* instruction text as `grill-me`, then adds a domain-awareness/ADR section. `grill-me` is a literal subset. | **DONE** — folded into `grill-with-docs` (owns the FORMAT assets), broadened its description to capture the "grill me" trigger, gated the docs/ADR behavior to code plans only, deleted `grill-me`. |
| `agent-browser` ↔ `playwright-bowser` | Both are headless-browser-automation CLIs doing the identical job (navigate, snapshot, click, screenshot, scrape, parallel sessions) via different binaries. `agent-browser` bills itself as "Alternative to Playwright MCP." They compete for the same triggers. | **DONE — kept `playwright-bowser`, retired `agent-browser`.** Compared both installed CLIs (`@playwright/cli` 0.1.1 vs Vercel `agent-browser` 0.10.0, npm latest 0.27.3 so the local copy was 17 minors stale). Roughly at capability parity; decided on official Playwright backing (maintenance longevity), in-context **vision mode** screenshots, better skill hygiene (progressive disclosure via the 20KB reference), and ecosystem fit (`bowser-qa-agent`/`playwright-bowser-agent` subagents). Tradeoff accepted: lose `agent-browser`'s semantic locators (`find role/text/label`) and device/geo/offline/media emulation. Absorbed `agent-browser`'s trigger phrases ("browse website", "fill form", "click button", "scrape page", "web automation") into `playwright-bowser`'s description, verified no other skill/agent referenced `agent-browser`, then trashed the skill dir. NOTE: the `agent-browser` npm global binary is still installed — skill retired, CLI left in place. |
| `tdd` ↔ `tdd-integration` | Both are red-green-refactor for new features; triggers collide ("implement", "build", "add feature"). Difference is *mechanism*: `tdd` teaches inline discipline (vertical slices, anti-horizontal-slicing); `tdd-integration` delegates each phase to `tdd-test-writer`/`tdd-implementer`/`tdd-refactorer` subagents. | **DONE** — merged into `tdd`: kept its philosophy/workflow/reference files, folded both trigger sets into the description, and added an "Execution modes" selector (Inline default vs Delegated subagent dispatch). Deleted `tdd-integration`. |

## Tier 2 — Real overlap + colliding triggers; consolidate or sharpen boundaries

| Cluster | Overlap | Status |
|---------|---------|--------|
| `continual-learning` ↔ `compound-docs` | Both capture knowledge across sessions. `continual-learning` = lightweight, always-on, captures anything (maps/patterns/gotchas/workflows). `compound-docs` = heavyweight 7-step solved-problem recorder with enum-validated YAML, ported from a Rails project (Rails enums, "Stage 0-6", `hotwire-native`, `skill-creator` refs, stale `codify-docs` self-reference) — misfit for this stack. | **RESOLVED** — deleted `compound-docs`; made `continual-learning` the source of truth (fixed its malformed frontmatter: added `name:`, folded `trigger:` into `description:`); aligned its reference-artifact path to `docs/` to match global `CLAUDE.md`. |
| `mentor` ↔ `teach` ↔ `study-plan` | All three claim "teach me"/"help me learn" triggers. `mentor` = inline conversational explanation (auto-triggered). `teach` = stateful multi-session workspace producing HTML lessons (command-only). `study-plan` = one-shot research-backed curriculum doc. `mentor` vs `study-plan` collide on auto-triggers. | **DONE (sharpened, not merged)** — outputs are genuinely distinct (live explanation vs. static curriculum vs. interactive course), so merging would lose capability. Carved three non-overlapping lanes in both the frontmatter descriptions and in-body "When to Activate" sections, and cross-linked them as stages (plan → deliver → explain): `mentor` = explain one thing now; `study-plan` = generate a curriculum to master a topic; `teach` = deliver lessons interactively over sessions (stays command-only). Resolved the `mentor`/`study-plan` trigger collision. |
| `brainstorm` ↔ `ideation` | Both explore "what to build" pre-implementation, trigger on brainstorm/explore-options phrasing. `brainstorm` = single-agent dialogue → design doc. `ideation` = heavyweight multi-agent team (Free Thinker/Grounder/Arbiter), requires experimental Agent Teams. | **DONE (kept both, boundary sharpened)** — outputs/mechanisms are distinct so merging would lose capability. Rewrote `ideation`'s description to lead with "heavyweight, multi-agent variant of `brainstorm` … requires experimental Agent Teams" and gated it to "ONLY when the user explicitly wants the multi-agent team treatment," deferring the default to `brainstorm`. Added a reciprocal "Heavier alternative" pointer in `brainstorm`'s body. Lightweight one now wins by default. |
| `improve` ↔ `improve-codebase-architecture` | Both survey a codebase read-only → improvement plans. `improve` = broad (bugs/security/perf/tests/tech-debt/roadmap). `improve-codebase-architecture` = narrow specialization (Ousterhout "deep module" refactors, informed by CONTEXT.md/ADRs) — essentially a mode of `improve`. | **DONE (sharpened to a bounded specialization)** — sharpened `improve-codebase-architecture`'s description to "narrow, architecture-only specialization … For a broad multi-category audit … use `improve` instead." Added a reciprocal "Scope note" in `improve`'s body deferring pure module-depth dives to the specialization. Kept separate (distinct glossary/deletion-test workflow), not folded in. |

## Tier 3 — Families / minor overlap (optional)

| Cluster | Note | Status |
|---------|------|--------|
| `jira` / `jira-resolve-questions` / `jira-ticket-enrich` | Not duplicates (general CRUD vs. two narrow operations), but a candidate family to fold into one skill with sub-commands. | **DONE (kept three, disambiguated — full merge rejected)** — a 3→1 sub-command merge fails on a frontmatter constraint: `context`/`agent`/`allowed-tools` are per-skill, not per-subcommand, so one merged skill can't run `jira` inline *and* fork `jira-ticket-enrich` into its `jira-ticket-research-enricher` agent. Kept all three; reframed `jira`'s description as the general-CRUD hub that routes the two specialized workflows to their skills, and added reciprocal "for general ops use `jira`" pointers in both specialized descriptions. (Considered folding only `jira-resolve-questions` into `jira` — option 1 — but Scott chose the zero-risk disambiguation.) |
| `review` ↔ `clean-architecture-react-review` | Both grab "review code", but `review` is a general standards+spec diff review and the other is a React/TS clean-architecture audit. Low risk; just a shared trigger phrase. | **DONE (boundary sharpened)** — collision was one-directional: `clean-architecture-react-review` greedily claimed bare "review code"/"review for best practices". Dropped those generic triggers and rescoped its description to a *whole-codebase React/TS architecture audit (as it stands, not a changeset)*, deferring diff/branch/PR reviews to `review`. Added reciprocal scope-pointer blockquotes in both bodies. |

## Deliberately NOT merged (look similar, aren't)

- `ast-grep` (code AST search) vs `qmd` (personal-notes RAG) — different domains.
- `synthesize` (combine docs into one) vs `handoff` (compact a conversation) vs `compound-docs` — different purposes.
- `plan` vs `document-review` vs `brainstorm` — sequential workflow stages, not alternatives.

---

# Command-library pass

_Date: 2026-06-16_

Audit of `~/.claude/commands/` (6 commands: `workflows:brainstorm`, `workflows:plan`,
`deepen-plan`, `workflows:work`, `workflows:review`, `workflows:compound`). All six were the
**compound-engineering plugin pipeline** (`brainstorm → plan → deepen-plan → work → review →
compound`), cross-referencing each other.

## The finding

No two commands duplicated *each other* — the overlap was entirely **command-vs-skill**. The
whole `workflows:*` pipeline was a redundant, Rails-contaminated, dead-reference-riddled
mirror of the curated **skill** pipeline (`brainstorm` → `plan` → `tdd`/execution → `review`
+ `/code-review` → `continual-learning`). Two damning signals:

1. **Rails contamination** in a Rust project — `bin/rails test`, `app/services/*.rb`,
   `db/schema.rb`, ActiveRecord, Hotwire Native, `bin/dev`. Same misfit that justified
   deleting `compound-docs` in the skills pass.
2. **Dead references** — the commands pointed at skills/agents/commands that don't exist,
   several deleted in the skills pass: skills `compound-docs` (deleted), `agent-browser`
   (retired), `file-todos`, `imgup`, `git-worktree`, `orchestrating-swarms`; agents
   `cora-test-reviewer`, `every-style-editor`, `dhh-rails-style`, `code-reviewer`; commands
   `/triage`, `/resolve_todo_parallel`, `/technical_review`, `/test-browser`, `/xcode-test`,
   `/research`. `workflows:compound` was already broken (routed to the deleted `compound-docs`).

## Decision: salvage features, then retire the whole pipeline

Scott chose the thorough path — port the 3 capabilities the commands had that the skills
lacked into the skill layer, **then trash all 6 commands**.

| Command | Disposition | Status |
|---------|-------------|--------|
| `workflows:brainstorm` | Strictly inferior to the `brainstorm` skill (which it even tried to "load"); divergent output path (`docs/brainstorms/` vs skill's `docs/designs/`). | **RETIRED** — defer to `brainstorm` skill. |
| `workflows:review` | Inferior to `review` skill + `/code-review`; worst dead-ref offender (file-todos, browser/xcode test, rails reviewers). | **RETIRED** — defer to `review` skill / `/code-review`. |
| `workflows:compound` | Already broken — routed to deleted `compound-docs`. | **RETIRED** — defer to `continual-learning` (the source of truth set in the skills pass). |
| `workflows:plan` | Duplicated `plan` skill, but had a real **4-lens verification gate**. | **SALVAGED → RETIRED** — ported the gate (architecture/security/test-first/clarity rubric + ambiguity table + numeric gate + optional deep-verification pointer) into `plan` skill's Phase 4. Note: `plan` skill is `context: fork` on `implementation-planner`, which has **no Agent tool**, so the gate is a self-check by default; the parallel-sub-agent version is documented as an optional main-context/`document-review` pass. |
| `workflows:work` | No skill equivalent — whole-plan execution loop. | **SALVAGED → RETIRED** — created new `work` skill (inline). Kept red-green-refactor loop, test-integrity rules, incremental commits, quality gate, PR flow; de-Railsed; dropped dead refs (agent-browser→`playwright-bowser`, imgup dropped + **no-external-upload rule baked in**, swarm/figma/compound-badge removed, file-todos→`TodoWrite`). |
| `deepen-plan` | No skill equivalent — research fan-out enhancement. | **SALVAGED → RETIRED** — created new `deepen-plan` skill (inline, so it keeps fan-out). Generalized skill/agent/learning discovery, context7 MCP, de-Railsed. |

## Cross-references fixed (skills pointing at retired commands)

- `plan` skill: `/workflows:deepen-plan` → `/deepen-plan`, `/workflows:work` → `/work` (×2).
- `document-review` skill: `/workflows:brainstorm`/`/workflows:plan` → `/brainstorm`/`/plan`.
- `jira` skill: `/workflows:plan` → `/plan`, `/workflows:work` → `/work`.

Net: command library went 6 → 0; skill library gained `work` and `deepen-plan`, and `plan`
absorbed the verification gate. The pipeline is now skill-only, clean, and cross-consistent.
