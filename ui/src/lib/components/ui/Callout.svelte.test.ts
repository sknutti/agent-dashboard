// Callout: messagebox primitive. Tone must carry a class (hue), but meaning also
// rides on the glyph/title — and `warn` is amber, NOT red (Scott is red/green
// colourblind). `role` passes through for error/status use.

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Callout from "./Callout.svelte";

afterEach(() => { cleanup(); });

const text = (s: string) =>
  createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

describe("Callout", () => {
  test("defaults to the neutral tone class", () => {
    const { container } = render(Callout, { children: text("plain note") });
    expect(container.querySelector(".callout.neutral")).toBeTruthy();
    expect(screen.getByText("plain note")).toBeTruthy();
  });

  test("info tone applies the info class (cyan, not a status warning)", () => {
    const { container } = render(Callout, { tone: "info", children: text("fyi") });
    expect(container.querySelector(".callout.info")).toBeTruthy();
    expect(container.querySelector(".callout.warn")).toBeNull();
  });

  test("warn tone applies the warn class — amber, never red", () => {
    const { container } = render(Callout, { tone: "warn", title: "Heads up", children: text("careful") });
    expect(container.querySelector(".callout.warn")).toBeTruthy();
    // Meaning is carried by the title too, not hue alone.
    expect(screen.getByText("Heads up")).toBeTruthy();
  });

  test("title and icon render alongside the body", () => {
    const { container } = render(Callout, { icon: "alert", title: "Title", children: text("body") });
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  test("role passes through for error/status announcements", () => {
    const { container } = render(Callout, { tone: "warn", role: "alert", children: text("boom") });
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });
});
