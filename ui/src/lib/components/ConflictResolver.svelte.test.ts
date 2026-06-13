// Component coverage for the pull-conflict resolver (Slice 8). Mocks the
// /api/library/git/* conflict fetchers. Load-bearing behaviors: it lists the
// conflicts, Continue is disabled until every file is resolved, picking a side
// calls resolveConflict, a clean continue calls onResolved, a still_conflicted
// continue reloads the list (the resolver loops), and Cancel aborts.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/svelte";
import ConflictResolver from "./ConflictResolver.svelte";
import * as api from "../api";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0;
});

function mount(conflicts: api.LibraryConflictEntry[]) {
  vi.spyOn(api, "listPullConflicts").mockResolvedValue(conflicts);
  // resolvable rows fetch both sides; stub them so ConflictRow renders.
  vi.spyOn(api, "readConflictBlob").mockImplementation((_p, side) =>
    Promise.resolve({ content: side === "local" ? "local text\n" : "remote text\n" }),
  );
  const onResolved = vi.fn();
  const onAborted = vi.fn();
  const r = render(ConflictResolver, { libraryPath: "/lib", onResolved, onAborted });
  return { ...r, onResolved, onAborted };
}

describe("ConflictResolver", () => {
  test("Continue is disabled until every conflict is resolved", async () => {
    mount([
      { path: "a/metadata.yaml", kind: "metadata_yaml" },
      { path: "notes.txt", kind: "other" },
    ]);
    const resolve = vi.spyOn(api, "resolveConflict").mockResolvedValue({});
    await waitFor(() => screen.getByTestId("continue-pull"));
    const cont = () => screen.getByTestId("continue-pull") as HTMLButtonElement;
    expect(cont().disabled).toBe(true);

    // resolve the first (metadata) row via its value-picker (its first button is
    // "Use Local").
    const rows = await screen.findAllByTestId("conflict-row");
    await fireEvent.click(rows[0]!.querySelector("button")!); // Use Local
    expect(resolve).toHaveBeenCalledWith("a/metadata.yaml", "local");
    expect(cont().disabled).toBe(true); // one still unresolved

    // resolve the second (escape-hatch) row — scope the query to that row so the
    // metadata row's own "Use Remote" picker doesn't collide.
    const escapeRemote = within(rows[1]!).getByRole("button", { name: /use remote/i });
    await fireEvent.click(escapeRemote);
    await waitFor(() => expect(cont().disabled).toBe(false));
  });

  test("a clean Continue (done) calls onResolved", async () => {
    const { onResolved } = mount([{ path: "notes.txt", kind: "other" }]);
    vi.spyOn(api, "resolveConflict").mockResolvedValue({});
    vi.spyOn(api, "continuePull").mockResolvedValue({ outcome: "done" });
    await screen.findAllByTestId("conflict-row");
    await fireEvent.click(screen.getByRole("button", { name: /use local/i }));
    await waitFor(() => expect((screen.getByTestId("continue-pull") as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(screen.getByTestId("continue-pull"));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  test("a still_conflicted Continue reloads the list and loops (does NOT resolve)", async () => {
    const { onResolved } = mount([{ path: "notes.txt", kind: "other" }]);
    vi.spyOn(api, "resolveConflict").mockResolvedValue({});
    const cont = vi.spyOn(api, "continuePull").mockResolvedValue({ outcome: "still_conflicted", conflict_count: 1 });
    const list = vi.spyOn(api, "listPullConflicts");
    await screen.findAllByTestId("conflict-row");
    await fireEvent.click(screen.getByRole("button", { name: /use local/i }));
    await waitFor(() => expect((screen.getByTestId("continue-pull") as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(screen.getByTestId("continue-pull"));
    await waitFor(() => expect(cont).toHaveBeenCalled());
    // list reloaded for round two; not resolved
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    expect(onResolved).not.toHaveBeenCalled();
  });

  test("Cancel aborts the rebase", async () => {
    const { onAborted } = mount([{ path: "notes.txt", kind: "other" }]);
    const abort = vi.spyOn(api, "abortPull").mockResolvedValue({});
    await waitFor(() => screen.getByTestId("abort-pull"));
    await fireEvent.click(screen.getByTestId("abort-pull"));
    await waitFor(() => expect(abort).toHaveBeenCalled());
    expect(onAborted).toHaveBeenCalled();
  });
});
