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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_DIR, DEFAULT_BRIDGE_PATH } from "./paths.ts";

export interface LibraryConfig {
  /** The chosen Library directory, or null when unconfigured. */
  libraryPath: string | null;
  /** Resolved path to the prompt-library-bridge binary (always set). */
  bridgePath: string;
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

  return { libraryPath, bridgePath };
}
