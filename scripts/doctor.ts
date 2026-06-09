// `cc doctor` — deterministic, zero-LLM health check (master §21).
// Exit 0 iff every CRITICAL check passes; non-zero otherwise. Warnings (e.g.
// launchd not loaded in dev) never fail the run.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { getDb } from "./db.ts";
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
  db.close();
  add("SQLite database", tables > 0 ? "ok" : "fail", `${DB_PATH} · ${tables} tables · ${beats} heartbeats`, true);
} catch (err) {
  add("SQLite database", "fail", String(err), true);
}

// ── UI build ─────────────────────────────────────────────────────────────────
const indexHtml = join(UI_DIST, "index.html");
add("UI build", existsSync(indexHtml) ? "ok" : "warn", existsSync(indexHtml) ? UI_DIST : "ui/dist missing — run `bun run build:ui`");

// ── Agent dirs (informational in Phase 0; pre-enable is auto-detected) ───────
try {
  const cfg = parseYaml(await Bun.file(join(CONFIG_DIR, "agents.yaml")).text()) as {
    agents: Record<string, { path: string }>;
  };
  for (const [id, a] of Object.entries(cfg.agents ?? {})) {
    const dir = expandHome(a.path);
    add(`agent: ${id}`, existsSync(dir) ? "ok" : "warn", existsSync(dir) ? `detected (${dir})` : `not present (${dir})`);
  }
} catch (err) {
  add("agents.yaml parse", "warn", String(err));
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
const mark = { ok: `${C.green}●${C.reset}`, warn: `${C.amber}●${C.reset}`, fail: `${C.red}●${C.reset}` };

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
