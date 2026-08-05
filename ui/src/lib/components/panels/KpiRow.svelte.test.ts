// KPI row test: today's headline metrics (sessions, tokens, tools, errors, spend).
// Tests the resolved value, loading state, and error/unavailable state for each tile.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import KpiRow from "./KpiRow.svelte";
import * as api from "../../api";
import type { Summary } from "../../api";

// jsdom's Web Animations API stub (some components call element.animate).
if (typeof Element !== 'undefined') {
  (Element.prototype as any).animate ??= () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("KpiRow", () => {
  test("renders resolved summary with formatted values", async () => {
    const summary: Summary = { sessions: 12, tokens: 45_000, tools: 18, errors: 0, spendUsd: 3.45 };
    vi.spyOn(api, "getSummary").mockResolvedValue(summary);
    
    render(KpiRow);
    
    // Wait for data to resolve
    expect(await screen.findByText("12")).toBeTruthy();
    
    // Sessions: plain number
    expect(screen.getByText("12")).toBeTruthy();
    
    // Tokens: compact format (45K)
    expect(screen.getByText("45K")).toBeTruthy();
    
    // Tool calls: plain number
    expect(screen.getByText("18")).toBeTruthy();
    
    // Errors: plain number
    expect(screen.getByText("0")).toBeTruthy();
    
    // Spend: USD format
    expect(screen.getByText("$3.45")).toBeTruthy();
    
    // All tiles show "live" status (since errors = 0, no alerts)
    expect(screen.getAllByText("live").length).toBe(5);
  });

  test("while loading, all tiles show '—' value and 'loading…' status", async () => {
    // Create a promise that never resolves (stuck in loading)
    vi.spyOn(api, "getSummary").mockImplementation(() => new Promise(() => {}));
    
    render(KpiRow);
    
    // In loading state, tiles show dash + "loading…"
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(5); // all 5 tiles show dash
    
    const loadingTexts = screen.getAllByText("loading…");
    expect(loadingTexts.length).toBeGreaterThanOrEqual(5); // all 5 tiles show "loading…"
  });

  test("on error, all tiles show '—' value and 'unavailable' status", async () => {
    vi.spyOn(api, "getSummary").mockRejectedValue(new Error("Failed to fetch"));
    
    render(KpiRow);
    
    // Wait a tick for the error to be processed
    await new Promise((r) => setTimeout(r, 10));
    
    // In error state, tiles show dash + "unavailable"
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(5); // all 5 tiles show dash
    
    const unavailableTexts = screen.getAllByText("unavailable");
    expect(unavailableTexts.length).toBeGreaterThanOrEqual(5); // all 5 tiles show "unavailable"
  });

  test("Spend tile shows currency format ($X.XX) when resolved", async () => {
    const summary: Summary = { sessions: 1, tokens: 100, tools: 0, errors: 0, spendUsd: 12.34 };
    vi.spyOn(api, "getSummary").mockResolvedValue(summary);
    
    render(KpiRow);
    
    // usd() formatter outputs: $12.34 for a value like 12.34
    expect(await screen.findByText("$12.34")).toBeTruthy();
  });

  test("Spend tile shows $0 for zero spend", async () => {
    const summary: Summary = { sessions: 1, tokens: 100, tools: 0, errors: 0, spendUsd: 0 };
    vi.spyOn(api, "getSummary").mockResolvedValue(summary);
    
    render(KpiRow);
    
    expect(await screen.findByText("$0")).toBeTruthy();
  });

  test("Spend tile shows — (dash) when loading (same as siblings)", async () => {
    vi.spyOn(api, "getSummary").mockImplementation(() => new Promise(() => {}));
    
    render(KpiRow);
    
    // The Spend tile's label
    expect(screen.getByText("Spend today")).toBeTruthy();
    
    // The tile should show dash in loading state
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(5); // includes spend tile
  });
});
