// Burn aggregation — the per-date money fold for /api/burn.
//
// Extracted from routes.ts as a PURE function so the native-cost merge (the
// dashboard's most failure-sensitive arithmetic) is unit-testable without a DB
// or HTTP. ADR-0002 invariants encoded here:
//   • estimated (rack-rate) and native cost are NEVER summed into one figure.
//   • native is null-preserving: a date with no native source stays null → "—",
//     never a fabricated "$0".
//   • Claude native is OTEL-first / JSONL-print fallback — the two describe the
//     SAME spend, so they are chosen between, never added. Every OTHER agent's
//     native (Pi's per-message cost) is a DISTINCT spend, so it adds on top.
//
// The bug this replaces: the old fold summed all agents' burn_daily.cost_usd into
// one scalar and only applied the OTEL overlay when that scalar was null — so a
// single $0.42 `claude -p` print session (or any Pi cent on the same date)
// suppressed the day's full OTEL native total.

export interface BurnRow {
  date: string;
  agent: string;
  tokens: number | null;
  /** native USD from burn_daily (Claude print-mode / Pi per-message); null otherwise. */
  cost_usd: number | null;
  /** rack-rate estimated USD; null when the day's rows are all unpriced. */
  cost_estimated_usd: number | null;
}

export interface BurnDay {
  date: string;
  tokens: number;
  estUsd: number | null;
  nativeUsd: number | null;
}

/**
 * Fold per-(date,agent) burn rows into per-date totals.
 *
 * @param rows              burn_daily rows already filtered to the range (+agent).
 * @param claudeOtelByDate  OTEL `claude_code.cost.usage` per local date. Pass an
 *                          EMPTY map when the request filters to a specific
 *                          non-Claude agent, so the Claude-only overlay can't
 *                          bleed into Codex/Pi/Antigravity figures.
 */
export function mergeBurnByDate(
  rows: BurnRow[],
  claudeOtelByDate: Map<string, number>,
): BurnDay[] {
  interface Acc {
    tokens: number;
    estUsd: number | null;
    /** Claude's print-mode native (partial) — superseded by OTEL when present. */
    claudeJsonlNative: number | null;
    /** Sum of every non-Claude agent's native (distinct spend, additive). */
    otherNative: number | null;
  }
  const acc = new Map<string, Acc>();
  const get = (date: string): Acc => {
    let d = acc.get(date);
    if (!d) {
      d = { tokens: 0, estUsd: null, claudeJsonlNative: null, otherNative: null };
      acc.set(date, d);
    }
    return d;
  };

  for (const r of rows) {
    const d = get(r.date);
    d.tokens += r.tokens ?? 0;
    if (r.cost_estimated_usd != null) d.estUsd = (d.estUsd ?? 0) + r.cost_estimated_usd;
    if (r.cost_usd != null) {
      if (r.agent === "claude_code") d.claudeJsonlNative = (d.claudeJsonlNative ?? 0) + r.cost_usd;
      else d.otherNative = (d.otherNative ?? 0) + r.cost_usd;
    }
  }
  // A date with OTEL native but no burn_daily row must still surface.
  for (const date of claudeOtelByDate.keys()) get(date);

  const out: BurnDay[] = [];
  for (const [date, d] of acc) {
    // OTEL wins over partial print-mode JSONL for Claude; the two are never summed.
    const claudeNative = claudeOtelByDate.has(date)
      ? claudeOtelByDate.get(date)!
      : d.claudeJsonlNative;
    // Claude native + the rest, null-preserving (null only if BOTH are absent).
    let nativeUsd: number | null = null;
    if (claudeNative != null) nativeUsd = (nativeUsd ?? 0) + claudeNative;
    if (d.otherNative != null) nativeUsd = (nativeUsd ?? 0) + d.otherNative;
    out.push({ date, tokens: d.tokens, estUsd: d.estUsd, nativeUsd });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
