import { describe, test, expect } from "vitest";
import { splitSnippet } from "./format";

// splitSnippet turns an FTS5 snippet() string (matches wrapped in the server's
// `[ ]` delimiters) into ordered { text, hit } segments the panel renders as
// <mark> vs. plain text — no {@html}, no offset math (XSS-safe).
describe("splitSnippet", () => {
  test("splits a single delimited hit into text + hit + text", () => {
    expect(splitSnippet("the [zebrafish] algorithm")).toEqual([
      { text: "the ", hit: false },
      { text: "zebrafish", hit: true },
      { text: " algorithm", hit: false },
    ]);
  });

  test("handles multiple hits", () => {
    expect(splitSnippet("[foo] and [bar]")).toEqual([
      { text: "foo", hit: true },
      { text: " and ", hit: false },
      { text: "bar", hit: true },
    ]);
  });

  test("a string with no delimiter is one plain segment", () => {
    expect(splitSnippet("plain text")).toEqual([{ text: "plain text", hit: false }]);
  });

  test("empty string yields no segments", () => {
    expect(splitSnippet("")).toEqual([]);
  });

  test("an unbalanced open bracket degrades to plain text (no throw, no hit)", () => {
    expect(splitSnippet("dangling [bracket")).toEqual([{ text: "dangling [bracket", hit: false }]);
  });
});
