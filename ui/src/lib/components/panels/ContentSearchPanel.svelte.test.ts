// Component coverage for the content-search panel (FTS5 tracer). Mocks
// searchContent and drives the debounced input via @testing-library/svelte
// (jsdom). Named *.svelte.test.ts so runes compile (see vitest.config.ts).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
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
  test("typing a query renders matching sessions and highlights matches as <mark>", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", total: 1, limit: 50, offset: 0,
      results: [hit("alpha", "the [zebrafish] algorithm")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    expect(await screen.findByText("Title alpha")).toBeTruthy();
    // the matched term is a <mark>, and the delimiters never leak as literal text
    const mark = await screen.findByText("zebrafish");
    expect(mark.tagName).toBe("MARK");
    expect(document.body.textContent).not.toMatch(/[[\]]/);
  });

  test("a query with no matches shows the empty state", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({ q: "nope", total: 0, limit: 50, offset: 0, results: [] });
    render(ContentSearchPanel);
    await type("nope");
    expect(await screen.findByText(/no matches/i)).toBeTruthy();
  });

  test("clicking a result navigates to that session's detail page", async () => {
    vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", total: 1, limit: 50, offset: 0, results: [hit("alpha", "[zebrafish]")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    const result = await screen.findByText("Title alpha");
    await fireEvent.click(result);
    expect(window.location.pathname).toBe("/session/alpha");
  });

  test("selecting an outcome chip re-issues the search with that outcome filter", async () => {
    const spy = vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", total: 1, limit: 25, offset: 0, results: [hit("alpha", "[zebrafish]")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole("button", { name: "errored" }));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ q: "zebrafish", outcome: "errored" })));
  });

  test("pager advances offset and shows from–to of total", async () => {
    const spy = vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "zebrafish", total: 60, limit: 25, offset: 0,
      results: [hit("alpha", "[zebrafish]")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    expect(await screen.findByText(/1–25 of 60/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));
    expect(await screen.findByText(/26–50 of 60/)).toBeTruthy();
  });

  test("changing the query resets offset to 0", async () => {
    const spy = vi.spyOn(api, "searchContent").mockResolvedValue({
      q: "x", total: 60, limit: 25, offset: 0, results: [hit("alpha", "[x]")],
    });
    render(ContentSearchPanel);
    await type("zebrafish");
    expect(await screen.findByText(/of 60/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));
    await type("quokka");
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ q: "quokka", offset: 0 })));
  });

  test("a blank query does not call the API", async () => {
    const spy = vi.spyOn(api, "searchContent").mockResolvedValue({ q: "", total: 0, limit: 50, offset: 0, results: [] });
    render(ContentSearchPanel);
    await type("   ");
    // give the debounce window time to (not) fire
    await new Promise((r) => setTimeout(r, 250));
    expect(spy).not.toHaveBeenCalled();
  });
});
