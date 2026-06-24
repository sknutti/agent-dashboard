// Select primitive — accepts bare-string OR {value,label} options and normalizes
// both; bind:value round-trips (selecting fires onchange + updates value); the
// initial value selects the matching option; disabled sets the attribute.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Select from "./Select.svelte";

afterEach(cleanup);

describe("Select", () => {
  test("normalizes string options and selects the initial value", () => {
    render(Select, { options: ["today", "7d", "30d"], value: "7d", ariaLabel: "Range" });
    const el = screen.getByLabelText("Range") as HTMLSelectElement;
    expect(el.value).toBe("7d");
    expect([...el.options].map((o) => o.textContent)).toEqual(["today", "7d", "30d"]);
  });

  test("normalizes {value,label} options (label shown, value bound)", () => {
    render(Select, {
      options: [{ value: "c", label: "Claude" }, { value: "p", label: "Pi" }],
      value: "c",
      ariaLabel: "Target",
    });
    const el = screen.getByLabelText("Target") as HTMLSelectElement;
    expect([...el.options].map((o) => o.value)).toEqual(["c", "p"]);
    expect([...el.options].map((o) => o.textContent)).toEqual(["Claude", "Pi"]);
  });

  test("changing the selection fires onchange and round-trips value", async () => {
    const onchange = vi.fn();
    render(Select, { options: ["a", "b"], value: "a", ariaLabel: "Pick", onchange });
    const el = screen.getByLabelText("Pick") as HTMLSelectElement;
    await fireEvent.change(el, { target: { value: "b" } });
    expect(el.value).toBe("b");
    expect(onchange).toHaveBeenCalledOnce();
  });

  // Parent write-back guard (see Input test) — bind:value must be two-way.
  test("bind:value writes back to the parent ($bindable, not one-way)", async () => {
    let parent = $state("a");
    render(Select, {
      options: ["a", "b"],
      ariaLabel: "Bound",
      get value() { return parent; },
      set value(v) { parent = v; },
    });
    await fireEvent.change(screen.getByLabelText("Bound"), { target: { value: "b" } });
    expect(parent).toBe("b");
  });

  test("disabled sets the attribute", () => {
    render(Select, { options: ["a"], disabled: true, ariaLabel: "Locked" });
    expect((screen.getByLabelText("Locked") as HTMLSelectElement).disabled).toBe(true);
  });
});
