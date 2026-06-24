# Design System Contract

**Status:** authoritative spec for the design-system refactor (branch `worktree-design-system`).
Every agent building or migrating UI codes against THIS document. If reality and this
doc disagree, fix the doc first, then build — do not silently diverge.

## 0. Context & non-goals

This is a **Svelte 5 (runes)** UI. The token system in `ui/src/app.css` is already a
clean, CVD-aware single source of truth (ADR-0004 luminance ramp). **We do NOT restructure
tokens.** We ADD: a typography/utility CSS layer, a set of missing component primitives,
and we MIGRATE every hand-rolled control onto them. Then an automated gate forbids bypassing.

Hard constraints (non-negotiable):
- **Svelte 5 runes** only: `$props`, `$state`, `$derived`, `$bindable`, snippets (`Snippet`,
  `{@render}`). No Svelte 4 `export let` / slots. Match the existing components' style.
- **No `$effect`** except synchronizing with a truly external system (see AppShell's health
  poll comment). None of the primitives below need one.
- **Semantic tokens only — zero raw hex in any `<style>` block.** (See §6 for the few
  contrast colors that get new tokens instead.)
- **Never color alone.** Scott is red/green colorblind. Every status meaning carries a
  glyph/text/shape too; hue only reinforces. Never pair red+green as the sole signal.
  Prefer amber/cyan over red/green; the existing code already does this — preserve it.
- **Keep all 20 `*.test.ts` green.** Migrations must not change a component's public props,
  rendered text, roles, or `bind:` semantics that tests assert on. Run tests after each file.
- Components stay under ~200 lines; composition over configuration.

## 1. File layout

```
ui/src/lib/components/ui/          # THE library — the only place native controls live
  Button.svelte        (NEW)
  IconButton.svelte    (NEW)
  Input.svelte         (NEW)
  Textarea.svelte      (NEW)
  Select.svelte        (NEW)
  Checkbox.svelte      (NEW)
  Field.svelte         (NEW)
  Callout.svelte       (NEW)
  MetricBar.svelte     (NEW)
  Stat.svelte          (NEW)
  Badge.svelte         (exists — fix hex; Pill usage folds into this)
  Card, EmptyState, Icon, Sheet, Tooltip, Accordion, CollapsibleSection,
  RangeToggle, StatePill, InfoModal, OtelIndicator   (exist — keep)
  index.ts             (NEW barrel — re-exports every primitive)
ui/src/app.css                     # tokens (unchanged) + NEW typography utility layer (§5)
ui/scripts/check-design-system.ts  (NEW — the enforcement gate, §7)
```

**Barrel (`index.ts`):** `export { default as Button } from "./Button.svelte";` for every
primitive. New/migrated code SHOULD import from the barrel:
`import { Button, Input, Field } from "$ui";` — but a path alias may not exist, so use a
relative `"../ui"` / `"./ui"` import of the barrel. Existing direct imports keep working;
do not churn imports you aren't otherwise touching.

## 2. Token reference (already defined in app.css — use, don't redefine)

Surfaces `--bg --surface --surface-2`; borders `--border --border-glow`;
text `--text --text-dim --text-subtle`; accent `--accent-from (#ff7a3c) --accent-to --accent-gradient`;
status `--green --amber --red --cyan`; token-mix ramp `--tok-output/-input/-reasoning/-cache-write`;
type `--font-sans --font-mono`; shape `--radius (15) --radius-sm (10) --pad (28) --ease`.

> **`--accent` (bare) is NOT defined** — `color-mix(... var(--accent) ...)` in MetadataForm /
> WorkingFileEditor / TargetOverlayPane is invalid and silently dropped, so those "primary"
> buttons currently render as plain default buttons. The `Button` `primary` variant fixes
> this by using `--accent-from`. Migrating those buttons to `<Button variant="primary">` is
> a deliberate, documented visual improvement (they finally read as accent), NOT a regression.

## 3. Interactive control primitives (Agent P1a owns these files)

Reproduce the current look exactly (values lifted from `.act` / `.meta-field input` / `.sel` /
`.check` / EmptyState `.retry`). Provide accessible, hard-to-misuse prop contracts.

### Button.svelte
```ts
type ButtonVariant = "default" | "primary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";
let { variant = "default", size = "md", type = "button", disabled = false,
      loading = false, icon, iconSize, href, ariaLabel, onclick,
      class: cls = "", children } : {
  variant?: ButtonVariant; size?: ButtonSize; type?: "button"|"submit"|"reset";
  disabled?: boolean; loading?: boolean;
  icon?: string;            // leading Icon name (optional)
  iconSize?: number;
  href?: string;            // if set, render <a class="btn"> styled identically
  ariaLabel?: string;
  onclick?: (e: MouseEvent) => void;
  class?: string; children?: Snippet;
} = $props();
```
- When `href` set → render `<a>` (no `type`/`disabled`); else `<button {type} {disabled}>`.
- `loading` → disabled + shows current text (and may show a subtle spinner-dot; do NOT
  introduce a new color). Disabled OR loading both block `onclick`.
- `icon` renders a leading `<Icon name={icon} size={iconSize ?? (size==='sm'?13:14)} />`.
- CSS (exact): base `display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border);
  border-radius:8px; background:var(--surface-2); color:var(--text); font-family:inherit;
  cursor:pointer; transition:border-color .15s var(--ease), background .15s var(--ease);`
  - size sm: `padding:4px 11px; font-size:11.5px; border-radius:6px;`  size md: `padding:6px 14px; font-size:12.5px;`
  - hover `:not(:disabled)` → `border-color:var(--border-glow);`
  - `:disabled` → `opacity:.5; cursor:not-allowed;`
  - `.primary` → `background:color-mix(in srgb, var(--accent-from) 20%, var(--surface-2));
    border-color:color-mix(in srgb, var(--accent-from) 45%, var(--border)); color:#ffe9d6;`
    (use the token-mix; the light text mirrors Badge.accent which is being tokenized — see §6,
    use the SAME new `--accent-ink` token for both.)
  - `.ghost` → `background:transparent;`
  - `.danger` → `border-color:color-mix(in srgb, var(--amber) 55%, var(--border));` (amber, not red — CVD)
- A11y: icon-only usage is FORBIDDEN here (use IconButton). `ariaLabel` sets `aria-label` when given.

### IconButton.svelte
Square icon-only button — Sheet close (`.close` 30px r8), InfoModal (`.info-btn` 26px r7),
AppShell search affordance pattern. `label` (aria-label) is **required**.
```ts
let { icon, size = 30, iconSize = 15, label, variant = "default", disabled = false,
      onclick, class: cls = "" } : {
  icon: string; size?: number; iconSize?: number; label: string;   // label REQUIRED
  variant?: "default" | "ghost"; disabled?: boolean;
  onclick?: (e: MouseEvent) => void; class?: string;
} = $props();
```
- CSS: `display:grid; place-items:center; width/height:size; border-radius: size>=30?8px:7px;
  border:1px solid var(--border); background:var(--surface-2); color:var(--text-dim);`
  hover → `color:var(--text); border-color:var(--border-glow);` `ghost` → transparent bg/border.

### Input.svelte
```ts
let { value = $bindable(""), type = "text", placeholder, disabled = false,
      id, ariaLabel, oninput, onkeydown, onchange, class: cls = "" } : {
  value?: string; type?: "text"|"email"|"password"|"search"|"number"|"url";
  placeholder?: string; disabled?: boolean; id?: string; ariaLabel?: string;
  oninput?: (e: Event) => void; onkeydown?: (e: KeyboardEvent) => void;
  onchange?: (e: Event) => void; class?: string;
} = $props();
```
- `<input {type} bind:value {placeholder} {disabled} {id} aria-label={ariaLabel} ...>`
- CSS (exact, from `.meta-field input`): `width:100%; border:1px solid var(--border);
  border-radius:6px; background:var(--surface); color:var(--text); font-family:inherit;
  font-size:13px; padding:6px 8px;` focus → `outline:none; border-color:var(--border-glow);`
  `:disabled` → `opacity:.5; cursor:not-allowed;`  `::placeholder` → `color:var(--text-subtle);`

### Textarea.svelte
Same visual language as Input; `{ value=$bindable(""), rows=4, placeholder, disabled,
oninput, class }`. CSS from WorkingFileEditor textarea: `border-radius:8px; padding:10px 12px;
font-family:var(--font-mono); resize:vertical;` plus the Input border/focus rules.

### Select.svelte
```ts
type Opt = string | { value: string; label: string };
let { value = $bindable(""), options, disabled = false, size = "sm",
      ariaLabel, onchange, class: cls = "" } : {
  value?: string; options: Opt[]; disabled?: boolean; size?: "sm"|"md";
  ariaLabel?: string; onchange?: (e: Event) => void; class?: string;
} = $props();
```
- Normalize `options` to `{value,label}` (string → `{value:s,label:s}`).
- CSS (from `.sel`): `border:1px solid var(--border); border-radius:6px; background:var(--surface-2);
  color:var(--text-dim); font-family:inherit;` size sm `font-size:11px; padding:3px 6px;`
  size md `font-size:12.5px; padding:5px 8px;` focus → `border-color:var(--border-glow); outline:none;`

### Checkbox.svelte
```ts
let { checked = $bindable(false), disabled = false, onchange, label, children } : {
  checked?: boolean; disabled?: boolean; onchange?: (e: Event) => void;
  label?: string; children?: Snippet;
} = $props();
```
- Renders `<label class="check"><input type="checkbox" bind:checked {disabled} {onchange}/>
  <span>{label or @render children}</span></label>` (from `.check`: inline-flex; gap:6px;
  cursor:pointer; font-size:12.5px). Native checkbox kept (it already respects color-scheme:dark).

### Field.svelte
Label + control wrapper (the `.meta-field` / `.meta-targets` pattern).
```ts
let { label, hint, error, for: htmlFor, children } : {
  label?: string; hint?: string; error?: string; for?: string; children?: Snippet;
} = $props();
```
- `<div class="field"><label class="field-label" for={htmlFor}>{label}</label>{@render children()}
  {#if hint}<p class="field-hint">…</p>{/if}{#if error}<p class="field-error" role="alert">…</p>{/if}</div>`
- label `font-size:11px; color:var(--text-dim)`; hint `font-size:11px; color:var(--text-subtle)`;
  error `font-size:11.5px; color:var(--amber)` (+ the text carries meaning — CVD).

## 4. Display primitives (Agent P1b owns these files + app.css + hex fixes)

### Callout.svelte  (replaces the `.note` messagebox ×7 and inline error/confirm boxes)
```ts
type CalloutTone = "neutral" | "info" | "warn";
let { tone = "neutral", icon, title, role, children } : {
  tone?: CalloutTone; icon?: string; title?: string;
  role?: string;       // e.g. "alert" | "status" — pass through when used for errors
  children?: Snippet;
} = $props();
```
- neutral → `border:1px solid var(--border); background:var(--surface); color:var(--text-dim);`
  info → cyan-tinted (`color-mix(... var(--cyan) ...)`); warn → amber-tinted (NOT red).
  `padding:12px 14px; border-radius:10px; font-size:12.5px;` title `font-weight:600; color:var(--text)`.

### MetricBar.svelte  (replaces `.bar` ×8, incl. stacked token-mix bars)
```ts
type Seg = { value: number; color: string; label?: string };
let { value, max = 1, color = "var(--accent-from)", segments, height = 6,
      track = "var(--surface-2)", ariaLabel } : {
  value?: number; max?: number; color?: string;
  segments?: Seg[];        // if present → stacked bar; widths = value/sum
  height?: number; track?: string; ariaLabel?: string;
} = $props();
```
- Single: one fill `width:clamp(0,value/max,1)*100%`. Stacked: flex of segment widths.
- `color`/segment colors accept token `var(--tok-*)` strings — callers pass tokens, never hex.
  Add `role="img"` + `aria-label` for the quantitative meaning. Rounded ends, `overflow:hidden`.

### Stat.svelte  (replaces `.stat`+`.big`+`.lbl` figure cluster ×6–9)
```ts
let { label, value, sub, big = false, mono = true, tone } : {
  label?: string; value: string | number; sub?: string; big?: boolean;
  mono?: boolean; tone?: "default" | "accent" | "cyan" | "amber";
} = $props();
```
- column: label (`.u-label`) on top, value below (`.u-big` when `big`, else 15px/600, mono via
  `font-variant-numeric:tabular-nums`), optional `sub` (`.u-sub`). tone colors the value only.

### Badge.svelte  (EXISTS — two changes)
1. Replace hardcoded `#ffd9b3` in `.accent` with the new `--accent-ink` token (§6).
2. Document: the old hand-rolled `.pill` (×4) migrates to `<Badge>` — do not make a Pill primitive.

## 5. Typography / utility CSS layer (Agent P1b adds to app.css)

Add a clearly-commented "Design-system utilities" block. GLOBAL classes (mirrors existing
global `.kicker` / `.mono`). Migrations delete the per-component duplicate definitions and use these:

```css
.u-muted   { color: var(--text-subtle); font-size: 13px; }     /* .muted ×23 */
.u-dim     { color: var(--text-dim); }                          /* .dim ×17 */
.u-subtle  { color: var(--text-subtle); }
.u-big     { font-size: 22px; font-weight: 650; color: var(--text); line-height: 1.05; }  /* .big ×9 */
.u-sub     { font-size: 11.5px; color: var(--text-subtle); }    /* .sub ×7 */
.u-label   { font-size: 11px; color: var(--text-dim); }         /* .lbl ×3 */
.u-mono    { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }  /* alias of .mono */
```
Keep existing global `.mono` and `.kicker`. Do not rename them.

> A utility class is correct for pure text styling (low churn over 23+17+9+7 sites).
> Do NOT introduce a `<Text>` component — wrapping every `<p>`/`<span>` is un-idiomatic here.

## 6. Raw-hex elimination (Agent P1b)

Zero raw hex allowed in `<style>` blocks (the gate enforces this). Add these semantic tokens
to `:root` in app.css and reference them:

```css
--accent-ink:      #ffe0c2;  /* light text/ink on accent fills (Badge.accent, Button.primary) */
--surface-floating:#07070c;  /* near-black floating surfaces (Tooltip bg/arrow) */
--on-light-seg:    #1a1208;  /* text on a LIGHT colored segment (AgentCard, etc.) */
--on-dark-seg:     #eef3f8;  /* text on a DARK colored segment */
```
Then fix: Badge `#ffd9b3`→`var(--accent-ink)`; Tooltip `#07070c`×2→`var(--surface-floating)`;
Nav `#fff`→`var(--text)` (verify it's not intentionally pure-white on accent; if it is, keep as
`var(--text)` which is near-white #e8e8f0 — acceptable); AgentCard `#1a1208`/`#eef3f8`→the seg
tokens; BootstrapWizard `#06121b` / GitSyncPanel `#08120c` → `var(--surface-floating)` (or a local
tinted token if they need the green/blue tint — if so add `--surface-sunken` and document).
**Exempt from the gate:** data-driven hex in `<script>` (e.g. BurnPanel `RAMP[]`) — the gate
only scans `<style>` blocks, so leave those.

## 7. Enforcement gate (Agent P3 — `ui/scripts/check-design-system.ts`, Bun)

A Bun/TS script, exit non-zero on any violation, wired into `package.json` and CI:
1. **Raw hex in `<style>`:** for every `ui/src/**/*.svelte`, extract `<style>…</style>` and flag
   `#[0-9a-fA-F]{3,8}` matches. EXEMPT files in `ui/src/lib/components/ui/` ONLY for token
   *definitions* — better: exempt nothing; after §6 there should be zero. Allow `#` inside
   comments? No — just forbid all. Print `file:line` for each.
2. **Bare native controls outside the library:** flag `<button`, `<input`, `<select`,
   `<textarea` opening tags in any `.svelte` NOT under `ui/src/lib/components/ui/`. Print
   `file:line` and the suggested primitive. (`<label>`, `<fieldset>`, `<form>`, `<a>` are allowed.)
3. Wire-up: add `"check:ds": "bun run ui/scripts/check-design-system.ts"` to root `package.json`,
   include it in the root `check` script, and add a step to the GitHub Actions workflow.
   After full migration the gate MUST pass with zero violations (that is the migration's done-bar).

## 8. Migration rules (Agents P2.x)

- Replace hand-rolled `<button class="act …">…</button>` → `<Button variant=… size=…>…</Button>`,
  mapping `.primary`→`primary`, `.ghost`→`ghost`, `.danger`→`danger`, else `default`. Preserve
  `disabled`, `onclick`, `type`, and the exact text/label. Icon-only → `<IconButton label=…>`.
- `<input type=text…>` → `<Input bind:value …>`; `<input type=checkbox…>` → `<Checkbox bind:checked…>`;
  `<select>` → `<Select bind:value options=…>`; `<textarea>` → `<Textarea bind:value…>`. Preserve
  `bind:` targets, `disabled`, and handlers so tests stay green.
- Wrap label+control pairs in `<Field label hint>` where it maps cleanly (don't force it).
- Delete the now-dead local CSS (`.act*`, input/select/checkbox styles, `.muted/.dim/.big/.sub/.lbl`,
  `.note`, `.pill`, `.bar`) and switch to utilities/primitives. Keep layout-only classes that aren't
  in the library's scope.
- Replace `.note` boxes → `<Callout tone>`; `.bar` → `<MetricBar>`; `.pill` → `<Badge>`;
  stat clusters → `<Stat>` where it maps cleanly.
- Standardize the 15 hand-rolled loading/empty/error blocks onto `<EmptyState>` where they are a
  panel's empty/error state (keep inline "Loading…" only where a skeleton/short text is genuinely
  better; prefer the existing pattern the panel already uses for its data state).
- After EACH file: `cd ui && bun run check` (svelte-check) for that area, and run the file's test if
  one exists. Do not leave a file half-migrated.

## 9. Per-file ownership (no two agents touch the same file)

- **P1a:** Button, IconButton, Input, Textarea, Select, Checkbox, Field (+ their tests).
- **P1b:** app.css (utilities + tokens), Callout, MetricBar, Stat, Badge (hex), Tooltip (hex),
  index.ts barrel. (P1b owns app.css exclusively.)
- **P2-forms:** components/ MetadataForm, WorkingFileEditor, BootstrapWizard, GitSyncPanel,
  ConflictResolver, ConflictRow, ReconcileView, TargetOverlayPane (+ keep their tests green).
- **P2-metrics:** panels/ BurnPanel, TokenUsagePanel, OutcomesPanel, HookActivityPanel, KpiRow,
  ProductivityPanel, SavingsPanel, CachePanel, PressurePanel, ContextHealthPanel, EditAcceptancePanel.
- **P2-sessions:** panels/ SessionsTablePanel, ContentSearchPanel, SkillsRegistryPanel, FirehosePanel,
  SessionFeed, SessionMessages, SessionErrors, LiveSessionsPanel, LiveSessionRow, FailuresPanel,
  PatternsPanel, OutcomesPanel?(no—metrics), DayOutputStrip, GitOutcomeStrip, McpPanel, McpSchemaPanel,
  ToolLatencyPanel, TopSkillsPanel, SkillEconomicsPanel, ProjectBreakdownPanel, AgentCard,
  AgentFanoutPanel, DrillSheet.
- **P2-layout:** layout/ AppShell, Nav, CommandPalette, SystemHealthStrip; ui/ EmptyState (retry→Button),
  Sheet (close→IconButton), InfoModal (info→IconButton). NOTE: editing ui/ files means the gate must
  still pass — these are allowed native controls, but prefer the primitive where it doesn't recurse.

(Exact panel split is finalized at dispatch from the live file list; the rule is disjoint ownership.)

## 10. Done-bar (the whole refactor)

- `cd ui && bun run check` (svelte-check) clean; `cd ui && bun run test` all green.
- root `bun run check` green INCLUDING the new `check:ds` gate → **zero** bypass violations.
- `bun run build` succeeds. App runs; browser QA (clicks + ⌘K + a form save flow) shows no
  visual/behavioral regression vs. baseline screenshots.
- Design-system review skill added; review pass clean (or findings fixed).
