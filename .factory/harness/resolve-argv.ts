// `.factory/harness/resolve-argv.ts` — exec a declared tool by a path the sandbox can actually use.
//
// Shared by `verify.ts` (sub-gate spawns) and `prepare.ts` (the frozen installs). It lives in its
// own module because `prepare.ts` needs it and must not import `verify.ts`, which would drag in the
// whole sub-gate manifest and a `import.meta.main` entry point for a one-line helper.

/**
 * Resolve `argv[0]` to something the sandbox can actually exec.
 *
 * Under the factory this repo's harnesses run inside a Seatbelt profile that grants read on the
 * PINNED tool binaries and nothing else, and — the root cause, isolated by the engine's Slice 10
 * `U14` — **a `bun` child under that profile starts with a completely empty environment whenever
 * its cwd is under the user's home tree**, which is where every factory worktree lives. An empty
 * environment means an empty `PATH`, so resolving the bare name `"bun"` cannot work at all: the
 * result is `Executable not found in $PATH: "bun"`, exit 127, on every spawn at once.
 *
 * (The engine measured this directly: in the same sandbox, `/usr/bin/env`, `/bin/sh` and `node` all
 * see the full environment; only `bun` sees zero keys, and it passes that emptiness on to its own
 * children — which is why a harness spawning by name fails even though the harness itself ran.)
 *
 * `process.execPath` is the bun already executing this file: an absolute path, necessarily the
 * pinned one the engine granted, and correct by construction rather than by PATH archaeology.
 * Verified against the real sandbox — the absolute path execs fine where the bare name cannot.
 *
 * Outside the factory this is still right: it runs child commands with the same bun running the
 * harness, instead of whichever one happens to come first on the developer's PATH.
 */
export function resolveArgv(argv: string[]): string[] {
  const [head, ...rest] = argv;
  return head === "bun" ? [process.execPath, ...rest] : argv;
}
