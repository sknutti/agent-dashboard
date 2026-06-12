// Single source of truth for filesystem locations and runtime config.
// Everything is env-overridable so install.sh can relocate the data dir
// (default ~/.command-centre) while dev runs straight out of the repo.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // .../scripts

/** Repo (or installed) root — the dir that holds scripts/, config/, ui/. */
export const PROJECT_ROOT =
  process.env.CC_PROJECT_ROOT ?? resolve(here, "..");

export const DATA_DIR = process.env.CC_DATA_DIR ?? join(PROJECT_ROOT, "data");
export const DB_PATH = process.env.CC_DB_PATH ?? join(DATA_DIR, "command-centre.db");
export const CONFIG_DIR = process.env.CC_CONFIG_DIR ?? join(PROJECT_ROOT, "config");
export const UI_DIST = process.env.CC_UI_DIST ?? join(PROJECT_ROOT, "ui", "dist");

export const PORT = Number(process.env.CC_PORT ?? 8765);

/**
 * Default location of the prompt-library-bridge binary (the read-model bridge
 * over the imported Rust crates). The bridge is built into the workspace
 * `target/debug/` by `cargo build`. `loadLibraryConfig()` layers an optional
 * `config/library.yaml` `bridge_path` and the `CC_LIBRARY_BRIDGE_PATH` env
 * override on top of this default. Env reads for the library live in the loader
 * (call-time) so config-vs-env precedence stays testable.
 */
export const DEFAULT_BRIDGE_PATH = join(
  PROJECT_ROOT,
  "target",
  "debug",
  "prompt-library-bridge",
);

/**
 * Default location of the dashboard-owned install ledger (`installs.json`). The
 * dashboard is the SOLE installer (ADR-0008), so this lives under `DATA_DIR`,
 * never in the standalone app's Application Support dir. Env-free here (mirrors
 * `DEFAULT_BRIDGE_PATH`); `loadLibraryConfig()` layers the optional
 * `config/library.yaml` `installs_path` and the `CC_LIBRARY_INSTALLS_PATH` env
 * override on top at call time so config-vs-env precedence stays testable.
 */
export const DEFAULT_INSTALLS_PATH = join(DATA_DIR, "installs.json");

/**
 * Default install destination root — the user's home, under which the bridge
 * writes `~/.claude/...`, `~/.pi/...`, `~/.codex/...`. Env-free default; tests
 * inject a temp root via `CC_LIBRARY_HOME` (resolved in `loadLibraryConfig()`)
 * so no test ever writes the real home.
 */
export const DEFAULT_LIBRARY_HOME = homedir();

/** IANA-ish timezone name for local-time bucketing and health display. */
export function tzName(): string {
  return (
    process.env.TZ ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "local"
  );
}
