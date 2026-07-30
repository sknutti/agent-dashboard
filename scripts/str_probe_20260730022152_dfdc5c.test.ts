import { expect, test, describe } from "bun:test";
import { capitalize } from "./str_probe_20260730022152_dfdc5c.ts";

describe("capitalize", () => {
  test("returns unchanged string when empty (empty-string)", () => {
    expect(capitalize("")).toBe("");
  });

  test("capitalizes first character of lowercase word (lowercase-word)", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  test("returns unchanged string when already capitalized (already-capitalized)", () => {
    expect(capitalize("Hello")).toBe("Hello");
  });
});
