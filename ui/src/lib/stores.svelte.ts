// Shared reactive state (Svelte 5 runes in a .svelte.ts module).

import { getSystemHealth, type SystemHealth } from "./api";

// ── System health (polled, master §17 SystemHealthStrip) ────────────────────
export const health = $state<{
  data: SystemHealth | null;
  error: boolean;
  loading: boolean;
}>({ data: null, error: false, loading: true });

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
  /** The query this drill-down maps to in Phase 1 (shown for transparency). */
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
