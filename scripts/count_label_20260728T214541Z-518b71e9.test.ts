import { expect, test, describe } from "bun:test";
import { countLabel } from "./count_label_20260728T214541Z-518b71e9.ts";

describe("countLabel", () => {
  test("returns singular form when n is exactly 1 (singular)", () => {
    expect(countLabel(1, "item")).toBe("1 item");
  });

  test("returns plural form when n is greater than 1 (plural)", () => {
    expect(countLabel(3, "item")).toBe("3 items");
  });

  test("returns plural form for large counts (large-count)", () => {
    expect(countLabel(100, "file")).toBe("100 files");
  });

  test("returns 'no' form when n is 0 (empty-state)", () => {
    expect(countLabel(0, "item")).toBe("no items");
  });

  test("handles different nouns (various-nouns)", () => {
    expect(countLabel(1, "file")).toBe("1 file");
    expect(countLabel(2, "file")).toBe("2 files");
    expect(countLabel(0, "file")).toBe("no files");
  });

  test("handles nouns with multiple characters (long-noun)", () => {
    expect(countLabel(1, "session")).toBe("1 session");
    expect(countLabel(5, "session")).toBe("5 sessions");
  });
});
