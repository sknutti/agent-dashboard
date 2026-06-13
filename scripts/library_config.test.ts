import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLibraryConfig, checkLibraryBridge, type LibraryConfig } from "./library_config.ts";
import {
  DEFAULT_ASKPASS_DIR,
  DEFAULT_BACKUP_DIR,
  DEFAULT_BOOTSTRAP_SESSION_PATH,
  DEFAULT_BRIDGE_PATH,
  DEFAULT_INSTALLS_PATH,
  DEFAULT_LIBRARY_HOME,
} from "./paths.ts";

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
        sessionPath: DEFAULT_BOOTSTRAP_SESSION_PATH,
        backupDir: DEFAULT_BACKUP_DIR,
        remoteUrl: null,
        askpassDir: DEFAULT_ASKPASS_DIR,
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
        sessionPath: DEFAULT_BOOTSTRAP_SESSION_PATH,
        backupDir: DEFAULT_BACKUP_DIR,
        remoteUrl: null,
        askpassDir: DEFAULT_ASKPASS_DIR,
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
        sessionPath: DEFAULT_BOOTSTRAP_SESSION_PATH,
        backupDir: DEFAULT_BACKUP_DIR,
        remoteUrl: null,
        askpassDir: DEFAULT_ASKPASS_DIR,
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

describe("loadLibraryConfig — bootstrap state (sessionPath + backupDir)", () => {
  test("a missing file yields the default session path + backup dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "library-empty-"));
    try {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.sessionPath).toBe(DEFAULT_BOOTSTRAP_SESSION_PATH);
      expect(c.backupDir).toBe(DEFAULT_BACKUP_DIR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the defaults live under DATA_DIR", () => {
    expect(DEFAULT_BOOTSTRAP_SESSION_PATH).toMatch(/\/bootstrap-session\.json$/);
    expect(DEFAULT_BACKUP_DIR).toMatch(/\/backups$/);
  });

  test("reads bootstrap_session_path and backup_dir from the file", () => {
    withYaml(`bootstrap_session_path: /data/sess.json\nbackup_dir: /data/bk\n`, (dir) => {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.sessionPath).toBe("/data/sess.json");
      expect(c.backupDir).toBe("/data/bk");
    });
  });

  test("env CC_LIBRARY_BOOTSTRAP_SESSION_PATH / CC_LIBRARY_BACKUP_DIR override the file", () => {
    withYaml(`bootstrap_session_path: /from/file.json\nbackup_dir: /from/file\n`, (dir) => {
      const env = {
        CC_LIBRARY_BOOTSTRAP_SESSION_PATH: "/from/env.json",
        CC_LIBRARY_BACKUP_DIR: "/from/env",
      };
      const c = loadLibraryConfig(dir, env);
      expect(c.sessionPath).toBe("/from/env.json");
      expect(c.backupDir).toBe("/from/env");
    });
  });

  test("non-string values fall back to the defaults, never a coerced value", () => {
    withYaml(`bootstrap_session_path:\n  - not\n  - a\n  - string\nbackup_dir: 999\n`, (dir) => {
      const c = loadLibraryConfig(dir, NO_ENV);
      expect(c.sessionPath).toBe(DEFAULT_BOOTSTRAP_SESSION_PATH);
      expect(c.backupDir).toBe(DEFAULT_BACKUP_DIR);
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
    sessionPath: "/data/bootstrap-session.json",
    backupDir: "/data/backups",
    remoteUrl: null,
    askpassDir: "/data/askpass",
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

// --- Slice 8: remoteUrl/askpassDir loading + persistRemoteUrl ---------------
import { persistRemoteUrl } from "./library_config.ts";
import { readFileSync as readFile } from "node:fs";

describe("loadLibraryConfig — git-sync fields (remoteUrl, askpassDir)", () => {
  test("reads remote_url from the file; askpass_dir defaults", () => {
    withYaml(`library_path: /libs/x\nremote_url: https://github.com/o/r\n`, (dir) => {
      const cfg = loadLibraryConfig(dir, NO_ENV);
      expect(cfg.remoteUrl).toBe("https://github.com/o/r");
      expect(cfg.askpassDir).toBe(DEFAULT_ASKPASS_DIR);
    });
  });
  test("remoteUrl is null when unset; env overrides file", () => {
    withYaml(`library_path: /libs/x\n`, (dir) => {
      expect(loadLibraryConfig(dir, NO_ENV).remoteUrl).toBeNull();
      expect(loadLibraryConfig(dir, { CC_LIBRARY_REMOTE_URL: "https://github.com/e/n" }).remoteUrl).toBe(
        "https://github.com/e/n",
      );
    });
  });
  test("CC_LIBRARY_ASKPASS_DIR overrides the default", () => {
    withYaml(`library_path: /libs/x\n`, (dir) => {
      expect(loadLibraryConfig(dir, { CC_LIBRARY_ASKPASS_DIR: "/tmp/ak" }).askpassDir).toBe("/tmp/ak");
    });
  });
});

describe("persistRemoteUrl (Slice 8 — the one route that mutates the config file)", () => {
  test("writes remote_url and the loader reads it back", () => {
    withYaml(`library_path: /libs/x\n`, (dir) => {
      persistRemoteUrl("https://github.com/o/r", dir);
      expect(loadLibraryConfig(dir, NO_ENV).remoteUrl).toBe("https://github.com/o/r");
    });
  });
  test("preserves other keys AND the file's human comments", () => {
    const original = `# keep me\nlibrary_path: /libs/x\n# bridge note\nbridge_path: /opt/b\n`;
    withYaml(original, (dir) => {
      persistRemoteUrl("https://github.com/o/r", dir);
      const raw = readFile(join(dir, "library.yaml"), "utf8");
      // comments survive (Document API, not parse→stringify)
      expect(raw).toContain("# keep me");
      expect(raw).toContain("# bridge note");
      // unrelated keys untouched; loader still resolves them
      const cfg = loadLibraryConfig(dir, NO_ENV);
      expect(cfg.libraryPath).toBe("/libs/x");
      expect(cfg.bridgePath).toBe("/opt/b");
      expect(cfg.remoteUrl).toBe("https://github.com/o/r");
    });
  });
  test("re-persisting overwrites the prior remote_url, not duplicates it", () => {
    withYaml(`library_path: /libs/x\n`, (dir) => {
      persistRemoteUrl("https://github.com/o/first", dir);
      persistRemoteUrl("https://github.com/o/second", dir);
      const raw = readFile(join(dir, "library.yaml"), "utf8");
      expect(raw.match(/remote_url:/g)?.length).toBe(1);
      expect(loadLibraryConfig(dir, NO_ENV).remoteUrl).toBe("https://github.com/o/second");
    });
  });
  test("a missing config file starts a fresh document", () => {
    const dir = mkdtempSync(join(tmpdir(), "library-persist-"));
    try {
      persistRemoteUrl("https://github.com/o/r", dir);
      expect(loadLibraryConfig(dir, NO_ENV).remoteUrl).toBe("https://github.com/o/r");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
