// Button primitive — the public contract: it renders its children; variant/size
// land on the element as classes (the migration & gate depend on these); disabled
// AND loading both block onclick; loading also disables; and href flips it to an
// anchor that has no `disabled`/`type` attribute.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Button from "./Button.svelte";
import { textSnippet } from "./snippet-test-helper";

afterEach(cleanup);

describe("Button", () => {
  test("renders children inside a <button> of type button by default", () => {
    render(Button, { children: textSnippet("Save") });
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
  });

  test("variant + size produce their classes", () => {
    render(Button, { variant: "primary", size: "sm", children: textSnippet("Go") });
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.classList.contains("primary")).toBe(true);
    expect(btn.classList.contains("sm")).toBe(true);
  });

  test("disabled sets the attribute and blocks onclick", async () => {
    const onclick = vi.fn();
    render(Button, { disabled: true, onclick, children: textSnippet("X") });
    const btn = screen.getByRole("button", { name: "X" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn);
    expect(onclick).not.toHaveBeenCalled();
  });

  test("loading disables the button and blocks onclick", async () => {
    const onclick = vi.fn();
    render(Button, { loading: true, onclick, children: textSnippet("Saving") });
    const btn = screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn);
    expect(onclick).not.toHaveBeenCalled();
  });

  test("enabled button fires onclick", async () => {
    const onclick = vi.fn();
    render(Button, { onclick, children: textSnippet("Click") });
    await fireEvent.click(screen.getByRole("button", { name: "Click" }));
    expect(onclick).toHaveBeenCalledOnce();
  });

  test("href renders an <a> with no disabled/type attribute", () => {
    render(Button, { href: "/x", children: textSnippet("Link") });
    const link = screen.getByRole("link", { name: "Link" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/x");
    expect(link.hasAttribute("type")).toBe(false);
    expect(link.hasAttribute("disabled")).toBe(false);
  });
});
