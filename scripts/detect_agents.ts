// Auto-detect which agent data dirs exist and flip `enabled` in agents.yaml
// (master §21 step 4b). Uses parseDocument so YAML comments survive the edit.
// Phase 0 has no adapters, so this only affects display/Phase-1 readiness.

import { parseDocument, isMap } from "yaml";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR } from "./paths.ts";

const path = join(CONFIG_DIR, "agents.yaml");
const doc = parseDocument(await Bun.file(path).text());
const agents = doc.get("agents");
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const enabled: string[] = [];
if (isMap(agents)) {
  for (const item of agents.items) {
    const id = String((item.key as { value: unknown }).value);
    const node = item.value;
    if (!isMap(node)) continue;
    const dir = expand(String(node.get("path")));
    const present = existsSync(dir);
    node.set("enabled", present);
    if (present) enabled.push(id);
  }
}

await Bun.write(path, doc.toString());
console.log(`detected + enabled: ${enabled.join(", ") || "(none)"}`);
