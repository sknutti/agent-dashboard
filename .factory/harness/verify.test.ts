// The verify harness, against stubbed sub-gates. No real tsc/vitest here — this file is about the
// harness's own contract, and the real chain is proven by running it (see the PR's cold-worktree
// parity evidence).
//
// The rule these tests exist to hold down, from `subgate-results.v1` §4: the harness's EXIT CODE
// decides pass/fail, and reporting must never be able to change it. Two of the four cases below
// are about a reporting failure NOT becoming a gate failure.

import { describe, expect, test } from "bun:test";
import {
  resolveArgv,
  runSubgates,
  SUBGATE_RESULTS_ENV,
  SUBGATE_RESULTS_VERSION,
  type RunDeps,
} from "./verify.ts";
import { SUBGATES, type Subgate } from "./subgates.ts";

const gate = (name: string): Subgate => ({ name, argv: ["bun", "run", name], cwd: "." });
const FIVE = ["typecheck", "test:unit", "check:ds", "ui:svelte-check", "ui:vitest"].map(gate);

/** Build deps with a scripted exit code per sub-gate name. */
const deps = (
  codes: Record<string, number>,
  over: Partial<RunDeps> = {},
): RunDeps & { written: { path: string; body: string }[]; warnings: string[] } => {
  const written: { path: string; body: string }[] = [];
  const warnings: string[] = [];
  let clock = 0;
  return {
    spawn: async (s) => codes[s.name] ?? 0,
    now: () => (clock += 10),
    writeResults: (path, body) => void written.push({ path, body }),
    env: { [SUBGATE_RESULTS_ENV]: "/tmp/results.json" },
    warn: (m) => void warnings.push(m),
    written,
    warnings,
    ...over,
  };
};

describe("runSubgates — the exit code", () => {
  test("all green → exit 0 and five `passed`", async () => {
    const d = deps({});
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).toBe(0);
    expect(res.results).toHaveLength(5);
    expect(res.results.every((r) => r.status === "passed")).toBe(true);
    expect(res.results.every((r) => r.exit_code === 0)).toBe(true);
  });

  test("one red → that sub-gate's exit code, and exactly one `failed`", async () => {
    const d = deps({ "ui:svelte-check": 1 });
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).toBe(1);
    const failed = res.results.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.name).toBe("ui:svelte-check");
  });

  test("the exit code is the FIRST failure's, matching `&&` semantics", async () => {
    const d = deps({ "test:unit": 3, "ui:vitest": 9 });
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).toBe(3);
  });

  // We do NOT short-circuit: a green run already executes all five sub-gates, so running them all
  // on a red gate is bounded above by the green cost (measured 13.7 s wall / 44.8 s CPU / 686 MB
  // against verify's 600 s / 600 s / 6 GiB ceilings). Reporting every sub-gate is strictly more
  // information, and it costs nothing we were not already spending.
  test("every sub-gate runs even after one fails — no short-circuit", async () => {
    const ran: string[] = [];
    const d = deps(
      { typecheck: 2 },
      {
        spawn: async (s) => {
          ran.push(s.name);
          return s.name === "typecheck" ? 2 : 0;
        },
      },
    );
    const res = await runSubgates(FIVE, d);
    expect(ran).toEqual(FIVE.map((s) => s.name));
    expect(res.results.filter((r) => r.status === "passed")).toHaveLength(4);
  });

  test("records a non-negative integer duration for every sub-gate", async () => {
    const res = await runSubgates(FIVE, deps({}));
    for (const r of res.results) {
      expect(Number.isInteger(r.duration_ms)).toBe(true);
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("runSubgates — the results file", () => {
  test("writes schema-shaped JSON to the path the engine names", async () => {
    const d = deps({ "check:ds": 1 });
    await runSubgates(FIVE, d);
    expect(d.written).toHaveLength(1);
    expect(d.written[0]!.path).toBe("/tmp/results.json");
    const parsed = JSON.parse(d.written[0]!.body);
    expect(parsed.subgate_results_version).toBe(SUBGATE_RESULTS_VERSION);
    expect(parsed.subgates).toHaveLength(5);
    expect(parsed.subgates[2]).toEqual({
      name: "check:ds",
      status: "failed",
      exit_code: 1,
      duration_ms: expect.any(Number),
    });
  });

  test("emits only the contract's keys — no output text, no argv", async () => {
    const d = deps({});
    await runSubgates(FIVE, d);
    const parsed = JSON.parse(d.written[0]!.body);
    expect(Object.keys(parsed).sort()).toEqual(["subgate_results_version", "subgates"]);
    for (const s of parsed.subgates) {
      expect(Object.keys(s).sort()).toEqual(["duration_ms", "exit_code", "name", "status"]);
    }
  });

  // The harness must run correctly outside the factory — a developer invoking it by hand.
  test("writes NOTHING when the variable is unset, and the exit code is unchanged", async () => {
    const d = deps({ typecheck: 7 }, { env: {} });
    const res = await runSubgates(FIVE, d);
    expect(d.written).toHaveLength(0);
    expect(res.exitCode).toBe(7);
  });

  test("writes nothing when the variable is set but empty", async () => {
    const d = deps({}, { env: { [SUBGATE_RESULTS_ENV]: "" } });
    await runSubgates(FIVE, d);
    expect(d.written).toHaveLength(0);
  });
});

// `subgate-results.v1` §5.6 — the emitting side of the fail-open rule. The engine is fail-open on
// this channel; the harness must be too, or a read-only results path would turn a green gate red
// and we would have built exactly the failure mode the ruling exists to prevent.
describe("runSubgates — a reporting failure is never a gate failure", () => {
  test("an unwritable target path leaves the exit code alone and does not throw", async () => {
    const d = deps(
      {},
      {
        writeResults: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    );
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).toBe(0);
    expect(d.warnings.join(" ")).toMatch(/EACCES/);
  });

  test("an unwritable path on a RED gate still reports the red exit code", async () => {
    const d = deps(
      { "ui:vitest": 4 },
      {
        writeResults: () => {
          throw new Error("EROFS: read-only file system");
        },
      },
    );
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).toBe(4);
  });

  test("a sub-gate that throws while spawning is a FAILED sub-gate, not a crash", async () => {
    const d = deps(
      {},
      {
        spawn: async (s) => {
          if (s.name === "check:ds") throw new Error("spawn ENOENT");
          return 0;
        },
      },
    );
    const res = await runSubgates(FIVE, d);
    expect(res.exitCode).not.toBe(0);
    const bad = res.results.find((r) => r.name === "check:ds")!;
    expect(bad.status).toBe("failed");
    expect(res.results).toHaveLength(5);
  });
});

describe("runSubgates — the emitted names stay inside the contract", () => {
  test("every emitted name matches the bounded-identifier regex", async () => {
    const d = deps({});
    await runSubgates(FIVE, d);
    for (const s of JSON.parse(d.written[0]!.body).subgates) {
      expect(s.name).toMatch(/^[a-z][a-z0-9:._-]{0,63}$/);
    }
  });

  test("refuses to emit a sub-gate whose name violates the contract", async () => {
    const d = deps({});
    await expect(runSubgates([gate("Bad Name")], d)).rejects.toThrow(/Bad Name/);
  });
});

// The sandbox-exec fix. Under the factory this harness runs inside a Seatbelt profile that grants
// read on the pinned tool binaries and nothing else, so resolving the BARE name `bun` fails even
// though PATH contains bun's directory — every sub-gate died with
// `Executable not found in $PATH: "bun"`, exit 127. Found by software-factory's U14 live proof
// against a real worktree of this repo's origin/main; the fixture-driven tests above could not
// reach it, because they inject `spawn` and never exec anything.
describe("resolveArgv — sub-gates exec by absolute path, not by PATH lookup", () => {
  test("rewrites a bare `bun` to the bun already running this harness", () => {
    expect(resolveArgv(["bun", "run", "typecheck"])).toEqual([process.execPath, "run", "typecheck"]);
  });

  test("the rewritten head is absolute, which is the whole point", () => {
    expect(resolveArgv(["bun", "test"])[0]!.startsWith("/")).toBe(true);
  });

  test("leaves any other tool untouched", () => {
    // `argv[0]` must be a tool `.factory/binding.json` declares; only bun is self-referential.
    expect(resolveArgv(["node", "x.js"])).toEqual(["node", "x.js"]);
    expect(resolveArgv(["sh", "-c", "true"])).toEqual(["sh", "-c", "true"]);
  });

  test("never rewrites a `bun` that is not in head position", () => {
    expect(resolveArgv(["sh", "-c", "bun --version"])).toEqual(["sh", "-c", "bun --version"]);
  });

  test("every declared sub-gate resolves to an executable head", () => {
    // Guards the real manifest rather than a fixture: a new sub-gate spawning `bun` gets the fix
    // automatically, and one spawning anything else is visible here rather than at 127 in a run.
    for (const s of SUBGATES) {
      const head = resolveArgv(s.argv)[0]!;
      expect(head === process.execPath || head === s.argv[0]).toBe(true);
    }
  });
});
