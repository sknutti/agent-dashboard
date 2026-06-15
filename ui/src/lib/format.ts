// Display formatters. Numbers are dense by design (Linear/Vercel bar, master §22).

/** Parse an FTS5 `snippet()` string — matched terms wrapped in the server's `[ ]`
 *  delimiters — into ordered { text, hit } segments. The panel renders `hit`
 *  segments as `<mark>` and the rest as plain text, so highlighting needs no
 *  `{@html}` and no client-side tokenizer (XSS-safe; Svelte escapes the text).
 *  An unbalanced `[` degrades to plain text rather than throwing. (A literal `[`/`]`
 *  in the body could mis-split — acceptable for a snippet view; follow-up if it bites.) */
export function splitSnippet(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("[", i);
    if (open === -1) {
      out.push({ text: s.slice(i), hit: false });
      break;
    }
    const close = s.indexOf("]", open + 1);
    if (close === -1) {
      // Unbalanced — treat the remainder as plain text, never throw.
      out.push({ text: s.slice(i), hit: false });
      break;
    }
    if (open > i) out.push({ text: s.slice(i, open), hit: false });
    out.push({ text: s.slice(open + 1, close), hit: true });
    i = close + 1;
  }
  return out;
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 1 : 0) + "K";
  if (a < 1e9) return (n / 1e6).toFixed(a < 1e7 ? 1 : 0) + "M";
  return (n / 1e9).toFixed(2) + "B";
}

export function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) < 1) return "$" + n.toFixed(3);
  if (Math.abs(n) < 100) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString();
}

export function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return Math.round(n) + "ms";
  if (n < 60_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "s";
  return Math.floor(n / 60_000) + "m" + Math.round((n % 60_000) / 1000) + "s";
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x == null) return "—";
  return (x * 100).toFixed(digits) + "%";
}

/** "2m ago", "3h ago" from an ISO timestamp. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/** "2026-06-09" -> "Jun 9". */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[m - 1]} ${d}`;
}

/** Collapse the home dir to ~ — never hardcode a username (master §17). */
export function homeDir(cwd: string | null | undefined): string {
  if (!cwd) return "—";
  return cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export function projectName(cwd: string | null | undefined): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || homeDir(cwd);
}

// AGENT_NAMES moved to lib/registry.svelte.ts (review #17) — it is now hydrated
// from agents.yaml via /api/registry rather than hardcoded here.
