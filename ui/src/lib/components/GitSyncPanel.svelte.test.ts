// Component coverage for the git remote sync panel (Slice 8). Renders
// GitSyncPanel directly (named *.svelte.test.ts so runes + resource() compile)
// and mocks the /api/library/git/* fetchers. Load-bearing behaviors: the panel
// shows the current remote + the REDACTED PAT (the raw token never renders — D6);
// configuring an invalid URL shows an inline field error; the PAT input is
// write-only (cleared after save); push runs the secret-scan gate FIRST and only
// pushes after an explicit confirm when there are findings (D4); a clean scan
// pushes straight through; and a pull conflict swaps to the resolver.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import GitSyncPanel from "./GitSyncPanel.svelte";
import * as api from "../api";
import { LibraryApiError } from "../api";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0;
});

const RAW_PAT = "ghp_RAWtokenNEVERrendered0123456789abcd";
const REDACTED = "ghp_••••••••abcd";

function mount(over: { remote_url?: string | null; pat_redacted?: string | null; count?: number } = {}) {
  // Use `in` checks so an explicit `null` is honored (a `?? default` would treat
  // null as "unset" and wrongly fall back to the configured default).
  vi.spyOn(api, "getGitStatus").mockResolvedValue({
    remote_url: "remote_url" in over ? (over.remote_url ?? null) : "https://github.com/o/r",
    pat_redacted: "pat_redacted" in over ? (over.pat_redacted ?? null) : REDACTED,
  });
  vi.spyOn(api, "getUnpushedCount").mockResolvedValue({ count: over.count ?? 2 });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const r = render(GitSyncPanel, { libraryPath: null, onClose, onChanged });
  return { ...r, onChanged, onClose };
}

describe("GitSyncPanel — status + the PAT redaction discipline (D6)", () => {
  test("shows the current remote and the REDACTED pat; the raw token never renders", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("current-remote").textContent).toContain("github.com/o/r"));
    expect(screen.getByTestId("pat-redacted").textContent).toContain(REDACTED);
    // the raw token appears nowhere in the DOM
    expect(document.body.textContent).not.toContain(RAW_PAT);
  });

  test("the PAT input is write-only — type=password, cleared after save, raw never shown", async () => {
    mount({ pat_redacted: null });
    const setPat = vi.spyOn(api, "setRemotePat").mockResolvedValue({});
    const input = (await screen.findByTestId("pat-input")) as HTMLInputElement;
    expect(input.type).toBe("password");
    await fireEvent.input(input, { target: { value: RAW_PAT } });
    await fireEvent.click(screen.getByRole("button", { name: /^store$/i }));
    expect(setPat).toHaveBeenCalledWith(RAW_PAT);
    await waitFor(() => expect(input.value).toBe("")); // cleared, never retained
    expect(document.body.textContent).not.toContain(RAW_PAT);
  });
});

describe("GitSyncPanel — configure remote", () => {
  test("an invalid URL surfaces an inline field error, not a generic toast", async () => {
    mount({ remote_url: null });
    vi.spyOn(api, "configureRemote").mockRejectedValue(
      new LibraryApiError("invalid_remote_url", "invalid remote URL"),
    );
    const input = (await screen.findByTestId("remote-url-input")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "http://evil" } });
    await fireEvent.click(screen.getByRole("button", { name: /set remote/i }));
    await waitFor(() => expect(screen.getByTestId("url-error").textContent).toContain("invalid remote URL"));
    expect(screen.queryByTestId("git-error")).toBeNull(); // field error, not the general error slot
  });
});

describe("GitSyncPanel — push gate (D4)", () => {
  test("findings BLOCK the push until an explicit confirm", async () => {
    mount();
    const scan = vi
      .spyOn(api, "scanBeforePush")
      .mockResolvedValue([{ path: "CLAUDE.md", line: 1, kind: "github_classic_pat", matched: "ghp_planted" }]);
    const push = vi.spyOn(api, "gitPush").mockResolvedValue({});

    await waitFor(() => screen.getByTestId("push-btn"));
    await fireEvent.click(screen.getByTestId("push-btn"));

    // the gate is shown with the finding, and push has NOT been called
    await waitFor(() => expect(screen.getByTestId("push-gate")).toBeTruthy());
    expect(screen.getByTestId("push-gate").textContent).toContain("CLAUDE.md:1");
    expect(scan).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    // confirm → now it pushes
    await fireEvent.click(screen.getByTestId("push-anyway"));
    expect(push).toHaveBeenCalled();
  });

  test("a clean scan pushes straight through (no gate)", async () => {
    mount();
    vi.spyOn(api, "scanBeforePush").mockResolvedValue([]);
    const push = vi.spyOn(api, "gitPush").mockResolvedValue({});
    await waitFor(() => screen.getByTestId("push-btn"));
    await fireEvent.click(screen.getByTestId("push-btn"));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(screen.queryByTestId("push-gate")).toBeNull();
  });
});

describe("GitSyncPanel — pull", () => {
  test("a conflict outcome swaps to the conflict resolver", async () => {
    mount();
    vi.spyOn(api, "gitPull").mockResolvedValue({ outcome: "conflict", conflict_count: 1 });
    vi.spyOn(api, "listPullConflicts").mockResolvedValue([{ path: "notes.txt", kind: "other" }]);
    await waitFor(() => screen.getByTestId("pull-btn"));
    await fireEvent.click(screen.getByTestId("pull-btn"));
    await waitFor(() => expect(screen.getByTestId("conflict-resolver")).toBeTruthy());
  });

  test("a clean pull reloads and stays out of conflict mode", async () => {
    const { onChanged } = mount();
    vi.spyOn(api, "gitPull").mockResolvedValue({ outcome: "ok" });
    await waitFor(() => screen.getByTestId("pull-btn"));
    await fireEvent.click(screen.getByTestId("pull-btn"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-resolver")).toBeNull();
  });
});
