import { expect, test, describe } from "bun:test";
import { clamp } from "./num_range.ts";

describe("clamp", () => {
  test("returns min when n < min (below-range)", () => {
    expect(clamp(5, 10, 20)).toBe(10);
  });

  test("returns n when min <= n <= max (in-range)", () => {
    expect(clamp(15, 10, 20)).toBe(15);
  });

  test("returns max when n > max (above-range)", () => {
    expect(clamp(25, 10, 20)).toBe(20);
  });

  test("returns n when n equals min (boundary)", () => {
    expect(clamp(10, 10, 20)).toBe(10);
  });

  test("returns n when n equals max (boundary)", () => {
    expect(clamp(20, 10, 20)).toBe(20);
  });

  test("works with negative numbers", () => {
    expect(clamp(-5, -10, 0)).toBe(-5);
    expect(clamp(-15, -10, 0)).toBe(-10);
    expect(clamp(5, -10, 0)).toBe(0);
  });

  test("works with decimal numbers", () => {
    expect(clamp(3.5, 1.0, 5.0)).toBe(3.5);
    expect(clamp(0.5, 1.0, 5.0)).toBe(1.0);
    expect(clamp(5.5, 1.0, 5.0)).toBe(5.0);
  });
});
