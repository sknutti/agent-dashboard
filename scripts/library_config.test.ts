import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLibraryConfig, checkLibraryBridge, type LibraryConfig } from "./library_config.ts";
import { DEFAULT_BRIDGE_PATH, DEFAULT_INSTALLS_PATH, DEFAULT_LIBRARY_HOME } from "./paths.ts";

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
        installsPath: DEFAULT_INSTALLS_PATH,
        home: DEFAULT_LIBRARY_HOME,
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
        installsPath: DEFAULT_INSTALLS_PATH,
        home: DEFAULT_LIBRARY_HOME,
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
        installsPath: DEFAULT_INSTALLS_PATH,
        home: DEFAULT_LIBRARY_HOME,
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

describe("loadLibraryConfig — install destination (installsPath + home)", () => {
  test("a missing file yields the default installs path + user home", () => {
    const dir = mkdtempSync(join(tmpdir(), "library-empty-"));
    try {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.installsPath).toBe(DEFAULT_INSTALLS_PATH);
      expect(c.home).toBe(DEFAULT_LIBRARY_HOME);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default installs path is DATA_DIR/installs.json", () => {
    expect(DEFAULT_INSTALLS_PATH).toMatch(/\/installs\.json$/);
  });

  test("reads installs_path and home from the file", () => {
    withYaml(`installs_path: /data/installs.json\nhome: /home/ada\n`, (dir) => {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.installsPath).toBe("/data/installs.json");
      expect(c.home).toBe("/home/ada");
    });
  });

  test("env CC_LIBRARY_INSTALLS_PATH overrides the file's installs_path", () => {
    withYaml(`installs_path: /from/file.json\n`, (dir) => {
      const env = { CC_LIBRARY_INSTALLS_PATH: "/from/env.json" };
      expect(loadLibraryConfig(dir, env).installsPath).toBe("/from/env.json");
    });
  });

  test("env CC_LIBRARY_HOME overrides the file's home (temp install root for tests)", () => {
    withYaml(`home: /from/file\n`, (dir) => {
      const env = { CC_LIBRARY_HOME: "/from/env" };
      expect(loadLibraryConfig(dir, env).home).toBe("/from/env");
    });
  });

  test("a non-string installs_path / home fall back to defaults, never a coerced value", () => {
    withYaml(`installs_path:\n  - not\n  - a\n  - string\nhome: 12345\n`, (dir) => {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.installsPath).toBe(DEFAULT_INSTALLS_PATH);
      expect(c.home).toBe(DEFAULT_LIBRARY_HOME);
    });
  });

  test("a malformed file never throws — installs destination collapses to safe defaults", () => {
    withYaml(`installs_path: [unterminated\n: : :`, (dir) => {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.installsPath).toBe(DEFAULT_INSTALLS_PATH);
      expect(c.home).toBe(DEFAULT_LIBRARY_HOME);
    });
  });
});

describe("checkLibraryBridge (doctor)", () => {
  const present = () => true;
  const absent = () => false;

  // checkLibraryBridge only reads libraryPath/bridgePath; fill the install
  // destination with placeholders so the literal satisfies LibraryConfig.
  const cfg = (libraryPath: string | null, bridgePath: string): LibraryConfig => ({
    libraryPath,
    bridgePath,
    installsPath: "/data/installs.json",
    home: "/home/test",
  });

  // Injectable mtime providers (ms). The defaults hit the real fs; tests pin
  // them so staleness is deterministic without touching disk.
  const binAt = (ms: number | null) => () => ms;
  const srcAt = (ms: number | null) => () => ms;

  test("configured library + missing bridge binary warns with a build hint", () => {
    const r = checkLibraryBridge(cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"), absent);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("build:bridge");
  });

  test("configured library + a bridge newer than its sources is ok", () => {
    const r = checkLibraryBridge(
      cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"),
      present,
      binAt(200),
      srcAt(100),
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("/repo/target/debug/prompt-library-bridge");
  });

  test("a bridge OLDER than its crate sources warns as stale (the unknown_command trap)", () => {
    const r = checkLibraryBridge(
      cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"),
      present,
      binAt(100),
      srcAt(200),
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/stale/i);
    expect(r.detail).toContain("build:bridge");
  });

  test("an equal mtime is NOT stale (no off-by-one false alarm)", () => {
    const r = checkLibraryBridge(
      cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"),
      present,
      binAt(200),
      srcAt(200),
    );
    expect(r.status).toBe("ok");
  });

  test("staleness fails OPEN when either mtime is unknown (no false 'stale' warning)", () => {
    const unknownBin = checkLibraryBridge(
      cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"),
      present,
      binAt(null),
      srcAt(200),
    );
    expect(unknownBin.status).toBe("ok");
    const unknownSrc = checkLibraryBridge(
      cfg("/libs/x", "/repo/target/debug/prompt-library-bridge"),
      present,
      binAt(200),
      srcAt(null),
    );
    expect(unknownSrc.status).toBe("ok");
  });

  test("an unconfigured library is ok (the feature is optional), never a warning", () => {
    // bridge presence is irrelevant when no library is configured
    const r = checkLibraryBridge(cfg(null, "/whatever"), absent);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/not configured/i);
  });
});
