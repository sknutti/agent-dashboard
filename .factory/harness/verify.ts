#!/usr/bin/env bun
// The factory's `verify` binding: run `package.json`'s `check` chain sub-gate by sub-gate, and
// report which link broke.
//
// This replaces `bun run check` as the binding's verify command. It is a REPORTING change, not a
// semantic one — its exit code is equal to the chain's by construction (see "The exit code" below),
// and the engine cannot be talked into or out of a verdict by anything written here.
//
// Contract: `subgate-results.v1`, specified in sknutti/software-factory at
// docs/specs/subgate-results-v1.md. The three rules that matter:
//
//   1. THE EXIT CODE DECIDES. The results file is reporting about a verdict already reached. The
//      engine routes on the exit code alone and explicitly ignores a results file that contradicts
//      it. So this harness exits 0 iff every sub-gate passed, else with the FIRST failing
//      sub-gate's code — exactly what `a && b && c` does.
//   2. A REPORTING FAILURE IS NEVER A GATE FAILURE. If the results path is unwritable, we warn on
//      stderr and exit with the gate's real code. The engine is fail-open on this channel; turning
//      a read-only results path into a red gate would manufacture the precise failure the
//      fail-open ruling exists to prevent.
//   3. NO FILE UNLESS ASKED. Outside the factory the variable is unset and nothing is written, so
//      running this by hand behaves like `bun run check` with nicer output.
//
// Why no short-circuit: the chain stops at the first failure, but a GREEN run already executes all
// five sub-gates, so running them all on a red gate is bounded above by the green cost — measured
// 13.7 s wall / 44.8 s CPU / 686 MB RSS against verify's 600 s / 600 s / 6 GiB ceilings. Reporting
// every sub-gate is strictly more information at no budget we were not already spending. (The
// contract's `skipped` status exists for harnesses that DO short-circuit; this one never emits it.)

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { SUBGATES, type Subgate } from "./subgates.ts";

/** The env var through which the engine names the results path. Declared here rather than imported
 *  so this repository has no build-time dependency on the engine; the contract doc is the shared
 *  source of truth, and `subgates.test.ts` asserts our names satisfy it. */
export const SUBGATE_RESULTS_ENV = "FACTORY_SUBGATE_RESULTS";
export const SUBGATE_RESULTS_VERSION = 1;

/** The contract's bounded-identifier rule for sub-gate names. */
const NAME_RE = /^[a-z][a-z0-9:._-]{0,63}$/;

export interface SubgateOutcome {
  name: string;
  status: "passed" | "failed" | "skipped";
  exit_code: number | null;
  duration_ms: number;
}

export interface RunDeps {
  /** Spawn a sub-gate and resolve its exit code. Streams child output through untouched. */
  spawn: (subgate: Subgate) => Promise<number>;
  now: () => number;
  writeResults: (path: string, body: string) => void;
  env: Record<string, string | undefined>;
  warn: (message: string) => void;
}

export interface RunOutcome {
  exitCode: number;
  results: SubgateOutcome[];
}

/**
 * Run every sub-gate in order and produce the gate's exit code plus the per-sub-gate report.
 *
 * Injectable so the harness's own contract is testable without running tsc and vitest for real.
 */
export async function runSubgates(subgates: Subgate[], deps: RunDeps): Promise<RunOutcome> {
  for (const s of subgates) {
    // Fail loudly and early: an out-of-contract name would be rejected by the engine's strict
    // parser, which (being fail-open) would silently discard the whole report. Better to break the
    // harness's own tests than to ship a channel that is quietly always ignored.
    if (!NAME_RE.test(s.name)) {
      throw new Error(`sub-gate name '${s.name}' violates the subgate-results.v1 name rule`);
    }
  }

  const results: SubgateOutcome[] = [];
  let exitCode = 0;

  for (const subgate of subgates) {
    const started = deps.now();
    let code: number;
    try {
      code = await deps.spawn(subgate);
    } catch (e) {
      // A sub-gate we could not even start is a FAILED sub-gate, not a crashed harness. Crashing
      // here would deny the engine both the report and a meaningful exit code.
      deps.warn(`sub-gate '${subgate.name}' could not run: ${(e as Error).message}`);
      code = 127;
    }
    const duration_ms = Math.max(0, Math.round(deps.now() - started));
    results.push({
      name: subgate.name,
      status: code === 0 ? "passed" : "failed",
      exit_code: code,
      duration_ms,
    });
    if (code !== 0 && exitCode === 0) exitCode = code; // FIRST failure wins, as `&&` does
  }

  const target = deps.env[SUBGATE_RESULTS_ENV];
  if (target !== undefined && target !== "") {
    const body = JSON.stringify(
      { subgate_results_version: SUBGATE_RESULTS_VERSION, subgates: results },
      null,
      2,
    );
    try {
      deps.writeResults(target, body);
    } catch (e) {
      // Rule 2. Warn and carry on with the real verdict.
      deps.warn(`could not write sub-gate results to ${target}: ${(e as Error).message}`);
    }
  }

  return { exitCode, results };
}

/** The production deps: real spawns, inherited stdio, real clock. */
export function realDeps(repoRoot: string): RunDeps {
  return {
    spawn: async (subgate) => {
      // `stdio: inherit` is deliberate: the engine's raw capture is byte-for-byte evidence and the
      // model's excerpt comes from it, so every child's output must flow through unaltered. This
      // harness adds a report; it must not become a filter.
      const proc = Bun.spawn(subgate.argv, {
        cwd: join(repoRoot, subgate.cwd),
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      return await proc.exited;
    },
    now: () => Bun.nanoseconds() / 1_000_000,
    writeResults: (path, body) => writeFileSync(path, body, "utf8"),
    env: process.env as Record<string, string | undefined>,
    warn: (message) => console.error(`[factory-verify] ${message}`),
  };
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..", "..");
  const { exitCode, results } = await runSubgates(SUBGATES, realDeps(repoRoot));
  const passed = results.filter((r) => r.status === "passed").length;
  console.error(
    `[factory-verify] ${passed}/${results.length} sub-gates passed` +
      (exitCode === 0
        ? ""
        : ` — failed: ${results
            .filter((r) => r.status === "failed")
            .map((r) => r.name)
            .join(", ")}`),
  );
  process.exit(exitCode);
}
