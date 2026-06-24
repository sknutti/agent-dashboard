// Input primitive — `type` and `ariaLabel` reach the element; bind:value
// round-trips (typing updates the bound value, and an external value renders);
// disabled sets the attribute; oninput fires.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Input from "./Input.svelte";

afterEach(cleanup);

describe("Input", () => {
  test("ariaLabel + type reach the element; value renders", () => {
    render(Input, { ariaLabel: "Email", type: "email", value: "a@b.co" });
    const el = screen.getByLabelText("Email") as HTMLInputElement;
    expect(el.type).toBe("email");
    expect(el.value).toBe("a@b.co");
  });

  test("typing fires oninput (bind:value round-trip)", async () => {
    const oninput = vi.fn();
    render(Input, { ariaLabel: "Name", oninput });
    const el = screen.getByLabelText("Name") as HTMLInputElement;
    await fireEvent.input(el, { target: { value: "Scott" } });
    expect(el.value).toBe("Scott");
    expect(oninput).toHaveBeenCalledOnce();
  });

  // Guards against a `bind:value` → one-way `value={value}` regression: the DOM
  // value would still update (so the round-trip test above stays green) but the
  // PARENT state would silently stop tracking. This asserts the parent itself.
  test("bind:value writes back to the parent ($bindable, not one-way)", async () => {
    let parent = $state("");
    render(Input, {
      ariaLabel: "Bound",
      get value() { return parent; },
      set value(v) { parent = v; },
    });
    await fireEvent.input(screen.getByLabelText("Bound"), { target: { value: "wrote-back" } });
    expect(parent).toBe("wrote-back");
  });

  test("disabled sets the attribute", () => {
    render(Input, { ariaLabel: "Locked", disabled: true });
    expect((screen.getByLabelText("Locked") as HTMLInputElement).disabled).toBe(true);
  });

  test("placeholder is applied", () => {
    render(Input, { ariaLabel: "Search", placeholder: "Find…" });
    expect((screen.getByLabelText("Search") as HTMLInputElement).placeholder).toBe("Find…");
  });
});
