// `cc doctor` — deterministic, zero-LLM health check (master §21).
// Exit 0 iff every CRITICAL check passes; non-zero otherwise. Warnings (e.g.
// launchd not loaded in dev) never fail the run.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { getDb } from "./db.ts";
import { loadAgentsConfig } from "./agents_config.ts";
import { loadLibraryConfig, checkLibraryBridge } from "./library_config.ts";
import { CONFIG_DIR, DB_PATH, PORT, PROJECT_ROOT, UI_DIST } from "./paths.ts";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  critical?: boolean;
}

const checks: Check[] = [];
function add(name: string, status: Status, detail: string, critical = false) {
  checks.push({ name, status, detail, critical });
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// ── Runtime ─────────────────────────────────────────────────────────────────
add("Bun runtime", "ok", `bun ${Bun.version}`, true);

// ── Config files ─────────────────────────────────────────────────────────────
for (const f of ["agents.yaml", "prices.yaml"]) {
  const p = join(CONFIG_DIR, f);
  add(`config/${f}`, existsSync(p) ? "ok" : "fail", existsSync(p) ? p : "missing", true);
}

// ── Database ─────────────────────────────────────────────────────────────────
let unpricedModels: string[] = [];
try {
  const db = getDb();
  const tables = (
    db
      .query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { c: number }
  ).c;
  const beats = (
    db
      .query("SELECT COUNT(*) AS c FROM activities WHERE event_type='sync_loop_heartbeat'")
      .get() as { c: number }
  ).c;
  const lastBeat = (
    db
      .query("SELECT MAX(created_at) AS at FROM activities WHERE event_type='sync_loop_heartbeat'")
      .get() as { at: string | null }
  ).at;
  // Models observed in real sessions but never priced (cost_estimated_usd NULL):
  // either a genuinely unpriced provider (e.g. Gemini, by the never-guess rule) or
  // a gap/typo in prices.yaml. Surfaced as a warning so silent under-pricing is
  // visible. Reported in the Prices section below.
  unpricedModels = (
    db
      .query(
        "SELECT DISTINCT model FROM sessions WHERE cost_estimated_usd IS NULL AND model IS NOT NULL AND total_tokens > 0 ORDER BY model",
      )
      .all() as { model: string }[]
  ).map((r) => r.model);
  db.close();
  add("SQLite database", tables > 0 ? "ok" : "fail", `${DB_PATH} · ${tables} tables · ${beats} heartbeats`, true);

  // Heartbeat AGE, not just count: a worker that died/zombied stops beating while
  // the server keeps serving stale data. Critical-fail if the newest beat is older
  // than 3 sync intervals (the worker missed multiple ticks).
  const intervalMs = Number(process.env.CC_SYNC_INTERVAL_MS ?? 120_000);
  const staleMs = intervalMs * 3;
  if (lastBeat === null) {
    add("Ingest worker", "warn", "no heartbeat yet (fresh DB or server not started)");
  } else {
    const ageMs = Date.now() - Date.parse(lastBeat);
    const ageDesc = `last tick ${Math.round(ageMs / 1000)}s ago`;
    if (Number.isFinite(ageMs) && ageMs <= staleMs) {
      add("Ingest worker", "ok", ageDesc);
    } else {
      add("Ingest worker", "fail", `${ageDesc} — stale (> ${Math.round(staleMs / 1000)}s); worker may be dead`, true);
    }
  }
} catch (err) {
  add("SQLite database", "fail", String(err), true);
}

// ── UI build ─────────────────────────────────────────────────────────────────
const indexHtml = join(UI_DIST, "index.html");
add("UI build", existsSync(indexHtml) ? "ok" : "warn", existsSync(indexHtml) ? UI_DIST : "ui/dist missing — run `bun run build:ui`");

// ── Prompt Library bridge (ADR-0007) ─────────────────────────────────────────
// A configured library with no built bridge binary is the exact setup that
// surfaces as a cryptic runtime `bridge_not_found`; flag it here instead.
const libBridge = checkLibraryBridge(loadLibraryConfig());
add("library bridge", libBridge.status, libBridge.detail);

// ── Agent dirs (informational in Phase 0; pre-enable is auto-detected) ───────
// Same agents_config.ts loader the orchestrator and routes use (review #17), so
// doctor reflects the exact registry the rest of the app sees.
const agents = loadAgentsConfig();
if (agents.length === 0) {
  add("agents.yaml parse", "warn", "no agents declared (or file unparseable)");
}
for (const a of agents) {
  const dir = a.path ? expandHome(a.path) : "";
  if (!dir || !existsSync(dir)) {
    add(`agent: ${a.id}`, "warn", `not present (${dir || "no path configured"})`);
    continue;
  }
  // Count session files via the configured glob so detection reflects real data.
  let files = 0;
  try {
    const g = new Bun.Glob(a.glob ?? "**/*.jsonl");
    for (const _ of g.scanSync({ cwd: dir, onlyFiles: true })) files += 1;
  } catch {
    /* unreadable dir → report detected with no count */
  }
  add(`agent: ${a.id}`, "ok", `detected (${dir}) · ${files} session file${files === 1 ? "" : "s"}`);
}

// ── Prices (staleness + observed-but-unpriced models) ────────────────────────
// The rack-rate table drifts; a stale rate silently skews every estimate. doctor
// only ever checked the file EXISTS — now it parses last_updated and warns past a
// 30-day threshold, and lists models seen in real data with no price.
try {
  const prices = parseYaml(await Bun.file(join(CONFIG_DIR, "prices.yaml")).text()) as {
    last_updated?: string | Date;
  };
  const raw = prices.last_updated;
  const updatedMs = raw instanceof Date ? raw.getTime() : raw ? Date.parse(String(raw)) : NaN;
  if (!Number.isFinite(updatedMs)) {
    add("prices freshness", "warn", "no parseable last_updated: in prices.yaml");
  } else {
    const ageDays = Math.floor((Date.now() - updatedMs) / 86_400_000);
    const when = new Date(updatedMs).toISOString().slice(0, 10);
    add(
      "prices freshness",
      ageDays > 30 ? "warn" : "ok",
      `last_updated ${when} (${ageDays}d ago)${ageDays > 30 ? " — refresh rack rates" : ""}`,
    );
  }
} catch (err) {
  add("prices freshness", "warn", `prices.yaml unparseable: ${err}`);
}
if (unpricedModels.length > 0) {
  add(
    "unpriced models",
    "warn",
    `${unpricedModels.length} observed model${unpricedModels.length > 1 ? "s" : ""} with no rack rate: ${unpricedModels.join(", ")}`,
  );
}

// ── Server reachability + health ─────────────────────────────────────────────
const base = `http://127.0.0.1:${PORT}`;
try {
  const res = await fetch(`${base}/api/system/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (res.ok) {
    const h = (await res.json()) as { uptime_s: number; tz: string };
    add("Server health", "ok", `${base} · up ${h.uptime_s}s · tz ${h.tz}`, true);
  } else {
    add("Server health", "fail", `${base} -> ${res.status}`, true);
  }
} catch {
  add("Server health", "fail", `${base} unreachable — is it running? (cc start)`, true);
}

// ── launchd (warn-only: dev runs without it) ─────────────────────────────────
const LABEL = "com.commandcentre.server";
try {
  const uid = process.getuid?.() ?? 0;
  const proc = Bun.spawnSync(["launchctl", "print", `gui/${uid}/${LABEL}`]);
  add(
    "launchd service",
    proc.exitCode === 0 ? "ok" : "warn",
    proc.exitCode === 0 ? `${LABEL} loaded` : `${LABEL} not loaded (ok in dev)`,
  );
} catch {
  add("launchd service", "warn", "launchctl unavailable");
}

// ── Report ───────────────────────────────────────────────────────────────────
const C = { reset: "\x1b[0m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m" };
// Distinct GLYPHS per status, not color alone: red●/green● is the classic
// red/green-CVD confusable pair, so ✓ / ▲ / ✗ carry the signal without relying
// on hue (the color stays as a redundant cue).
const mark = { ok: `${C.green}✓${C.reset}`, warn: `${C.amber}▲${C.reset}`, fail: `${C.red}✗${C.reset}` };

console.log(`\n  ${C.dim}Command Centre · doctor${C.reset}  ${C.dim}(${PROJECT_ROOT})${C.reset}\n`);
const pad = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`  ${mark[c.status]} ${c.name.padEnd(pad)}  ${C.dim}${c.detail}${C.reset}`);
}

const failures = checks.filter((c) => c.status === "fail" && c.critical);
const warns = checks.filter((c) => c.status === "warn").length;
console.log("");
if (failures.length === 0) {
  console.log(`  ${C.green}✓ healthy${C.reset}${warns ? `  ${C.dim}(${warns} warning${warns > 1 ? "s" : ""})${C.reset}` : ""}\n`);
  process.exit(0);
} else {
  console.log(`  ${C.red}✗ ${failures.length} critical check${failures.length > 1 ? "s" : ""} failed${C.reset}\n`);
  process.exit(1);
}
