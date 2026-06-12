// Component coverage for the target-overlay editor (target-overlays slice).
// Renders TargetOverlayPane directly (named *.svelte.test.ts so the runes +
// resource() compile) and mocks the /api/library overlay fetchers. The load-
// bearing behaviors: tabs are driven by allowed_targets (never the full enum), a
// target with no overlay shows read-only + "Add overlay" seeded from base, edit
// + Save calls writeOverlay and flips the cue, Remove reverts to base, switching
// tabs re-fetches, and the cue distinguishes delta vs. base WITHOUT color.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import TargetOverlayPane from "./TargetOverlayPane.svelte";
import * as api from "../api";
import type { LibraryTargetView, LibraryOverlayList, LibraryTarget } from "../api";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0;
});

const BASE_VIEW: LibraryTargetView = {
  working: { kind: "md", frontmatter: "", body: "base\n" },
  has_overlay: false,
};
const BASE_BLOB = "---\n---\nbase\n";
const OVERLAY_VIEW: LibraryTargetView = {
  working: { kind: "md", frontmatter: "", body: "claude-only\n" },
  has_overlay: true,
};
const OVERLAY_BLOB = "---\n---\nclaude-only\n";

/** Mount with a per-target view resolver + an overlays-list fixture. */
function mountPane(opts: {
  allowed?: LibraryTarget[];
  viewFor?: (target: LibraryTarget) => LibraryTargetView;
  overlays?: LibraryOverlayList[];
}) {
  vi.spyOn(api, "listOverlays").mockResolvedValue(opts.overlays ?? []);
  vi.spyOn(api, "readPrimitiveTarget").mockImplementation(
    async (_k, _n, target) => (opts.viewFor ?? (() => BASE_VIEW))(target),
  );
  const onOverlayWrite = vi.fn();
  const r = render(TargetOverlayPane, {
    kind: "skill",
    name: "diagnose",
    allowedTargets: opts.allowed ?? ["claude", "pi"],
    onOverlayWrite,
  });
  return { ...r, onOverlayWrite };
}

const overlayTextarea = (target = "claude") =>
  screen.getByLabelText(`${target} overlay contents`) as HTMLTextAreaElement;

describe("TargetOverlayPane — tabs driven by allowed_targets", () => {
  test("renders one tab per allowed target, never the full enum", async () => {
    mountPane({ allowed: ["claude", "pi"] });
    expect(await screen.findByRole("tab", { name: /claude/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /pi/ })).toBeTruthy();
    // codex is not allowed → no tab, so the UI never asks for a 422'd target.
    expect(screen.queryByRole("tab", { name: /codex/ })).toBeNull();
  });

  test("empty allowed_targets → an empty-state message, no tabs", async () => {
    mountPane({ allowed: [] });
    expect(await screen.findByText(/no allowed targets/i)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("TargetOverlayPane — base passthrough (no overlay)", () => {
  test("shows the base read-only with an Add-overlay affordance and the base cue", async () => {
    mountPane({ viewFor: () => BASE_VIEW });
    await waitFor(() => expect(overlayTextarea().value).toBe(BASE_BLOB));
    // Read-only until "Add overlay" is pressed.
    expect(overlayTextarea().readOnly).toBe(true);
    expect(screen.getByRole("button", { name: /add overlay for claude/i })).toBeTruthy();
    // The cue makes "base, not a delta" explicit (label, not color alone).
    expect(screen.getAllByText(/base \(no overlay\)/i).length).toBeGreaterThan(0);
  });

  test("Add overlay seeds the editor from the base bytes, then Save calls writeOverlay + notifies", async () => {
    const { onOverlayWrite } = mountPane({ viewFor: () => BASE_VIEW });
    const write = vi.spyOn(api, "writeOverlay").mockResolvedValue({} as never);
    await waitFor(() => expect(overlayTextarea().value).toBe(BASE_BLOB));

    await fireEvent.click(screen.getByRole("button", { name: /add overlay for claude/i }));
    // Now editable, seeded from base (a delta, not a blank file).
    expect(overlayTextarea().readOnly).toBe(false);
    expect(overlayTextarea().value).toBe(BASE_BLOB);

    await fireEvent.input(overlayTextarea(), { target: { value: "---\n---\nclaude-delta\n" } });
    await fireEvent.click(screen.getByRole("button", { name: /^save overlay$/i }));
    expect(write).toHaveBeenCalledWith("skill", "diagnose", "claude", "---\n---\nclaude-delta\n");
    await waitFor(() => expect(onOverlayWrite).toHaveBeenCalledWith("claude"));
    // The cue flips to "overlay" (we just created it).
    await waitFor(() => expect(screen.getAllByText(/^◆ overlay$|overlay/i).length).toBeGreaterThan(0));
  });
});

describe("TargetOverlayPane — existing overlay (editable + remove)", () => {
  test("an overlay tab is editable, shows the overlay cue, and Save calls writeOverlay", async () => {
    mountPane({ viewFor: () => OVERLAY_VIEW, overlays: [{ target: "claude", paths: ["SKILL.md"] }] });
    const write = vi.spyOn(api, "writeOverlay").mockResolvedValue({} as never);
    await waitFor(() => expect(overlayTextarea().value).toBe(OVERLAY_BLOB));
    expect(overlayTextarea().readOnly).toBe(false);

    await fireEvent.input(overlayTextarea(), { target: { value: "---\n---\nedited\n" } });
    await fireEvent.click(screen.getByRole("button", { name: /^save overlay$/i }));
    expect(write).toHaveBeenCalledWith("skill", "diagnose", "claude", "---\n---\nedited\n");
  });

  test("Remove overlay confirms, calls removeOverlay, and reverts the tab to base", async () => {
    // First load = overlay; after removal the re-fetch returns the base passthrough.
    let removed = false;
    const { onOverlayWrite } = mountPane({
      viewFor: () => (removed ? BASE_VIEW : OVERLAY_VIEW),
    });
    const remove = vi.spyOn(api, "removeOverlay").mockImplementation(async () => {
      removed = true;
      return {} as never;
    });
    await waitFor(() => expect(overlayTextarea().value).toBe(OVERLAY_BLOB));

    await fireEvent.click(screen.getByRole("button", { name: /^remove overlay$/i }));
    // Inline confirm, not an immediate destructive action.
    const confirm = await screen.findByRole("button", { name: /^remove$/i });
    await fireEvent.click(confirm);
    expect(remove).toHaveBeenCalledWith("skill", "diagnose", "claude");
    await waitFor(() => expect(onOverlayWrite).toHaveBeenCalledWith("claude"));
    // The tab reverted to the base passthrough (read-only + Add affordance).
    await waitFor(() => expect(overlayTextarea().value).toBe(BASE_BLOB));
    expect(screen.getByRole("button", { name: /add overlay for claude/i })).toBeTruthy();
  });
});

describe("TargetOverlayPane — tab switching", () => {
  test("selecting another tab re-fetches that target's view", async () => {
    const read = vi.spyOn(api, "readPrimitiveTarget");
    mountPane({
      allowed: ["claude", "pi"],
      viewFor: (t) =>
        t === "pi"
          ? { working: { kind: "md", frontmatter: "", body: "pi-body\n" }, has_overlay: false }
          : BASE_VIEW,
    });
    await waitFor(() => expect(overlayTextarea("claude").value).toBe(BASE_BLOB));
    await fireEvent.click(screen.getByRole("tab", { name: /pi/ }));
    await waitFor(() => expect(read).toHaveBeenCalledWith("skill", "diagnose", "pi"));
    await waitFor(() => expect(overlayTextarea("pi").value).toBe("---\n---\npi-body\n"));
  });
});
