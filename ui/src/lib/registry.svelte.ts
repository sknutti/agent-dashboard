// Agent registry store (review #17). Hydrated once at boot from GET /api/registry,
// which the server derives from config/agents.yaml — the single source of truth.
// Every agent display name, sort order, and filter list reads from here, replacing
// the old hardcoded AGENT_NAMES + Command ORDER + four per-panel chip arrays.

export interface RegistryAgent {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
  cost: "native" | "none";
  otel: boolean;
  detected: boolean;
}

export const registry = $state<{ agents: RegistryAgent[]; loaded: boolean }>({
  agents: [],
  loaded: false,
});

// Reactive id → display name, mutated in place on load so importers stay live.
// `AGENT_NAMES[id] ?? id` keeps the id as a safe fallback before the fetch lands.
export const AGENT_NAMES = $state<Record<string, string>>({});

let started = false;

/** Fetch the registry once. Idempotent — safe to call from the app shell mount. */
export async function loadRegistry(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const res = await fetch("/api/registry");
    if (!res.ok) return;
    const data = (await res.json()) as { agents: RegistryAgent[] };
    registry.agents = data.agents.slice().sort((a, b) => a.order - b.order);
    for (const a of registry.agents) AGENT_NAMES[a.id] = a.name;
    registry.loaded = true;
  } catch {
    /* leave empty; call sites fall back to the raw id */
  }
}

/** Ordered agent ids, e.g. for stable iteration. */
export function agentIds(): string[] {
  return registry.agents.map((a) => a.id);
}

/** `["all", …ids]` for filter chips/selectors. */
export function agentFilterOptions(): string[] {
  return ["all", ...registry.agents.map((a) => a.id)];
}
