// The single agent registry, read from config/agents.yaml (review #17).
//
// Before this, agent identity was hardcoded in ~9 places across both packages —
// the AgentId union, buildRegistry's 4 constructors, routes.ts's AGENT_IDS +
// detected-path map + cost ternary, otel.ts's service map, the UI's AGENT_NAMES +
// ORDER + four filter lists. Several were stale copies (the detected-path map was
// wrong the moment a path was overridden; the cost ternary duplicated this file's
// `cost:` key but never read it). Everything data-shaped now derives from here;
// the only remaining code-side bindings are the AgentId union (type safety) and
// the id→constructor map (a class can't live in YAML).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_DIR } from "./paths.ts";

export interface AgentMeta {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
  path?: string;
  glob?: string;
  otel: boolean;
  otelService?: string;
  /** Hybrid-cost policy (master §11.5): native shows the vendor's exact USD. */
  cost: "native" | "none";
}

function coerce(id: string, raw: any, index: number): AgentMeta {
  const a = raw ?? {};
  return {
    id,
    name: typeof a.name === "string" ? a.name : id,
    // Missing order sorts after the explicit ones, in declaration order.
    order: Number.isFinite(a.order) ? Number(a.order) : 1000 + index,
    enabled: a.enabled !== false,
    path: typeof a.path === "string" ? a.path : undefined,
    glob: typeof a.glob === "string" ? a.glob : undefined,
    otel: a.otel === true,
    otelService: typeof a.otel_service === "string" ? a.otel_service : undefined,
    cost: a.cost === "native" ? "native" : "none",
  };
}

/**
 * Parse config/agents.yaml into an ordered AgentMeta[]. Never throws — a missing
 * or malformed file yields an empty registry (the orchestrator then runs nothing
 * and the UI shows no agents, rather than crashing the server).
 */
export function loadAgentsConfig(configDir: string = CONFIG_DIR): AgentMeta[] {
  let cfg: any = {};
  try {
    cfg = parseYaml(readFileSync(join(configDir, "agents.yaml"), "utf8")) ?? {};
  } catch {
    return [];
  }
  const agents = cfg?.agents ?? {};
  return Object.entries(agents)
    .map(([id, raw], i) => coerce(id, raw, i))
    .sort((a, b) => a.order - b.order);
}
