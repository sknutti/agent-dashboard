// Field primitive — renders the label, hint and error; the label's `for`
// associates it with the control (so the child Input gets a real <label>); the
// error carries role="alert" (and amber text — never red-alone, CVD); hint and
// error are omitted when not provided.

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import Field from "./Field.svelte";
import { textSnippet } from "./snippet-test-helper";

afterEach(cleanup);

describe("Field", () => {
  test("renders label, hint and error", () => {
    render(Field, { label: "Author", hint: "Optional", error: "Required" });
    expect(screen.getByText("Author")).toBeTruthy();
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
  });

  test("error carries role=alert", () => {
    render(Field, { label: "Name", error: "Too long" });
    expect(screen.getByRole("alert").textContent).toBe("Too long");
  });

  test("`for` associates the label with the control", () => {
    render(Field, { label: "Title", for: "title-input" });
    const label = screen.getByText("Title") as HTMLLabelElement;
    expect(label.getAttribute("for")).toBe("title-input");
  });

  test("omits hint/error when not provided", () => {
    render(Field, { label: "Bare", children: textSnippet("control") });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
