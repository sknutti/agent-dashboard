// The DRIFT GUARD. This is the test that stops `subgates.ts` quietly diverging from the gate it
// claims to describe.
//
// The failure mode it exists to prevent: someone adds a sixth link to `package.json`'s `check`
// chain, the factory's verify harness keeps reporting five sub-gates, and the engine's correction
// prompt confidently names the wrong thing — or worse, reports "5 of 5 passed" on a red gate.
// Nothing else in either repository would notice, because the harness's exit code would still be
// right; only the *reporting* would be a lie.
//
// So this test parses the real `check` script out of the real `package.json` and asserts the
// manifest covers exactly its links, in order.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASED_SCRIPTS, SUBGATES, type Subgate } from "./subgates.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** One link of the `&&` chain, with the cwd in force when it runs. */
interface ChainLink {
  command: string;
  cwd: string;
}

/**
 * Split a `&&` chain into links, resolving `cd X` segments into the cwd of everything after them.
 *
 * `cd ui` is itself an `&&` segment in this repo's chain, and it is a DIRECTIVE, not a gate — it
 * changes where the following links run. Modelling that is the whole reason this parser exists
 * rather than a naive `split("&&")`.
 */
export function parseChain(script: string): ChainLink[] {
  const links: ChainLink[] = [];
  let cwd = ".";
  for (const raw of script.split("&&")) {
    const command = raw.trim();
    if (command.length === 0) continue;
    const cd = command.match(/^cd\s+(\S+)$/);
    if (cd) {
      cwd = cwd === "." ? cd[1]! : join(cwd, cd[1]!);
      continue;
    }
    links.push({ command, cwd });
  }
  return links;
}

/** The command a manifest entry actually runs, as a shell-ish string, for comparison. */
const asCommand = (s: Subgate): string => s.argv.join(" ");

describe("parseChain — the `&&` splitter that models `cd`", () => {
  test("treats `cd X` as a directive that moves everything after it", () => {
    expect(parseChain("a && cd ui && b && c")).toEqual([
      { command: "a", cwd: "." },
      { command: "b", cwd: "ui" },
      { command: "c", cwd: "ui" },
    ]);
  });

  test("nests successive cd segments", () => {
    expect(parseChain("cd ui && cd deep && x")).toEqual([{ command: "x", cwd: join("ui", "deep") }]);
  });

  test("ignores empty segments and trims whitespace", () => {
    expect(parseChain("  a  &&   && b ")).toEqual([
      { command: "a", cwd: "." },
      { command: "b", cwd: "." },
    ]);
  });

  test("a bare command with no chain is one link at the root", () => {
    expect(parseChain("tsc --noEmit")).toEqual([{ command: "tsc --noEmit", cwd: "." }]);
  });
});

describe("the manifest covers package.json's `check` chain exactly", () => {
  const links = parseChain(pkg.scripts.check!);

  test("`check` still exists and is still a chain (the premise of this whole harness)", () => {
    expect(pkg.scripts.check).toBeDefined();
    expect(links.length).toBeGreaterThan(1);
  });

  test("the manifest has exactly one entry per link, in the same order", () => {
    expect(SUBGATES).toHaveLength(links.length);
  });

  test("every link's cwd matches its manifest entry", () => {
    for (const [i, link] of links.entries()) {
      expect(SUBGATES[i]!.cwd).toBe(link.cwd);
    }
  });

  test("every link's command matches its manifest entry, directly or via a declared alias", () => {
    for (const [i, link] of links.entries()) {
      const entry = SUBGATES[i]!;
      const direct = asCommand(entry) === link.command;
      // An alias is only legitimate if the script it delegates to STILL expands to the chain's
      // literal command. That is what keeps `bun run typecheck` an honest stand-in for
      // `tsc --noEmit` — if someone edits the `typecheck` script, this goes red.
      const aliasScript = ALIASED_SCRIPTS[entry.name];
      const viaAlias =
        aliasScript !== undefined &&
        asCommand(entry) === `bun run ${aliasScript}` &&
        pkg.scripts[aliasScript] === link.command;
      expect(direct || viaAlias).toBe(true);
    }
  });

  test("every declared alias names a script that actually exists", () => {
    for (const [name, script] of Object.entries(ALIASED_SCRIPTS)) {
      expect(SUBGATES.some((s) => s.name === name)).toBe(true);
      expect(pkg.scripts[script]).toBeDefined();
    }
  });
});

describe("the manifest is well-formed for subgate-results.v1", () => {
  test("every name matches the contract's bounded-identifier regex", () => {
    for (const s of SUBGATES) expect(s.name).toMatch(/^[a-z][a-z0-9:._-]{0,63}$/);
  });

  test("names are unique — the engine keys its report on them", () => {
    expect(new Set(SUBGATES.map((s) => s.name)).size).toBe(SUBGATES.length);
  });

  test("there are between 1 and 64 sub-gates (the contract's array cap)", () => {
    expect(SUBGATES.length).toBeGreaterThanOrEqual(1);
    expect(SUBGATES.length).toBeLessThanOrEqual(64);
  });

  test("every argv is non-empty and runs a tool the binding declares", () => {
    const binding = JSON.parse(
      readFileSync(join(repoRoot, ".factory", "binding.json"), "utf8"),
    ) as { tools: string[] };
    for (const s of SUBGATES) {
      expect(s.argv.length).toBeGreaterThan(0);
      expect(binding.tools).toContain(s.argv[0]!);
    }
  });
});
