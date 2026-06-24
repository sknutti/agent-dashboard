---
name: design-system-review
description: Review a Svelte UI diff for adherence to this project's design system (the contract in docs/design-system-contract.md). Use for "design system review", "review UI for design-system compliance", "check design system adherence", "did this migration follow the design system", or before merging any branch that adds/migrates UI components. The SEMANTIC complement to the mechanical gate (ui/scripts/check-design-system.ts): the gate catches raw hex + bare native controls; this skill judges whether the RIGHT primitive was used, whether a ds-allow-native escape is justified, token/CVD/a11y discipline, Svelte 5 runes correctness, and behavior preservation.
---

# Design-System Review

You are reviewing a **Svelte 5 (runes)** UI diff against the project's design-system contract.
The authoritative spec is `docs/design-system-contract.md` — read it before reviewing if it
is not already in context. The component library lives ONLY in
`ui/src/lib/components/ui/` (Button, IconButton, Input, Textarea, Select, Checkbox, Field,
Callout, MetricBar, Stat, Badge, plus existing Card, EmptyState, Icon, Sheet, Tooltip,
Accordion, CollapsibleSection, RangeToggle, StatePill, InfoModal, OtelIndicator). Tokens and
the `.u-*` utility layer live in `ui/src/app.css`.

This review is the **semantic complement** to the mechanical gate
(`ui/scripts/check-design-system.ts`). The gate flags raw hex in `<style>` and bare native
controls outside the library — it cannot tell whether a `ds-allow-native` annotation is
honest, whether the right primitive was chosen, or whether a migration preserved behavior.
That judgment is your job. Do not re-report what the gate already prints mechanically; fold
its output in, then add the semantic findings only the human (you) can make.

## Quick start

1. **Scope the diff.** Default to changes vs. the merge-base:
   ```
   git diff --merge-base main -- 'ui/src/**/*.svelte' 'ui/src/**/*.ts' 'ui/src/app.css'
   ```
   If the user named a base (commit/branch/PR), diff against that instead. Review only changed
   hunks unless asked for a whole-file audit.
2. **Run the mechanical gate and the type check; fold both in:**
   ```
   bun run ui/scripts/check-design-system.ts     # the gate (direct path always works)
   bun run check:ds                              # same gate, IF wired into package.json yet
   cd ui && bun run check                        # svelte-check (runes/types/a11y warnings)
   ```
   The gate prints `file:line` for raw-hex and bare-native-control violations. If
   `check:ds` is not yet a script (the wiring may still be in progress), use the direct
   `bun run ui/scripts/...` form. A clean gate is necessary but NOT sufficient — the six
   dimensions below are what you actually review.
3. **Review the diff against the six dimensions**, produce findings in the output format below,
   and self-verify against the checklist.

## The six review dimensions

### 1. Bare native controls & honest escape hatches
The gate flags bare `<button>/<input>/<select>/<textarea>` outside the library. Your job is the
**escape hatch**: a flagged element is suppressed when its line — or the line immediately above —
contains `ds-allow-native: <reason>`. The token is literally `ds-allow-native:` followed by a
short reason (see the honest examples already in the tree: a clickable list-row in
`FailuresPanel.svelte`, a full-pane code editor in `WorkingFileEditor.svelte`, a custom tab-strip
in `TargetOverlayPane.svelte`, a disclosure widget in `McpPanel.svelte`).

- **Finding:** a real form/action control hiding behind `ds-allow-native:` — a true action
  `<button>` (Save/Cancel/Run/Delete), a text `<input>`, a `<select>`, or a `<textarea>` that
  maps cleanly to a primitive. The escape hatch is ONLY for structural interactive elements
  (whole clickable rows, custom disclosure/tab widgets) that have no form-control primitive.
- **Finding:** a `ds-allow-native:` with a vague or false reason ("temporary", "TODO",
  "doesn't fit") instead of a specific structural justification.
- Not a finding: a genuinely structural element with an accurate reason, or a native element
  inside `ui/src/lib/components/ui/` (the library is exempt — that is where native controls live).

### 2. Correct primitive usage (right tool, right props, no one-offs)
- **Right component for the job:**
  - Action/submit/destructive control → `<Button variant="default|primary|ghost|danger" size="sm|md">`.
    Icon-ONLY control → `<IconButton icon=… label=…>` (icon-only is forbidden on `Button`).
    A whole clickable row → structural native with `ds-allow-native:`, not a `Button`.
  - Note/message/inline-error box → `<Callout tone="neutral|info|warn">`; a panel's empty/error
    state → `<EmptyState>`. Don't hand-roll a `.note` div or a bordered message box.
  - A progress/proportion bar (incl. stacked token-mix bars) → `<MetricBar>`; not a raw
    `<div class="bar">`.
  - A label+value figure cluster → `<Stat>`; a status/count pill → `<Badge>` (there is no Pill
    primitive — hand-rolled `.pill` must fold into `<Badge>`).
  - A label+control pair → wrap in `<Field label hint error>` where it maps cleanly.
- **Props used per contract:** `Button` maps `.primary→primary`, `.ghost→ghost`, `.danger→danger`,
  else `default`; `danger` is amber, not red. `IconButton.label` is REQUIRED. `MetricBar`
  segment colors must be `var(--tok-*)` token strings, never hex. Flag wrong/missing props.
- **No reintroduced one-off CSS** that duplicates a utility or primitive: text styling must use
  the global utilities `.u-muted` / `.u-dim` / `.u-subtle` / `.u-big` / `.u-sub` / `.u-label` /
  `.u-mono` (and existing `.mono` / `.kicker`). A new local `.muted`/`.dim`/`.big`/`.sub`/`.lbl`/
  `.note`/`.pill`/`.bar`/`.act` class in the diff is a finding — it should be a utility or primitive.

### 3. Token discipline
- **Zero raw hex in any `<style>` block** (the gate catches this mechanically — confirm it ran
  clean; if a hex slipped into `<script>` as a data-driven chart ramp, e.g. a `RAMP[]`, that is
  intentionally exempt and NOT a finding).
- Colors must reference **semantic tokens**: surfaces `--bg/--surface/--surface-2`; borders
  `--border/--border-glow`; text `--text/--text-dim/--text-subtle`; accent `--accent-from/--accent-to`
  (note: bare `--accent` is undefined — `color-mix(... var(--accent) ...)` silently drops, a real bug);
  status `--green/--amber/--red/--cyan`; token-mix `--tok-output/-input/-reasoning/-cache-write`;
  contrast inks `--accent-ink/--surface-floating/--on-light-seg/--on-dark-seg`.
- **A genuinely new color must go through a new token in app.css**, not a literal in a component.
  Inline `color-mix(...)` over existing tokens is fine and idiomatic.

### 4. CVD & accessibility (Scott is red/green colorblind)
- **Never color-alone.** Every status/meaning must also carry a glyph, text, or shape; hue only
  reinforces. A new state distinguished only by red-vs-green (or any color with no glyph/label)
  is a **blocker**.
- **Prefer amber/cyan over red/green.** `Button danger`, `Callout warn`, and `Field error` are
  amber by design; `Callout info` is cyan. Flag a migration that reintroduces red as a primary
  signal, and NEVER allow red+green as the sole differentiator.
- **Accessible names:** `IconButton`/icon-only controls need a `label` (→ aria-label); inputs need
  a `<label>` or `<Field label>`; `Callout`/error boxes used as alerts should pass `role="alert"`.
- **Focus & keyboard:** focus states must survive the migration (primitives use
  `border-color: var(--border-glow)` on focus/hover) — flag removed `:focus` styling or a
  structural `<div onclick>` with no keyboard handler/role.

### 5. Svelte 5 runes correctness
- **No Svelte 4:** no `export let`, no `<slot>`. Props via `$props()`; content via `Snippet` +
  `{@render children()}`. A reintroduced `export let` or `<slot>` is a finding.
- **No `$effect`** except synchronizing with a truly external system (the AppShell health-poll is
  the sanctioned example). A `$effect` used for derived state, prop-sync, or event handling is a
  finding — it should be `$derived`, a handler, or a `key`-based reset.
- **`$bindable` preserved:** primitives expose `value = $bindable("")` / `checked = $bindable(false)`
  so callers can `bind:value` / `bind:checked`. A migration that drops `bind:` (passing `value=`
  one-way where the old control was two-way) silently breaks input — a blocker.

### 6. Behavior preservation (keep the 20 *.test.ts green)
Migrations must not change a component's observable contract:
- **Public props, rendered text, and labels** unchanged (button text, placeholders, titles).
- **ARIA roles & accessible names** preserved (tests assert on `getByRole`/`getByLabelText`).
- **`bind:` targets and event handlers** preserved (`onclick`, `oninput`, `onchange`,
  `onkeydown`) — same handler, same semantics. `disabled`/`loading` must still block the click.
- Flag anything that would flip a test red; if a `*.test.ts` exists for a touched area, the
  reviewer should confirm `cd ui && bun run test` (or the area's test) is green and fold that in.

## Output format

Report findings grouped by severity. Each finding: `file:line` · the rule/dimension · a concrete fix.

```
## Design-system review — <base>..<head>

### Gate & checks
- check:ds (ui/scripts/check-design-system.ts): PASS | FAIL (N violations) — <summary or "folded below">
- svelte-check (cd ui && bun run check): PASS | N warnings
- tests (cd ui && bun run test): PASS | FAIL — <which>

### Blockers (must fix before merge)
- `ui/src/.../Foo.svelte:42` · CVD / color-alone — new "ok vs error" state is green-vs-red only.
  Fix: add a glyph (Icon "check"/"alert") + text label; lean on amber for the error tone.
- `ui/src/.../Bar.svelte:88` · $bindable dropped — `<Input value={x}>` is one-way; old control was two-way.
  Fix: `<Input bind:value={x}>`.

### Should-fix
- `ui/src/.../Baz.svelte:17` · wrong primitive — action <button class="act"> kept behind ds-allow-native.
  Fix: `<Button variant="default" size="sm" onclick={…}>Save</Button>`; remove the annotation.

### Nits
- `ui/src/.../Qux.svelte:5` · one-off CSS — local `.muted` duplicates the `.u-muted` utility.
  Fix: delete the rule, use `class="u-muted"`.

### Clean
- <dimensions that passed, briefly — e.g. "token discipline clean, no raw hex; runes correct">
```

Severity guide: **blocker** = CVD color-alone, dropped `$bindable`/two-way binding, behavior
change that breaks a test, a real action control hidden behind `ds-allow-native`, raw hex the
gate missed. **should-fix** = wrong primitive choice, missing `IconButton` label, `$effect`
misuse, a vague escape-hatch reason. **nit** = one-off CSS duplicating a utility, minor prop
inconsistency, an import that could use the `../ui` barrel (don't churn untouched imports).

## Reviewer self-check

- [ ] Ran the gate directly (`bun run ui/scripts/check-design-system.ts`) AND `cd ui && bun run check`; folded both in.
- [ ] Every bare-native flagged by the gate is either a justified `ds-allow-native:` (honest structural reason) or a finding to migrate.
- [ ] No real action/form control (Button/Input/Select/Checkbox/Textarea) is hiding behind the escape hatch.
- [ ] Right primitive per job: Button vs IconButton vs clickable row; Callout vs EmptyState; MetricBar vs raw bar; Badge vs hand-rolled pill; Field for label+control.
- [ ] No reintroduced one-off CSS duplicating `.u-*` utilities or a primitive (`.muted/.dim/.big/.sub/.lbl/.note/.pill/.bar/.act`).
- [ ] No raw hex in `<style>`; colors use semantic tokens; any new color added as an app.css token.
- [ ] CVD: no color-alone signal; amber/cyan preferred over red/green; never red+green as the sole differentiator.
- [ ] A11y: IconButton/icon-only have labels; inputs have labels/Field; error Callouts have role; focus + keyboard paths intact.
- [ ] Runes: no `export let`/`<slot>`; no `$effect` except external-system sync; `$bindable` preserved so `bind:` works.
- [ ] Behavior preserved: public props, rendered text, ARIA roles, bind/handler semantics unchanged; touched-area tests green.
- [ ] Findings are grouped by severity, each with `file:line` + a concrete fix.
