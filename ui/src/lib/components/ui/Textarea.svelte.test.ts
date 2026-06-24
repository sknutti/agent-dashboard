// Textarea primitive — rows + placeholder reach the element; bind:value
// round-trips via oninput; disabled sets the attribute.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import Textarea from "./Textarea.svelte";

afterEach(cleanup);

const ta = () => document.querySelector("textarea") as HTMLTextAreaElement;

describe("Textarea", () => {
  test("renders value, rows and placeholder", () => {
    render(Textarea, { value: "hello", rows: 8, placeholder: "type…" });
    expect(ta().value).toBe("hello");
    expect(ta().rows).toBe(8);
    expect(ta().placeholder).toBe("type…");
  });

  test("typing fires oninput (bind:value round-trip)", async () => {
    const oninput = vi.fn();
    render(Textarea, { placeholder: "body", oninput });
    await fireEvent.input(ta(), { target: { value: "line" } });
    expect(ta().value).toBe("line");
    expect(oninput).toHaveBeenCalledOnce();
  });

  test("disabled sets the attribute", () => {
    render(Textarea, { disabled: true });
    expect(ta().disabled).toBe(true);
  });
});
