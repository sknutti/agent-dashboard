// Shared reactive state (Svelte 5 runes in a .svelte.ts module).

import { getSystemHealth, type SystemHealth, type Range } from "./api";

// ── Global range toggle (today / 7d / 30d), master §16 ──────────────────────
export const ui = $state<{ range: Range }>({ range: "7d" });
export function setRange(r: Range): void {
  ui.range = r;
}

// ── System health (polled, master §17 SystemHealthStrip) ────────────────────
export const health = $state<{
  data: SystemHealth | null;
  error: boolean;
  loading: boolean;
}>({ data: null, error: false, loading: true });

// Monotonic data epoch, bumped on every health poll. resource() reads it, so a
// single increment refetches EVERY mounted panel — without it, panels only ever
// loaded once at mount (KpiRow was keyed on a constant and showed mount-time data
// forever while the health strip ticked green). This piggybacks the 30s poll.
export const dataEpoch = $state<{ value: number }>({ value: 0 });

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Start polling /api/system/health. Returns a stop fn. Idempotent. */
export function startHealthPolling(intervalMs = 30_000): () => void {
  async function poll() {
    try {
      health.data = await getSystemHealth();
      health.error = false;
    } catch {
      health.error = true;
    } finally {
      health.loading = false;
      dataEpoch.value += 1; // fan out a background refresh to every panel
    }
  }
  void poll();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void poll(), intervalMs);
  return () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
}

// ── Drill-down detail (ADR-0003: first-class read-only drill-down plumbing) ──
// A clickable card cell opens a Sheet describing the filter it WOULD apply.
// Phase 0 renders an empty "wired, no data yet" state; Phase 1 fills the body
// from GET /api/sessions?... without changing this contract.
export interface DrillContext {
  title: string;
  /** Human description of the filter, e.g. "Claude Code · errored sessions". */
  subtitle?: string;
  /** Filters the drill-down session list resolves to (read-only; Phase 6 adds act). */
  agent?: string;
  outcome?: string;
  /** Overrides the global range toggle for this drill (e.g. the KPI "errors
   *  today" tile forces "today" so the sheet matches the tile's count instead
   *  of the page range). Falls back to the global range when unset. */
  range?: Range;
  /** The query this maps to, shown for transparency. */
  query?: string;
}

export const drill = $state<{ open: boolean; ctx: DrillContext | null }>({
  open: false,
  ctx: null,
});

export function openDrill(ctx: DrillContext): void {
  drill.ctx = ctx;
  drill.open = true;
}
export function closeDrill(): void {
  drill.open = false;
}

// ── Command palette (⌘K) open state ─────────────────────────────────────────
export const palette = $state<{ open: boolean }>({ open: false });
