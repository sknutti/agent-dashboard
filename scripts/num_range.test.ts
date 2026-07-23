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

  test("handles boundary cases: n equals min", () => {
    expect(clamp(10, 10, 20)).toBe(10);
  });

  test("handles boundary cases: n equals max", () => {
    expect(clamp(20, 10, 20)).toBe(20);
  });

  test("handles negative numbers", () => {
    expect(clamp(-15, -10, 0)).toBe(-10);
    expect(clamp(-5, -10, 0)).toBe(-5);
    expect(clamp(5, -10, 0)).toBe(0);
  });

  test("handles floating point numbers", () => {
    expect(clamp(5.5, 10.1, 20.9)).toBe(10.1);
    expect(clamp(15.5, 10.1, 20.9)).toBe(15.5);
    expect(clamp(25.5, 10.1, 20.9)).toBe(20.9);
  });
});
