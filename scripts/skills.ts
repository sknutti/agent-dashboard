// Skills registry scanner (Phase 5, Skills & MCP page). Read-only filesystem
// scan of SKILL.md files → the `skills` table. No LLM, no outbound.
//
// Sources (environment is derived from the path):
//   ~/.claude/skills/<name>/SKILL.md         → ide:global
//   <cwd>/.claude/skills/<name>/SKILL.md     → ide:project
//   ~/.claude/plugins/**/SKILL.md            → cowork:plugin
//
// autonomy_level is a USER override (set via PATCH /api/skills/:name/autonomy):
// re-sync UPSERTs metadata but never overwrites it, then prunes skills whose
// SKILL.md disappeared — same preserve-overrides pattern as burn_daily.

import { Glob } from "bun";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";

export interface ScannedSkill {
  name: string;
  description: string | null;
  path: string;
  environment: string;
  user_invocable: number;
  script_count: number;
  last_modified: string;
}

/** Parse a leading `---`-delimited YAML frontmatter block into flat key/values. */
function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (m) out[m[1]!] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Count non-SKILL.md files in a skill directory (a proxy for "scripts"). */
function countScripts(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name !== "SKILL.md") n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

function scanDir(baseDir: string, pattern: string, environment: string): ScannedSkill[] {
  if (!existsSync(baseDir)) return [];
  const out: ScannedSkill[] = [];
  let paths: string[];
  try {
    paths = [...new Glob(pattern).scanSync({ cwd: baseDir, absolute: true, onlyFiles: true })];
  } catch {
    return [];
  }
  for (const p of paths) {
    try {
      const text = readFileSync(p, "utf8");
      const fm = parseFrontmatter(text);
      const dir = dirname(p);
      const name = fm.name || dir.split("/").pop() || p;
      out.push({
        name,
        description: fm.description ?? null,
        path: p,
        environment,
        user_invocable: fm.user_invocable === "false" ? 0 : 1,
        script_count: countScripts(dir),
        last_modified: statSync(p).mtime.toISOString(),
      });
    } catch {
      /* skip unreadable skill */
    }
  }
  return out;
}

/** Scan all configured skill locations. Project skills come from `cwd`. */
export function scanSkills(cwd: string = process.cwd()): ScannedSkill[] {
  const home = homedir();
  const all = [
    ...scanDir(join(home, ".claude", "skills"), "*/SKILL.md", "ide:global"),
    ...scanDir(join(cwd, ".claude", "skills"), "*/SKILL.md", "ide:project"),
    ...scanDir(join(home, ".claude", "plugins"), "**/SKILL.md", "cowork:plugin"),
  ];
  // Dedupe by name (a plugin source + its installed copy can collide); first wins
  // in source priority order above (global > project > plugin).
  const seen = new Map<string, ScannedSkill>();
  for (const s of all) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
}

/**
 * Rebuild the `skills` table from disk. UPSERTs metadata (preserving the
 * user-set autonomy_level) and prunes rows whose SKILL.md no longer exists.
 * Returns the count of skills now registered.
 */
export function syncSkills(db: Database, cwd: string = process.cwd()): number {
  const scanned = scanSkills(cwd);
  const upsert = db.query(/* sql */ `
    INSERT INTO skills (name, environment, description, path, autonomy_level, user_invocable, script_count, last_modified)
    VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      environment = excluded.environment,
      description = excluded.description,
      path = excluded.path,
      user_invocable = excluded.user_invocable,
      script_count = excluded.script_count,
      last_modified = excluded.last_modified`);
  const tx = db.transaction((rows: ScannedSkill[]) => {
    for (const r of rows) {
      upsert.run(r.name, r.environment, r.description, r.path, r.user_invocable, r.script_count, r.last_modified);
    }
    const keep = new Set(rows.map((r) => r.name));
    for (const row of db.query("SELECT name FROM skills").all() as { name: string }[]) {
      if (!keep.has(row.name)) db.run("DELETE FROM skills WHERE name = ?", [row.name]);
    }
  });
  tx(scanned);
  return scanned.length;
}
