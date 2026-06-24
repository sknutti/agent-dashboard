// Stat: label / value / sub figure cluster. Renders all three pieces, switches
// the value to the `.u-big` utility when `big`, and `tone` colours the value via
// a tone class (decorative — never the sole carrier of meaning).

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import Stat from "./Stat.svelte";

afterEach(() => { cleanup(); });

describe("Stat", () => {
  test("renders label, value, and sub", () => {
    render(Stat, { label: "Sessions", value: 42, sub: "this week" });
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("this week")).toBeTruthy();
  });

  test("big uses the .u-big utility, default uses .big sizing", () => {
    const { container } = render(Stat, { value: "1.2k", big: true });
    const v = container.querySelector(".value") as HTMLElement;
    expect(v.classList.contains("u-big")).toBe(true);
    expect(v.classList.contains("big")).toBe(false);
    cleanup();
    const small = render(Stat, { value: "9" });
    const sv = small.container.querySelector(".value") as HTMLElement;
    expect(sv.classList.contains("big")).toBe(true);
    expect(sv.classList.contains("u-big")).toBe(false);
  });

  test("mono on by default, off when mono=false", () => {
    const on = render(Stat, { value: "7" });
    expect((on.container.querySelector(".value") as HTMLElement).classList.contains("u-mono")).toBe(true);
    cleanup();
    const off = render(Stat, { value: "7", mono: false });
    expect((off.container.querySelector(".value") as HTMLElement).classList.contains("u-mono")).toBe(false);
  });

  test("tone applies the matching class to the value only", () => {
    const { container } = render(Stat, { value: "$3.40", tone: "amber" });
    expect((container.querySelector(".value") as HTMLElement).classList.contains("amber")).toBe(true);
  });

  test("value-only (no label/sub) renders just the figure", () => {
    render(Stat, { value: "100%" });
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
