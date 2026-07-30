// The sub-gate manifest: `package.json`'s `check` chain, as data.
//
// `bun run check` is a five-link `&&` chain. The factory sees one exit code for the whole thing,
// so when the gate goes red the correction prompt can only say "`bun run check` exited 1" and hand
// the model a 64 KiB excerpt of five tools' interleaved output. This manifest is what lets
// `verify.ts` say *which link* broke.
//
// The manifest MUST stay in step with the chain it describes. That is not left to discipline —
// `subgates.test.ts` parses the real `check` script and fails if this list drifts from it.
//
// Contract: docs/specs/subgate-results-v1.md in sknutti/software-factory (`subgate-results.v1`).

export interface Subgate {
  /** Stable identifier. Must match the contract's /^[a-z][a-z0-9:._-]{0,63}$/ — it is reported to
   *  the engine and reaches a model prompt, so it is bounded and lowercase. */
  name: string;
  /** Argv to spawn. `argv[0]` must be a tool `.factory/binding.json` declares. */
  argv: string[];
  /** Working directory, relative to the repo root. */
  cwd: string;
}

/**
 * Sub-gates whose manifest argv delegates to a package script rather than repeating the chain's
 * literal command, mapped to the script they delegate to.
 *
 * Exactly one entry, and it earns its keep: the chain's first link is a bare `tsc --noEmit`, which
 * only resolves because the shell running the chain has `node_modules/.bin` on PATH. Spawning
 * `tsc` directly from this harness would depend on reproducing that PATH inside the sandbox.
 * `bun run typecheck` is the same command by definition — `package.json` declares
 * `"typecheck": "tsc --noEmit"` — and needs no PATH reconstruction, because bun's script runner
 * does it.
 *
 * The drift guard does not take that on faith: it asserts the aliased script STILL expands to the
 * chain's literal command, so editing `typecheck` breaks the build rather than the reporting.
 */
export const ALIASED_SCRIPTS: Record<string, string> = {
  typecheck: "typecheck",
};

/** The chain, in order. One entry per `&&` link (`cd ui` is a directive, not a link). */
export const SUBGATES: Subgate[] = [
  { name: "typecheck", argv: ["bun", "run", "typecheck"], cwd: "." },
  { name: "test:unit", argv: ["bun", "test", "scripts", ".factory/harness"], cwd: "." },
  { name: "check:ds", argv: ["bun", "run", "check:ds"], cwd: "." },
  { name: "ui:svelte-check", argv: ["bun", "run", "check"], cwd: "ui" },
  { name: "ui:vitest", argv: ["bun", "run", "test"], cwd: "ui" },
];
