// `.factory/harness/prepare.ts` — cold-clone preparation for HUMANS and CI.
//
// ⚠️ THE FACTORY NO LONGER RUNS THIS FILE, and must not be pointed back at it.
// `.factory/binding.json`'s `prepare` is now `/bin/sh -c '<the two installs>'`. This is not a
// style preference — it is the only shape that works:
//
//   A bun process under the factory's sandbox has an EMPTY `process.env`, and both `Bun.spawn`
//   and `node:child_process` default to `env: process.env`. So everything a bun script spawns
//   inherits an empty environment and loses nono's `http_proxy` — the installs below then fail
//   with `ConnectionRefused downloading tarball`, which reads like a network outage and is not
//   one. Measured 2026-08-03 (bun 1.3.6 / nono 0.71.0) against a real cold worktree: this file
//   as the binding fails; the same two installs under `/bin/sh -c` succeed, 127 packages, exit 0.
//   `resolveArgv`'s `process.execPath` rewrite below fixed the same root cause for `PATH` only —
//   it cannot help the proxy, because that is read by the install child, not by this script.
//
// A harness cannot work around this from the inside: anything it spawns — including
// `/usr/bin/env` or `/bin/sh` — inherits the same empty environment. The bun process has to be
// out of the ancestry of the install, which only the binding can do.
//
// Running it yourself (`bun run .factory/harness/prepare.ts`) is unaffected and still the
// friendlier path: it keeps the fix-instruction failure messages and the lockfile-drift
// assertion, neither of which the binding's sh command has. Note the drift assertion has ALWAYS
// been inert under the factory anyway — `git` finds no repository inside the sandbox, so it took
// the "inconclusive" branch on every factory run; `--frozen-lockfile` is the real guarantee.
//
// Original rationale for a script rather than a bare `bun install`, still true:
//
// Why a script and not a bare `bun install`: command-centre is NOT a Bun workspace
// (no `workspaces` field; two lockfiles — `bun.lock` + `ui/bun.lock`), and the verify
// gate (`bun run check`) `cd`s into `ui/` to run svelte-check + vitest, which need
// `ui/node_modules`. A single root install leaves `ui/` uninstalled and the cold-clone
// gate fails. The "how many installs" fact is a per-repo detail that stays behind this
// binding interface; the engine sees one opaque argv command.
//
// Scope (frozen by ticket 017's cold-worktree probe — verdict: NO gate path loads the
// compiled Rust bridge): root + `ui/` frozen installs only. **No `cargo build`.** The
// bridge is a subprocess binary invoked over JSON stdin/stdout, not an in-process
// native/napi/wasm import, so nothing `tsc`/test loads links it. `prepare_read_hosts`
// stays `["registry.npmjs.org"]` (pinned in `.npmrc`); prepare carries no publish
// credentials. If the bridge ever moves into the gate, add its pinned build here and
// re-run the cold probe.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArgv } from "./resolve-argv.ts";

// Derive the repo root from this file's own location (`<root>/.factory/harness/`) so
// preparation is correct regardless of the invoking cwd.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCKFILES = ["bun.lock", "ui/bun.lock"] as const;

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m" };
const ok = `${C.green}✓${C.reset}`;
const bad = `${C.red}✗${C.reset}`;

function die(fix: string): never {
  console.error(`\n  ${bad} prepare failed — ${fix}\n`);
  process.exit(1);
}

// Run an argv (never a shell string) with inherited stdio; die with a fix instruction
// on any non-zero exit or spawn error.
// `argv` is typed non-empty so `program` is a `string` rather than `string | undefined`. Every
// call site already passes a literal with a program in it; this states that in the type instead of
// leaving it as an assumption the checker has to be told to ignore.
//
// `resolveArgv` rewrites a leading bare `bun` to the absolute `process.execPath`. Under the factory
// this is not an optimisation — a bare name CANNOT resolve there, because the child's environment
// (and therefore `PATH`) is empty; see `resolve-argv.ts`. Without it a cold worktree dies at
// `Executable not found in $PATH: "bun"` before installing a single dependency, which is exactly
// what the factory does on every run.
function run(label: string, argv: [string, ...string[]], cwd: string): void {
  console.log(`  ${C.dim}→ ${label}: ${argv.join(" ")} (${cwd})${C.reset}`);
  const [program, ...args] = resolveArgv(argv) as [string, ...string[]];
  const r = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (r.error) die(`could not spawn \`${program}\` (${r.error.message}) — is the tool provisioned?`);
  if (r.status !== 0) {
    die(
      `\`${argv.join(" ")}\` exited ${r.status ?? `signal ${r.signal}`}. ` +
        `A frozen install fails when the lockfile is out of date — run \`bun install\` and commit the lockfile.`,
    );
  }
  console.log(`  ${ok} ${label}`);
}

// ── Two-step frozen install ──────────────────────────────────────────────────
run("root deps", ["bun", "install", "--frozen-lockfile"], ROOT);
run("ui deps", ["bun", "install", "--frozen-lockfile"], resolve(ROOT, "ui"));

// ── Lockfile-drift assertion ──────────────────────────────────────────────────
// `--frozen-lockfile` already refuses to rewrite a stale lockfile (it errors above),
// but assert explicitly that preparation left the lockfiles byte-identical to HEAD —
// a frozen prepare must never mutate committed dependency state. Best-effort: if git
// is unavailable the frozen flag remains the guarantee.
const diff = spawnSync("git", ["diff", "--quiet", "--", ...LOCKFILES], { cwd: ROOT, stdio: "ignore" });
if (diff.error) {
  console.log(`  ${C.dim}▲ lockfile-drift check skipped (git unavailable) — --frozen-lockfile still enforced${C.reset}`);
} else if (diff.status === 1) {
  die(`lockfile drift after install (${LOCKFILES.join(", ")}). Preparation must not mutate committed deps — investigate.`);
} else if (diff.status !== 0) {
  console.log(`  ${C.dim}▲ lockfile-drift check inconclusive (git exit ${diff.status}) — --frozen-lockfile still enforced${C.reset}`);
} else {
  console.log(`  ${ok} lockfiles unchanged`);
}

console.log(`\n  ${C.green}✓ prepared${C.reset} ${C.dim}(root + ui, frozen; no bridge build)${C.reset}\n`);
