// Checkbox primitive — renders a native checkbox labelled by `label` (or the
// children snippet); bind:checked round-trips (clicking toggles + fires
// onchange); the initial checked state renders; disabled sets the attribute.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Checkbox from "./Checkbox.svelte";
import { textSnippet } from "./snippet-test-helper";

afterEach(cleanup);

describe("Checkbox", () => {
  test("renders a checkbox labelled by `label`, reflecting initial checked", () => {
    render(Checkbox, { label: "Include", checked: true });
    const box = screen.getByRole("checkbox", { name: "Include" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  test("label can come from the children snippet", () => {
    render(Checkbox, { children: textSnippet("Overlay") });
    expect(screen.getByRole("checkbox", { name: "Overlay" })).toBeTruthy();
  });

  test("clicking toggles checked and fires onchange (bind:checked round-trip)", async () => {
    const onchange = vi.fn();
    render(Checkbox, { label: "T", checked: false, onchange });
    const box = screen.getByRole("checkbox", { name: "T" }) as HTMLInputElement;
    await fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(onchange).toHaveBeenCalledOnce();
  });

  // Parent write-back guard (see Input test) — proves bind:checked is two-way,
  // not a one-way `checked={checked}` that would leave parent state stale.
  test("bind:checked writes back to the parent ($bindable, not one-way)", async () => {
    let parent = $state(false);
    render(Checkbox, {
      label: "B",
      get checked() { return parent; },
      set checked(v) { parent = v; },
    });
    await fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
    expect(parent).toBe(true);
  });

  test("disabled sets the attribute", () => {
    render(Checkbox, { label: "L", disabled: true });
    expect((screen.getByRole("checkbox", { name: "L" }) as HTMLInputElement).disabled).toBe(true);
  });
});
