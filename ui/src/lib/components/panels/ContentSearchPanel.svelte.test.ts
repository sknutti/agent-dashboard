// Component coverage for the content-search panel (FTS5 tracer). Mocks
// searchContent and drives the debounced input via @testing-library/svelte
// (jsdom). Named *.svelte.test.ts so runes compile (see vitest.config.ts).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import ContentSearchPanel from "./ContentSearchPanel.svelte";
import * as api from "../../api";
import type { SearchResult } from "../../api";

const hit = (id: string, snippet: string): SearchResult => ({
  session_id: id, agent: "claude_code", title: `Title ${id}`,
  cwd: `/repo/${id}`, started_at: "2026-06-01T00:00:00Z", snippet,
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function type(term: string): Promise<HTMLInputElement> {
  const input = screen.getByLabelText(/search transcript content/i) as HTMLInputElement;
  await fireEvent.input(input, { target: { value: term } });
  return input;
}

describe("ContentSearchPanel", () => {
  test("typing a query renders matching sessions with their snippet", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", results: [hit("alpha", "the [zebrafish] algorithm")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    expect(await screen.findByText("Title alpha")).toBeTruthy();
    expect(await screen.findByText(/zebrafish\] algorithm/)).toBeTruthy();
  });

  test("a query with no matches shows the empty state", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({ q: "nope", results: [] });
    render(ContentSearchPanel);
    await type("nope");
    expect(await screen.findByText(/no matches/i)).toBeTruthy();
  });

  test("clicking a result navigates to that session's detail page", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", results: [hit("alpha", "[zebrafish]")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    const result = await screen.findByText("Title alpha");
    await fireEvent.click(result);
    expect(window.location.pathname).toBe("/session/alpha");
  });

  test("a blank query does not call the API", async () => {
    const spy = vi.spyOn(api, "searchContent").mockResolvedValue({ q: "", results: [] });
    render(ContentSearchPanel);
    await type("   ");
    // give the debounce window time to (not) fire
    await new Promise((r) => setTimeout(r, 250));
    expect(spy).not.toHaveBeenCalled();
  });
});
