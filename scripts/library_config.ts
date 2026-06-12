// Locate the prompt-library and the bridge binary, modeled on
// `loadAgentsConfig` (agents_config.ts): YAML via the `yaml` package, NEVER
// throws — a missing or malformed file yields a safe, fail-closed default
// (`libraryPath: null` → the routes report `library_unconfigured`, the rest of
// the dashboard is untouched).
//
// Precedence (highest first): the `CC_LIBRARY_*` env override (dev convenience),
// then `config/library.yaml` (the persisted setting), then the built-in default.
// Env is read at call time (not a module-load constant) so the precedence stays
// unit-testable without mutating the host process env. Fail-closed (security
// m6): any missing file, parse error, or non-string `library_path` collapses to
// `null` — never a half-parsed or coerced path that could turn the read routes
// into a filesystem-read oracle over an arbitrary directory.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CONFIG_DIR,
  DEFAULT_BRIDGE_PATH,
  DEFAULT_INSTALLS_PATH,
  DEFAULT_LIBRARY_HOME,
  PROJECT_ROOT,
} from "./paths.ts";

export interface LibraryConfig {
  /** The chosen Library directory, or null when unconfigured. */
  libraryPath: string | null;
  /** Resolved path to the prompt-library-bridge binary (always set). */
  bridgePath: string;
  /**
   * Dashboard-owned install ledger path (always set). The bridge writes install
   * records here; the route layer injects it so an HTTP body can never redirect
   * a write (D7). Defaults to `DATA_DIR/installs.json`.
   */
  installsPath: string;
  /**
   * Install destination root (always set) — the home under which `~/.claude`,
   * `~/.pi`, `~/.codex` are written. Defaults to the user home; tests pin a temp
   * root via `CC_LIBRARY_HOME`.
   */
  home: string;
}

type Env = Record<string, string | undefined>;

/** A non-empty string, or null — anything else (number, list, "") is rejected. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function loadLibraryConfig(
  configDir: string = CONFIG_DIR,
  env: Env = process.env,
): LibraryConfig {
  let cfg: any = {};
  try {
    cfg = parseYaml(readFileSync(join(configDir, "library.yaml"), "utf8")) ?? {};
  } catch {
    cfg = {}; // missing or malformed → safe default, never throws
  }

  const libraryPath = str(env.CC_LIBRARY_PATH) ?? str(cfg?.library_path) ?? null;
  const bridgePath =
    str(env.CC_LIBRARY_BRIDGE_PATH) ?? str(cfg?.bridge_path) ?? DEFAULT_BRIDGE_PATH;
  // installsPath/home: same CC_LIBRARY_* > config > default precedence. Both are
  // always set (never null) — the install destination must resolve to *some*
  // concrete path; a non-string config value falls through to the safe default.
  const installsPath =
    str(env.CC_LIBRARY_INSTALLS_PATH) ?? str(cfg?.installs_path) ?? DEFAULT_INSTALLS_PATH;
  const home = str(env.CC_LIBRARY_HOME) ?? str(cfg?.home) ?? DEFAULT_LIBRARY_HOME;

  return { libraryPath, bridgePath, installsPath, home };
}

export interface BridgeHealth {
  status: "ok" | "warn";
  detail: string;
}

/** mtime (ms) of a path, or null if it can't be stat'd. */
function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Newest mtime (ms) of any file under `dir`, pruning build output (`target`)
 *  and dot-dirs. Returns null if the tree can't be read — staleness then fails
 *  OPEN (no false "stale" warning when we can't tell). Bounded: the crate
 *  sources are a few hundred files, walked once per doctor/startup check. */
function newestMtimeUnder(dir: string): number | null {
  let newest: number | null = null;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "target" || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        const m = mtimeMs(full);
        if (m !== null && (newest === null || m > newest)) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Doctor check for the prompt-library bridge. The bridge defaults to
 * `target/debug/prompt-library-bridge`, which only exists (and only stays
 * current) after `cargo build` — so a configured library with no bridge, OR a
 * bridge older than its crate sources, yields a cryptic runtime error
 * (`bridge_not_found`, or an `unknown_command` after new commands are added).
 * Surface BOTH as warnings here (the library is an optional feature, so it never
 * fails the run). `fileExists` + the mtime providers are injected for tests.
 */
export function checkLibraryBridge(
  config: LibraryConfig,
  fileExists: (p: string) => boolean = existsSync,
  bridgeMtimeMs: (p: string) => number | null = mtimeMs,
  newestSourceMtimeMs: () => number | null = () => newestMtimeUnder(join(PROJECT_ROOT, "crates")),
): BridgeHealth {
  if (!config.libraryPath) {
    return { status: "ok", detail: "not configured (optional)" };
  }
  if (!fileExists(config.bridgePath)) {
    return {
      status: "warn",
      detail: `library configured but bridge not built at ${config.bridgePath} — run \`bun run build:bridge\``,
    };
  }
  // Staleness: a bridge older than its crate sources is the exact trap behind a
  // runtime `unknown_command` after a pull/edit added new bridge commands. Only
  // warn when BOTH mtimes are known — otherwise fail open (no false alarm).
  const binMs = bridgeMtimeMs(config.bridgePath);
  const srcMs = newestSourceMtimeMs();
  if (binMs !== null && srcMs !== null && srcMs > binMs) {
    return {
      status: "warn",
      detail: `bridge is stale (crate sources changed since the last build) — run \`bun run build:bridge\``,
    };
  }
  return { status: "ok", detail: `bridge built · ${config.bridgePath}` };
}
