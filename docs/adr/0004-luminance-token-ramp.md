# Luminance-ordered token-mix ramp for colour-vision legibility

The token-mix bars (`TokenUsagePanel` daily stacks, `AgentCard` mixbar) encode their segments with a **luminance-monotonic** ramp along a fixed stack order — output (lightest) → input → reasoning → cache-write (darkest) — so a segment is decodable by *brightness*, not hue. Nominal-state charts (`OutcomesPanel`) are exempt: they keep the Okabe-Ito hue palette and instead gain a legend-highlight interaction.

## Status

accepted — supersedes the "sunset → sea" hue ramp documented in the `--tok-*` comment in `ui/src/app.css`.

## Context

The dashboard's owner is red/green colourblind, and the project's own rule is "never rely on colour alone" (honoured everywhere via `✓`/`· slow`/`· errored` text backups). The multi-segment **stacked bars** were the one place it was broken: 4–5 segments were separated by hue + a detached legend only, and two token colours were both blue (`cache-write`/`cache-read`) stacked adjacent.

The de-crush decision (cache-read removed; see [`CONTEXT.md` → Effective tokens]) leaves 4 token segments. The thin daily bars render ~30–90 narrow columns where individual segments can be 2–3px — so the usual non-colour backups (in-segment **labels**, **patterns/textures**) physically do not fit. A backup had to work at that density.

## Decision

- **Token mix → luminance ramp.** Recolour `--tok-output/-input/-reasoning/-cache-write` to step monotonically down in luminance along the fixed stack order. The bar reads as a light→dark gradient; lightness (the channel CVD vision *keeps*) carries the encoding, hue is redundant.
- **Legend highlight (brushing & linking).** Legend entries are keyboard-focusable buttons; hover/focus highlights that one category across every bar and dims the rest. This is the disambiguator for the thin bars and is the new CVD affordance, so it must be reachable by keyboard.
- **Wide bars also get direct labels.** The single wide `AgentCard` mixbar prints each segment's label + % in place — there, colour is fully redundant.
- **Nominal states keep hue.** `OutcomesPanel` categories (ok / unfinished / truncated / rate-limited / errored) are *not* an ordinal scale. A luminance ramp would imply a false ordering, so Outcomes keeps Okabe-Ito (already maximally CVD-distinct) and gains only the legend-highlight + fixed order.

## Considered and rejected

- **Patterns / textures per segment.** The textbook CVD backup, but invisible on sub-5px daily segments and visually noisy across a ~30-panel dark dashboard — it does not actually solve the thin bars.
- **In-segment labels everywhere.** Clean on the wide mixbar (kept there), but won't fit the thin daily/Outcomes columns.
- **Keep the hue ramp, do nothing.** Leaves the densest, most-glanced charts colour-only — the exact failure mode for the primary user.

## Consequences

- The "sunset → sea" aesthetic of the token bars is traded for legibility; the ramp now reads warm-light → cool-dark. Correctness over palette harmony was the explicit call.
- Luminance is a single shared channel: it works *because* the stack order is fixed, so the order must not be reordered without re-checking monotonicity.
- `--tok-cache-read` is now unused by the mix bars (cache-read lives in `CachePanel`); the token is left defined to avoid breakage.
- Future multi-segment charts should follow the split: **ordinal/quantitative → luminance ramp; nominal → CVD-distinct hues + highlight.**
