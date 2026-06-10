// Router query-string support for ?tab=errors (ADR-0005). The pathname-only
// router gains a reactive `search`, a query-aware `navigate`, and a tabFromSearch
// helper — without disturbing existing pathname routing. Named *.svelte.test.ts
// so the svelte plugin compiles the $state router (see vitest.config.ts).

import { describe, test, expect } from "vitest";
import { router, navigate, tabFromSearch } from "./router.svelte";

describe("tabFromSearch", () => {
  test("?tab=errors maps to the Errors tab", () => {
    expect(tabFromSearch("?tab=errors")).toBe("errors");
  });
  test("empty / missing / unrelated query defaults to Messages", () => {
    expect(tabFromSearch("")).toBe("messages");
    expect(tabFromSearch("?tab=messages")).toBe("messages");
    expect(tabFromSearch("?foo=1")).toBe("messages");
  });
});

describe("navigate with a query string", () => {
  test("sets both reactive path and search", () => {
    navigate("/session/abc", "?tab=errors");
    expect(router.path).toBe("/session/abc");
    expect(router.search).toBe("?tab=errors");
  });

  test("a same-path query-only change is NOT swallowed by the early-return", () => {
    navigate("/session/xyz");
    expect(router.search).toBe("");
    navigate("/session/xyz", "?tab=errors"); // same path, new query
    expect(router.search).toBe("?tab=errors");
  });

  test("popstate refreshes path AND search from the URL", () => {
    navigate("/session/p", "?tab=errors");
    history.pushState({}, "", "/activity");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(router.path).toBe("/activity");
    expect(router.search).toBe("");
  });
});
