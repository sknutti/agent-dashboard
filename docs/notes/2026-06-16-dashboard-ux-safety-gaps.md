# Dashboard UX / safety gaps — candidate fixes (2026-06-16)

Loose ends surfaced during the teach/grill-with-docs library saga. None are
blocking; logged here so they can be picked up as standalone fixes. Ordered by
severity.

## 1. "Delete primitive" force-uninstalls on-disk copies with no warning (HIGH)

Deleting a primitive in the Library UI runs a **force-uninstall of every
target + `rm -rf` of the install dirs** (`deletePrimitive` —
`ui/src/lib/api.ts`: "force-uninstall every target, rm -rf the dir, drop
records"; core in `crates/core/src/library_drift.rs` delete path). During the
saga, deleting `teach`/`grill-with-docs` from the library silently wiped
`~/.claude/skills/<name>` and `~/.codex/skills/<name>` too. The only reason no
work was lost is the library is a git repo and we recovered the on-disk content
from history (and a manual backup).

**Why it's a sharp edge:** the user's mental model is "remove it from the
library," not "uninstall it from all my agents and delete the on-disk skill."
There's no confirmation naming the install paths that will be removed.

**Proposed fix:** the delete confirmation should explicitly list the on-disk
install locations that will be removed, and/or offer a "remove from library
only (keep installed copies)" option. At minimum, surface the force-uninstall
consequence in the confirm dialog copy (CVD-safe; no red/green reliance).

## 2. Drift view doesn't show *what* drifted (MEDIUM)

When a primitive shows as drifted (e.g. in the bootstrap wizard's reimport
list, or the explorer drift cue), the UI shows only the name + a "drifted" cue
— never the changed file list or a diff. During the saga the user could see
`grill-with-docs` was drifted but had no way to tell it was `SKILL.md` (the
grill-me merge) vs the library's old copy. Drift detection already has per-file
hashes; the changed-file set is derivable.

**Proposed fix:** in the drift/reimport detail, list the changed files (added /
modified / removed) and optionally a content diff for text files. Bridge already
computes per-file hashes (`installs.json` `file_hashes`); expose the changed-rel
set so the UI can render it.

## 3. `library_bundle_invalid` swallows the reason (MEDIUM)

A folder URL import that fails the bundle caps surfaces as a generic "the
fetched bundle is invalid" with no reason. The Rust side carries a precise
reason string (e.g. *"folder is 15549511 bytes; the limit is 4194304"* —
`crates/core/src/url_import.rs` `Error::BundleInvalid { reason }`), but the UI
renders a generic message off the `library_bundle_invalid` code
(`ui/src/lib/api.ts`). The user can't tell it's a size problem, let alone which
files. (Hit while trying to import the `last30days` skill — 1.27 GB of bundled
media.)

**Proposed fix:** thread the `reason` through to the UI and render it. Same
class as the drift-help discoverability fixes already shipped.

## 4. Bootstrap wizard executes a stale plan — UI re-scan follow-up (MEDIUM)

Root-caused and largely fixed in
[`2026-06-16-bootstrap-overlay-bug.md`](2026-06-16-bootstrap-overlay-bug.md)
(PR #25 — execute re-validates the base/overlay split against current disk). One
**residual** remains: the create path still *errors* if an overlay's source is
fully **deleted** (not merely synced) between scan and execute
(`read_canonicalized_bundle` can't read a gone path). The defense-in-depth fix
is option 1 from that doc — have `BootstrapWizard.svelte` re-scan on the
review→execute path (mirroring the resume path at lines ~137-144) so a plan
never references a since-deleted source. Not required to close the three
observed overlay symptoms, but it hardens the flow.

## Already shipped this session (for context)

- Bootstrap wizard rendered off-screen at the page bottom → moved to top (#23).
- Pre-bootstrap source backup tarred ~1.27 GB of tool-home trees → scoped to
  primitive dirs, fixing `bridge_timeout` (#24).
- Case-only install-record reconciliation at bootstrap (#22).
- Reimport/create stale-plan overlay bug (#25).
