// The backend half of the one-click "Import existing installs" migration
// (ADR-0008): copy the standalone Prompt Library app's `installs.json` into the
// dashboard-owned `DATA_DIR/installs.json` so the dashboard becomes the sole
// installer with the user's existing install state intact.
//
// This is a thin, testable seam over the bridge `import_installs` command. The
// bridge does the guarded work (idempotent — refuses to clobber a non-empty
// dest; format_version-locked; load→validate→re-serialize, NOT a byte copy;
// source left untouched — see cmd_import_installs / D6/D9). We surface its
// BridgeResult verbatim; the route layer maps the codes (installs_already_present
// → 409, installs_format_mismatch → 422) to HTTP. The source path is a constant
// here, not config — it is a one-time, app-specific location, overridable only
// for tests.

import { homedir } from "node:os";
import { join } from "node:path";
import { runBridge, type BridgeResult } from "./library_bridge.ts";
import type { LibraryConfig } from "./library_config.ts";
import { parseImportResult, type ImportResult } from "./library_models.ts";

type Run = typeof runBridge;

/**
 * The standalone macOS app's install ledger. Left UNTOUCHED by import (still
 * used for authoring) — the dashboard copies it. The anti-divergence posture is
 * behavioral (install via the dashboard only); nothing locks the standalone app
 * out (ADR-0008).
 */
export const STANDALONE_INSTALLS_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "com.sknutti.promptlibrary",
  "installs.json",
);

/**
 * Run the one-time import. `run` and `sourcePath` are injectable so the seam is
 * unit-tested with no subprocess and no real Application Support file. Returns
 * the bridge's BridgeResult<ImportResult> — `installs_already_present` /
 * `installs_format_mismatch` / `installs_destination_corrupt` arrive as typed
 * application-error codes the route layer maps to status.
 */
export async function importInstalls(
  config: LibraryConfig,
  run: Run = runBridge,
  sourcePath: string = STANDALONE_INSTALLS_PATH,
): Promise<BridgeResult<ImportResult>> {
  return run(
    config.bridgePath,
    "import_installs",
    { source_path: sourcePath, installs_path: config.installsPath },
    { validate: parseImportResult },
  );
}
