import { expect, test, describe } from "bun:test";
import { truncate } from "./str_truncate.ts";

describe("truncate", () => {
  test("returns unchanged string when shorter than max (shorter-than-max)", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("returns unchanged string when exactly max length (exactly-max)", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("truncates string when longer than max (longer-than-max)", () => {
    expect(truncate("hello world", 5)).toBe("hello");
  });

  test("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });

  test("truncates to zero length", () => {
    expect(truncate("hello", 0)).toBe("");
  });

  test("handles special characters", () => {
    expect(truncate("hello🌍world", 5)).toBe("hello");
  });
});
