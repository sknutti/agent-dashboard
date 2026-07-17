// `.factory/harness/prepare.ts` — the repo-owned cold-clone preparation behind the
// factory's opaque `prepare` interface (`.factory/binding.json`).
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
function run(label: string, argv: string[], cwd: string): void {
  console.log(`  ${C.dim}→ ${label}: ${argv.join(" ")} (${cwd})${C.reset}`);
  const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
  if (r.error) die(`could not spawn \`${argv[0]}\` (${r.error.message}) — is the tool provisioned?`);
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
