// Regenerate the committed bridge fixtures from the REAL prompt-library-bridge
// binary run against a freshly seeded fixture Library. The dashboard unit tests
// parse these committed JSON files (no spawned Rust); this script is the only
// place Rust is invoked, so the fixtures can never silently drift from the
// prototype's imagined shapes — they are genuine serde output.
//
//   bun run scripts/fixtures/bridge/capture.ts
//
// It (1) builds the release bridge + seeds a temp Library via the crate's
// `seed_fixture_library` example, (2) runs each read command, and (3) writes
// pretty-printed envelopes here. Absolute paths in error `detail` are
// normalized to <LIBRARY_PATH> so the fixtures are machine-stable.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../paths.ts";

const HERE = join(PROJECT_ROOT, "scripts", "fixtures", "bridge");
const BIN = join(PROJECT_ROOT, "target", "release", "prompt-library-bridge");

function sh(cmd: string[], opts: { cwd?: string } = {}): void {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? PROJECT_ROOT, stderr: "inherit", stdout: "inherit" });
  if (p.exitCode !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}

async function runBridge(request: object): Promise<string> {
  const proc = Bun.spawn([BIN], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(request));
  proc.stdin.end();
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

async function capture(name: string, request: object, libPath?: string): Promise<void> {
  const raw = await runBridge(request);
  let parsed = JSON.parse(raw);
  if (libPath) {
    // Normalize the machine-specific temp path so error `detail` is stable.
    parsed = JSON.parse(JSON.stringify(parsed).replaceAll(libPath, "<LIBRARY_PATH>"));
  }
  await Bun.write(join(HERE, `${name}.json`), JSON.stringify(parsed, null, 2) + "\n");
  console.log(`wrote ${name}.json`);
}

const lib = join(mkdtempSync(join(tmpdir(), "lib-fixture-")), "lib");

console.log("building release bridge…");
sh(["cargo", "build", "-q", "-p", "prompt-library-bridge", "--release"]);
console.log(`seeding fixture library at ${lib}…`);
sh(["cargo", "run", "-q", "-p", "prompt-library-bridge", "--example", "seed_fixture_library", "--", lib]);

await capture("kind_info", { v: 1, command: "kind_info" });
await capture("target_info", { v: 1, command: "target_info" });
await capture("list_primitives", { v: 1, command: "list_primitives", args: { path: lib } });
await capture("primitive_detail_skill", {
  v: 1, command: "primitive_detail", args: { path: lib, kind: "skill", name: "diagnose" },
});
await capture("primitive_detail_codex_agent", {
  v: 1, command: "primitive_detail", args: { path: lib, kind: "codex_agent", name: "code-gen" },
});
await capture("library_status_valid", { v: 1, command: "library_status", args: { path: lib } });
// An application-error envelope (marker missing) — a real, readable dir that is
// not a Library. Captured so the error-mapping test runs against genuine output.
const notLib = mkdtempSync(join(tmpdir(), "not-a-lib-"));
await capture("error_marker_missing", { v: 1, command: "list_primitives", args: { path: notLib } }, notLib);

// --- write-side fixtures (install / uninstall / scan_drift / list_installs) ---
// A SEPARATE lib seeded with `publish` so `diagnose` is installable, plus a temp
// install home + a temp installs ledger. None of these envelopes' `data` carries
// an absolute path (conflicts are install-relative; version/timestamp are
// pinned), so — unlike the error fixture — they need no path normalization and
// are byte-stable as captured. The read fixtures above come from a publish-free
// seed, so adding a published version here never perturbs them.
const wlib = join(mkdtempSync(join(tmpdir(), "lib-installable-")), "lib");
console.log(`seeding installable library at ${wlib}…`);
sh(["cargo", "run", "-q", "-p", "prompt-library-bridge", "--example", "seed_fixture_library", "--", wlib, "publish"]);
const whome = mkdtempSync(join(tmpdir(), "install-home-"));
const wInstalls = join(mkdtempSync(join(tmpdir(), "install-data-")), "installs.json");
const NOW = "2026-04-30T12:00:00Z";
const wargs = { path: wlib, home: whome, installs_path: wInstalls, kind: "skill", name: "diagnose" };

// install diagnose → claude (a clean first install → `installed`)
await capture("install_summary", {
  v: 1, command: "install",
  args: { ...wargs, targets: ["claude"], force: false, installed_at: NOW },
});
// per-primitive drift right after a clean install → `clean`
await capture("scan_drift", { v: 1, command: "scan_drift", args: wargs });
// the compact per-target install projection the UI renders rows from
await capture("list_installs", { v: 1, command: "list_installs_for_primitive", args: wargs });
// uninstall diagnose ← claude on a clean install → `removed` (captured LAST so
// it doesn't disturb the scan/list fixtures above)
await capture("uninstall_summary", {
  v: 1, command: "uninstall",
  args: { ...wargs, targets: ["claude"], force: false },
});

// --- working-file fixtures (list_working_files / read_working_file) ----------
// A SEPARATE lib seeded with `working`, which plants a deterministic
// `working/base/` bundle on `diagnose`: a fixed primary, one text ref
// (`notes.md`), one binary ref (`logo.bin`, NUL-bearing). The bytes match the
// bridge's `working_fixture()` golden test exactly, so these JSON files are
// asserted from both Rust and TS. The library root rides `path`; the ref path
// rides `rel` (distinct keys — `path` is owned by `require_library`).
const wflib = join(mkdtempSync(join(tmpdir(), "lib-working-")), "lib");
console.log(`seeding working-file library at ${wflib}…`);
sh(["cargo", "run", "-q", "-p", "prompt-library-bridge", "--example", "seed_fixture_library", "--", wflib, "working"]);
const wfargs = { path: wflib, kind: "skill", name: "diagnose" };
await capture("list_working_files", { v: 1, command: "list_working_files", args: wfargs });
await capture("read_working_file_text", {
  v: 1, command: "read_working_file", args: { ...wfargs, rel: "notes.md" },
});
await capture("read_working_file_binary", {
  v: 1, command: "read_working_file", args: { ...wfargs, rel: "logo.bin" },
});

console.log("done.");
