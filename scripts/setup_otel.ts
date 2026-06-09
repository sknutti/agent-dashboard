// Claude Code OTEL setup wizard (master §8).
//
// Turns on Claude Code telemetry pointed at this dashboard by adding SIX env keys
// to ~/.claude/settings.json. Load-bearing safety rules:
//   • BACK UP settings.json (timestamped) before writing — never destroy config.
//   • Add ONLY keys that are absent; NEVER overwrite a value the user already set.
//   • settings.json is strict JSON (no comments) — parse/stringify round-trips it.
//   • Env vars apply only to NEW sessions → tell the user to quit + reopen.
//
// Usage:
//   bun scripts/setup_otel.ts            # apply (backs up first)
//   bun scripts/setup_otel.ts --dry-run  # show the plan, write nothing
//   bun scripts/setup_otel.ts --port 8765
//   bun scripts/setup_otel.ts --revert   # remove the 6 keys we manage

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.CC_PORT ?? 8765);
})();
const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** The exact six keys (master §8). Values reference the running dashboard port. */
const OTEL_ENV: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${PORT}`,
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_LOG_TOOL_DETAILS: "1",
};

function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, any>;
  } catch (err) {
    console.error(`✗ ${SETTINGS_PATH} is not valid JSON — refusing to touch it.`);
    console.error(`  (${(err as Error).message})`);
    process.exit(1);
  }
}

function backup(): string {
  // Deterministic-ish backup name; no Date.now needed for uniqueness here, but a
  // timestamp is the friendliest. (This is a one-shot CLI, not the resumable worker.)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${SETTINGS_PATH}.bak-${stamp}`;
  copyFileSync(SETTINGS_PATH, dest);
  return dest;
}

function applyRevert(settings: Record<string, any>): { changed: string[] } {
  const env = (settings.env ?? {}) as Record<string, string>;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(OTEL_ENV)) {
    if (env[k] === v) {
      delete env[k];
      changed.push(k);
    }
  }
  settings.env = env;
  return { changed };
}

function applyAdd(settings: Record<string, any>): { added: string[]; kept: string[] } {
  const env = (settings.env ?? {}) as Record<string, string>;
  const added: string[] = [];
  const kept: string[] = [];
  for (const [k, v] of Object.entries(OTEL_ENV)) {
    if (k in env) kept.push(`${k}=${env[k]}`);
    else { env[k] = v; added.push(`${k}=${v}`); }
  }
  settings.env = env;
  return { added, kept };
}

// ── Run ─────────────────────────────────────────────────────────────────────
const settings = readSettings();

if (REVERT) {
  const { changed } = applyRevert(settings);
  if (!changed.length) {
    console.log("Nothing to revert — none of the 6 managed keys are present.");
    process.exit(0);
  }
  if (DRY_RUN) {
    console.log("[dry-run] would remove:", changed.join(", "));
    process.exit(0);
  }
  if (existsSync(SETTINGS_PATH)) console.log(`Backed up → ${backup()}`);
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log("✓ Removed:", changed.join(", "));
  console.log("→ Quit and reopen Claude Code for it to take effect.");
  process.exit(0);
}

const { added, kept } = applyAdd(settings);

if (!added.length) {
  console.log("✓ All 6 OTEL env keys already present — nothing to do.");
  if (kept.length) console.log("  Existing (left untouched):\n   " + kept.join("\n   "));
  process.exit(0);
}

console.log(`Target: ${SETTINGS_PATH}`);
console.log(`Will ADD ${added.length} key(s):\n   ` + added.join("\n   "));
if (kept.length) console.log(`Leaving ${kept.length} existing key(s) untouched:\n   ` + kept.join("\n   "));

if (DRY_RUN) {
  console.log("\n[dry-run] no file written. Re-run without --dry-run to apply.");
  process.exit(0);
}

if (existsSync(SETTINGS_PATH)) console.log(`\nBacked up → ${backup()}`);
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
console.log("✓ Wrote settings.json");
console.log("\nNext:");
console.log("  1. Quit and reopen Claude Code (env vars apply to new sessions only).");
console.log("  2. Run a prompt — events flow to the dashboard within ~30s.");
console.log(`  3. Open http://localhost:${PORT} — OTEL-backed panels light up.`);
