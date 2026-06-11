import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLibraryConfig } from "./library_config.ts";
import { DEFAULT_BRIDGE_PATH } from "./paths.ts";

// An empty env so call-time env-override resolution is deterministic (the host
// shell must not leak CC_LIBRARY_* into the assertions).
const NO_ENV: Record<string, string | undefined> = {};

function withYaml(body: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "library-cfg-"));
  try {
    writeFileSync(join(dir, "library.yaml"), body);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadLibraryConfig", () => {
  test("a missing file yields null path + the default bridge path, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "library-empty-"));
    try {
      expect(loadLibraryConfig(dir, NO_ENV)).toEqual({
        libraryPath: null,
        bridgePath: DEFAULT_BRIDGE_PATH,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default bridge path is target/debug/prompt-library-bridge under PROJECT_ROOT", () => {
    expect(DEFAULT_BRIDGE_PATH).toMatch(/\/target\/debug\/prompt-library-bridge$/);
    // resolved with no config + no env, the loader returns exactly that default
    const dir = mkdtempSync(join(tmpdir(), "library-empty-"));
    try {
      expect(loadLibraryConfig(dir, NO_ENV).bridgePath).toBe(DEFAULT_BRIDGE_PATH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads library_path and bridge_path from the file", () => {
    withYaml(`library_path: /libs/prompts\nbridge_path: /opt/bridge\n`, (dir) => {
      expect(loadLibraryConfig(dir, NO_ENV)).toEqual({
        libraryPath: "/libs/prompts",
        bridgePath: "/opt/bridge",
      });
    });
  });

  test("env CC_LIBRARY_PATH overrides the file's library_path (dev override)", () => {
    withYaml(`library_path: /from/file\n`, (dir) => {
      const env = { CC_LIBRARY_PATH: "/from/env" };
      expect(loadLibraryConfig(dir, env).libraryPath).toBe("/from/env");
    });
  });

  test("env CC_LIBRARY_BRIDGE_PATH overrides the file's bridge_path", () => {
    withYaml(`bridge_path: /from/file\n`, (dir) => {
      const env = { CC_LIBRARY_BRIDGE_PATH: "/from/env" };
      expect(loadLibraryConfig(dir, env).bridgePath).toBe("/from/env");
    });
  });

  test("a malformed file fails closed: null path + default bridge, never throws", () => {
    // Unparseable YAML must not throw and must not leak a half-parsed path.
    withYaml(`library_path: [unterminated\n: : :`, (dir) => {
      expect(loadLibraryConfig(dir, NO_ENV)).toEqual({
        libraryPath: null,
        bridgePath: DEFAULT_BRIDGE_PATH,
      });
    });
  });

  test("a non-string library_path is rejected (fail-closed, security m6)", () => {
    // A list/number where a path string is expected must collapse to null —
    // never a coerced or stringified path that becomes a filesystem-read oracle.
    withYaml(`library_path:\n  - not\n  - a\n  - string\n`, (dir) => {
      expect(loadLibraryConfig(dir, NO_ENV).libraryPath).toBeNull();
    });
  });

  test("a non-string bridge_path falls back to the default, never a coerced value", () => {
    withYaml(`bridge_path: 12345\n`, (dir) => {
      expect(loadLibraryConfig(dir, NO_ENV).bridgePath).toBe(DEFAULT_BRIDGE_PATH);
    });
  });
});
