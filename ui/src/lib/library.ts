// Pure derivation helpers for the Library route — grouping, filtering, selection
// keys, and colorblind-safe status cues. No runes here; the reactive data layer
// (resource() calls) lives in Library.svelte. Keeping these pure makes the
// list/filter/cue logic unit-testable without rendering a component.

import type { LibraryKind, LibraryPrimitiveSummary, LibraryStatus } from "./api";

/** All four Kinds, shown equally (ADR-0007 — no Kind is privileged). */
export const KIND_ORDER: LibraryKind[] = ["skill", "agent", "command", "codex_agent"];

export const KIND_LABELS: Record<LibraryKind, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  codex_agent: "Codex Agents",
};

export interface KindGroup {
  kind: LibraryKind;
  label: string;
  items: LibraryPrimitiveSummary[];
}

/** Case-insensitive substring filter on the primitive name. Empty/blank query
 *  returns everything. */
export function filterPrimitives(
  items: LibraryPrimitiveSummary[],
  query: string,
): LibraryPrimitiveSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((p) => p.name.toLowerCase().includes(q));
}

/** Group primitives by Kind in canonical order, dropping empty groups so the
 *  explorer never renders a blank Kind header. */
export function groupByKind(items: LibraryPrimitiveSummary[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: items.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** Stable selection key. Names can't contain "/" (PrimitiveName rejects it), so
 *  splitting on the first "/" round-trips safely. */
export function selectionKey(kind: LibraryKind, name: string): string {
  return `${kind}/${name}`;
}

export function parseSelection(key: string): { kind: LibraryKind; name: string } | null {
  const i = key.indexOf("/");
  if (i < 0) return null;
  const kind = key.slice(0, i) as LibraryKind;
  const name = key.slice(i + 1);
  if (!KIND_ORDER.includes(kind) || !name) return null;
  return { kind, name };
}

/** A status cue that never relies on color alone (Scott is red/green
 *  colorblind): every state pairs a text label + glyph, and tones avoid a bare
 *  red/green contrast. */
export interface Cue {
  label: string;
  tone: "amber" | "cyan" | "default";
  glyph: string;
}

/** The `dirty` flag = working copy differs from the pinned version. */
export function dirtyCue(dirty: boolean): Cue {
  return dirty
    ? { label: "modified", tone: "amber", glyph: "●" }
    : { label: "pinned", tone: "default", glyph: "○" };
}

/** A words-only git summary for the status rail (no color-coded dots). Nulls are
 *  indeterminate — never asserted as "clean"/"all pushed". */
export function gitSummary(s: LibraryStatus): string {
  if (!s.is_git_repo) return "not a git repo";
  const parts: string[] = [s.branch ?? "(detached)"];
  if (s.dirty === true) parts.push("uncommitted changes");
  else if (s.dirty === false) parts.push("clean");
  if (s.unpushed === true) parts.push("unpushed commits");
  return parts.join(" · ");
}
