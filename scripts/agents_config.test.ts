import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsConfig } from "./agents_config.ts";

function withYaml(body: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agents-cfg-"));
  try {
    writeFileSync(join(dir, "agents.yaml"), body);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadAgentsConfig (#17)", () => {
  test("parses the real project config: 4 agents, ordered, named", () => {
    const m = loadAgentsConfig(); // default CONFIG_DIR = the repo's config/
    expect(m.map((a) => a.id)).toEqual(["claude_code", "codex", "pi", "antigravity"]);
    expect(m.map((a) => a.name)).toEqual(["Claude Code", "Codex", "Pi", "Antigravity"]);
    expect(m.find((a) => a.id === "claude_code")!.cost).toBe("native");
    expect(m.find((a) => a.id === "codex")!.cost).toBe("none");
    expect(m.find((a) => a.id === "pi")!.otelService).toBe("pi-otel");
  });

  test("sorts by `order`, not declaration order", () => {
    withYaml(
      `agents:\n  b:\n    name: B\n    order: 2\n  a:\n    name: A\n    order: 1\n`,
      (dir) => {
        expect(loadAgentsConfig(dir).map((a) => a.id)).toEqual(["a", "b"]);
      },
    );
  });

  test("applies safe defaults for missing fields (name→id, cost→none, enabled→true)", () => {
    withYaml(`agents:\n  solo:\n    path: "~/x"\n`, (dir) => {
      const [a] = loadAgentsConfig(dir);
      expect(a!.name).toBe("solo"); // falls back to id
      expect(a!.cost).toBe("none"); // never guesses native
      expect(a!.enabled).toBe(true); // enabled unless explicitly false
      expect(a!.otel).toBe(false);
    });
  });

  test("a missing/unparseable file yields an empty registry, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-empty-"));
    try {
      expect(loadAgentsConfig(dir)).toEqual([]); // no agents.yaml present
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enabled:false is respected", () => {
    withYaml(`agents:\n  off:\n    enabled: false\n`, (dir) => {
      expect(loadAgentsConfig(dir)[0]!.enabled).toBe(false);
    });
  });
});
