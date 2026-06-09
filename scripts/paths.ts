// Single source of truth for filesystem locations and runtime config.
// Everything is env-overridable so install.sh can relocate the data dir
// (default ~/.command-centre) while dev runs straight out of the repo.

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

/** IANA-ish timezone name for local-time bucketing and health display. */
export function tzName(): string {
  return (
    process.env.TZ ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "local"
  );
}
