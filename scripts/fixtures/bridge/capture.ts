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

console.log("done.");
