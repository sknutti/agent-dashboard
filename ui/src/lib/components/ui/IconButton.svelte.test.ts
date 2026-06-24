// IconButton primitive — `label` is required and becomes both the accessible
// name (aria-label) and the title; variant lands as a class; onclick fires; and
// the size prop drives the inline width/height so callers can size affordances.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import IconButton from "./IconButton.svelte";

afterEach(cleanup);

describe("IconButton", () => {
  test("label sets the accessible name (aria-label)", () => {
    render(IconButton, { icon: "x", label: "Close" });
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn.getAttribute("aria-label")).toBe("Close");
  });

  test("variant lands as a class", () => {
    render(IconButton, { icon: "x", label: "Close", variant: "ghost" });
    expect(screen.getByRole("button", { name: "Close" }).classList.contains("ghost")).toBe(true);
  });

  test("size drives the inline width/height", () => {
    render(IconButton, { icon: "x", label: "Info", size: 26 });
    const btn = screen.getByRole("button", { name: "Info" });
    expect(btn.style.width).toBe("26px");
    expect(btn.style.height).toBe("26px");
  });

  test("onclick fires when enabled", async () => {
    const onclick = vi.fn();
    render(IconButton, { icon: "x", label: "Go", onclick });
    await fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onclick).toHaveBeenCalledOnce();
  });

  test("disabled sets the attribute AND blocks onclick", async () => {
    const onclick = vi.fn();
    render(IconButton, { icon: "x", label: "Off", disabled: true, onclick });
    const btn = screen.getByRole("button", { name: "Off" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn); // programmatic dispatch bypasses native disabled
    expect(onclick).not.toHaveBeenCalled(); // the handler guard still blocks it
  });
});
