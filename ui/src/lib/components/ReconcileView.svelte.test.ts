// Component coverage for the Reconcile view (bootstrap slice — the `forget`
// home). Renders ReconcileView directly and mocks the forget fetcher. The
// load-bearing behaviors: the empty state when there are no orphans; the
// two-phase confirm (the row button only REVEALS a confirm — no call fires until
// the second, confirm-step button); and onForgotten firing after a forget.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import ReconcileView from "./ReconcileView.svelte";
import * as api from "../api";
import type { OrphanInstall } from "../library";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ORPHANS: OrphanInstall[] = [{ kind: "agent", name: "ghost", targets: ["claude", "pi"] }];

describe("ReconcileView", () => {
  test("no orphans → the empty 'nothing to reconcile' state", () => {
    render(ReconcileView, { orphans: [], onForgotten: vi.fn() });
    expect(screen.getByText(/nothing to reconcile/i)).toBeTruthy();
  });

  test("an orphan row shows the name, kind, and its install targets", () => {
    render(ReconcileView, { orphans: ORPHANS, onForgotten: vi.fn() });
    expect(screen.getByText("ghost")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("pi")).toBeTruthy();
  });

  test("forget is two-phase: the row button reveals a confirm; only the confirm fires the call", async () => {
    const forget = vi.spyOn(api, "forgetPrimitive").mockResolvedValue({ removed: true });
    const onForgotten = vi.fn();
    render(ReconcileView, { orphans: ORPHANS, onForgotten });

    // First click: reveal the confirm — NO api call yet (two-phase D2).
    await fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    expect(forget).not.toHaveBeenCalled();
    expect(screen.getByText(/forget all 2 records/i)).toBeTruthy();

    // Confirm: fires forgetPrimitive(kind, name) against the snapshot + notifies.
    await fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    await waitFor(() => expect(forget).toHaveBeenCalledWith("agent", "ghost"));
    expect(onForgotten).toHaveBeenCalled();
    expect(screen.getByText(/forgot agent\/ghost/i)).toBeTruthy();
  });

  test("Cancel backs out of the confirm without forgetting", async () => {
    const forget = vi.spyOn(api, "forgetPrimitive").mockResolvedValue({ removed: true });
    render(ReconcileView, { orphans: ORPHANS, onForgotten: vi.fn() });
    await fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    await fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(forget).not.toHaveBeenCalled();
    // back to the row's Forget button
    expect(screen.getByRole("button", { name: /^forget$/i })).toBeTruthy();
  });
});
