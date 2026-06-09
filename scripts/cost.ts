// Rack-rate cost engine (ADR-0002). Debuts in Phase 1 with Claude.
//
// Reads config/prices.yaml and computes the uniform cross-agent ESTIMATED cost:
//   cost_estimated_usd = Σ(tokens × API list price)   — ALWAYS `estimated` fidelity.
//
// Load-bearing rules (CONTEXT.md / ADR-0002):
//   • A model absent from the table (after alias resolution) => null, never a
//     guessed rate. `<synthetic>` quota responses and any unknown model stay NULL.
//   • Estimated cost is NEVER merged into a headline total with native cost.
//   • Rates are USD per 1,000,000 tokens.
//
// This module is pure + synchronous after first load so the orchestrator can call
// it per session without async overhead. The table is read once and cached; call
// reloadPrices() if config/prices.yaml changes at runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CONFIG_DIR } from "./paths.ts";
import type { TokenCounts } from "./adapters/base.ts";

interface ModelRate {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
}

interface PriceTable {
  version: number;
  currency: string;
  unit: string;
  models: Record<string, ModelRate>;
  aliases: Record<string, string>;
}

const PRICES_PATH = join(CONFIG_DIR, "prices.yaml");

let table: PriceTable | null = null;

function load(): PriceTable {
  if (table) return table;
  // prices.yaml is small and read once; read it synchronously (node:fs) so this
  // whole module stays sync and the orchestrator can call it per session.
  const text = readFileSync(PRICES_PATH, "utf8");
  const t = (parse(text) ?? {}) as Partial<PriceTable>;
  table = {
    version: t.version ?? 0,
    currency: t.currency ?? "USD",
    unit: t.unit ?? "per_million_tokens",
    models: t.models ?? {},
    aliases: t.aliases ?? {},
  };
  return table;
}

/** Drop the cached table so the next call re-reads prices.yaml (e.g. after edit). */
export function reloadPrices(): void {
  table = null;
}

/**
 * Resolve a logged model id to a priced `models` key, applying aliases.
 * Returns null when the model is not in the table (=> unpriced, cost NULL).
 */
export function resolveModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const t = load();
  const aliased = t.aliases[model] ?? model;
  return aliased in t.models ? aliased : null;
}

export interface CostEstimate {
  /** Rack-rate USD, or null when the model is unpriced (never a guess). */
  usd: number | null;
  /** True when a rate was found and applied. */
  priced: boolean;
  /** The resolved price-table key, or null. */
  resolvedModel: string | null;
}

/**
 * Estimate rack-rate cost for one model's token counts. Unknown model => null.
 * reasoning tokens fall back to the `output` rate when no explicit reasoning rate
 * exists (Claude has none — it folds thinking into output, so this never fires
 * for Claude, but the path exists for Codex/Antigravity).
 */
export function estimateCostUsd(
  model: string | null | undefined,
  tokens: TokenCounts,
): CostEstimate {
  const key = resolveModel(model);
  if (!key) return { usd: null, priced: false, resolvedModel: null };

  const r = load().models[key];
  if (!r) return { usd: null, priced: false, resolvedModel: null };
  const per = (count: number | undefined, rate: number | undefined): number =>
    !count || !rate ? 0 : (count * rate) / 1_000_000;

  const usd =
    per(tokens.input, r.input) +
    per(tokens.output, r.output) +
    per(tokens.cacheRead, r.cache_read) +
    per(tokens.cacheCreate, r.cache_write) +
    per(tokens.reasoning, r.reasoning ?? r.output);

  return { usd, priced: true, resolvedModel: key };
}

/** Table metadata for diagnostics / `cc doctor`. */
export function priceTableMeta(): { version: number; modelCount: number; aliasCount: number } {
  const t = load();
  return {
    version: t.version,
    modelCount: Object.keys(t.models).length,
    aliasCount: Object.keys(t.aliases).length,
  };
}
