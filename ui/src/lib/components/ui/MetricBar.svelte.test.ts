// MetricBar: single-fill meter or value-proportional stacked bar. Widths must be
// clamped (never NaN/Infinity from a zero max), segment flex must equal the
// passed value, and the bar exposes role="img" + aria-label for the quantity.

import { describe, test, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import MetricBar from "./MetricBar.svelte";

afterEach(() => { cleanup(); });

describe("MetricBar", () => {
  test("single fill width is value/max as a percentage", () => {
    const { container } = render(MetricBar, { value: 3, max: 4 });
    const fill = container.querySelector(".fill") as HTMLElement;
    expect(fill.style.width).toBe("75%");
  });

  test("fill clamps above max to 100% and below 0 to 0%", () => {
    const over = render(MetricBar, { value: 10, max: 4 });
    expect((over.container.querySelector(".fill") as HTMLElement).style.width).toBe("100%");
    cleanup();
    const under = render(MetricBar, { value: -2, max: 4 });
    expect((under.container.querySelector(".fill") as HTMLElement).style.width).toBe("0%");
  });

  test("a zero max never produces NaN — fill is 0%", () => {
    const { container } = render(MetricBar, { value: 5, max: 0 });
    expect((container.querySelector(".fill") as HTMLElement).style.width).toBe("0%");
  });

  test("segments render a stacked bar with flex proportional to value", () => {
    const { container } = render(MetricBar, {
      segments: [
        { value: 2, color: "var(--tok-output)" },
        { value: 6, color: "var(--tok-input)" },
      ],
    });
    const segs = container.querySelectorAll(".seg");
    expect(segs.length).toBe(2);
    expect((segs[0] as HTMLElement).style.flexGrow).toBe("2");
    expect((segs[1] as HTMLElement).style.flexGrow).toBe("6");
    // No single fill when stacked.
    expect(container.querySelector(".fill")).toBeNull();
  });

  test("zero-value segments collapse out of the stack", () => {
    const { container } = render(MetricBar, {
      segments: [
        { value: 0, color: "var(--tok-output)" },
        { value: 4, color: "var(--tok-input)" },
      ],
    });
    expect(container.querySelectorAll(".seg").length).toBe(1);
  });

  test("exposes role=img and the aria-label for the quantitative meaning", () => {
    const { container } = render(MetricBar, { value: 1, max: 2, ariaLabel: "50% used" });
    const bar = container.querySelector(".bar") as HTMLElement;
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toBe("50% used");
  });
});
