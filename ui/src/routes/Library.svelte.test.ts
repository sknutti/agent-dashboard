// Component coverage for the production Library route (ADR-0007, Variant B).
// Mocks the /api/library/* client fns and renders via @testing-library/svelte
// (jsdom). Named *.svelte.test.ts so the runes in the component + resource()
// compile (see vitest.config.ts).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Library from "./Library.svelte";
import * as api from "../lib/api";
import type {
  LibraryStatus,
  LibraryPrimitiveSummary,
  LibraryPrimitiveDetail,
} from "../lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VALID: LibraryStatus = {
  configured: true, is_valid: true, marker_exists: true,
  is_git_repo: true, branch: "main", dirty: false, unpushed: false,
};

const PRIMS: LibraryPrimitiveSummary[] = [
  { kind: "skill", name: "diagnose", dirty: false, author: "Ada Lovelace" },
  { kind: "skill", name: "browser-check", dirty: true, author: null },
  { kind: "command", name: "deploy", dirty: false, author: null },
];

const DETAIL: LibraryPrimitiveDetail = {
  kind: "skill", name: "diagnose",
  metadata: { allowed_targets: ["claude", "codex"], created_at: "2026-04-30T12:00:00Z", author: "Ada Lovelace" },
  working: { kind: "md", frontmatter: "display_name: Diagnose\n", body: "# Diagnose\n\nReproduce.\n" },
  versions: [], current_version: null,
};

/** Mock every library fetcher for the happy (valid + populated) path. */
function mockValidLibrary(detail: LibraryPrimitiveDetail = DETAIL) {
  vi.spyOn(api, "getLibraryStatus").mockResolvedValue(VALID);
  vi.spyOn(api, "getLibraryPrimitives").mockResolvedValue(PRIMS);
  vi.spyOn(api, "getLibraryKindInfo").mockResolvedValue({} as any);
  vi.spyOn(api, "getLibraryTargetInfo").mockResolvedValue({
    targets: [{ target: "claude", dir_name: "claude" }, { target: "pi", dir_name: "pi" }, { target: "codex", dir_name: "codex" }],
  });
  vi.spyOn(api, "getLibraryPrimitiveDetail").mockResolvedValue(detail);
}

describe("Library route — failure & empty states", () => {
  test("unconfigured library points the user at config/library.yaml", async () => {
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue({
      configured: false, is_valid: false, marker_exists: false,
      is_git_repo: false, branch: null, dirty: null, unpushed: null,
    });
    render(Library);
    expect(await screen.findByText(/No library configured/)).toBeTruthy();
    expect(screen.getByText("config/library.yaml")).toBeTruthy();
  });

  test("a bridge failure (status rejects) renders the shared error state with Retry, not a blank page", async () => {
    vi.spyOn(api, "getLibraryStatus").mockRejectedValue(new Error("502"));
    render(Library);
    // house EmptyState error mode: honest "Couldn’t load data" + a Retry button
    expect(await screen.findByText(/Couldn’t load data/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  test("configured-but-invalid (no marker) explains the missing .prompt-library marker", async () => {
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue({
      configured: true, is_valid: false, marker_exists: false,
      is_git_repo: false, branch: null, dirty: null, unpushed: null,
    });
    render(Library);
    expect(await screen.findByText(/Not a prompt-library directory/)).toBeTruthy();
  });

  test("a missing bridge binary shows an actionable 'cargo build' hint, not a generic error", async () => {
    // Regression: a fresh clone that set library_path but never ran `cargo build`
    // got "Couldn't load data" with no guidance. status now reports the fault as
    // data so the UI can tell the user exactly what to do.
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue({
      configured: true, is_valid: false, marker_exists: false,
      is_git_repo: false, branch: null, dirty: null, unpushed: null,
      unavailable: { code: "bridge_not_found", message: "the library bridge binary could not be launched" },
    });
    render(Library);
    expect(await screen.findByText(/Library bridge unavailable/)).toBeTruthy();
    expect(screen.getByText("cargo build")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
  });

  test("an empty but valid library reads as empty, not broken", async () => {
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue(VALID);
    vi.spyOn(api, "getLibraryPrimitives").mockResolvedValue([]);
    vi.spyOn(api, "getLibraryKindInfo").mockResolvedValue({} as any);
    vi.spyOn(api, "getLibraryTargetInfo").mockResolvedValue({ targets: [] });
    render(Library);
    expect(await screen.findByText(/Library is empty/)).toBeTruthy();
  });
});

describe("Library route — explorer, collapse, selection, detail", () => {
  test("Kind sections render collapsed by default: headers shown, items hidden", async () => {
    mockValidLibrary();
    render(Library);
    // every Kind header + its count is shown…
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Commands")).toBeTruthy();
    // …but the items inside are collapsed away (diagnose lives under Skills)
    expect(screen.queryByText("diagnose")).toBeNull();
    expect(screen.queryByText("deploy")).toBeNull();
    // and nothing is auto-selected — the detail pane invites a pick
    expect(await screen.findByText(/Select a primitive/)).toBeTruthy();
  });

  test("clicking a Kind header expands it to reveal its primitives", async () => {
    mockValidLibrary();
    render(Library);
    const header = await screen.findByRole("button", { name: /Skills/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("diagnose")).toBeTruthy();
    expect(screen.getByText("browser-check")).toBeTruthy();
    // CVD: the dirty primitive carries a text label, not color alone
    expect(screen.getByText(/modified/)).toBeTruthy();
    // collapsing hides them again
    await fireEvent.click(header);
    expect(screen.queryByText("diagnose")).toBeNull();
  });

  test("an active filter force-expands groups so matches aren't hidden behind collapse", async () => {
    mockValidLibrary();
    render(Library);
    await screen.findByText("Skills");
    // nothing expanded yet → items hidden
    expect(screen.queryByText("browser-check")).toBeNull();
    await fireEvent.input(screen.getByPlaceholderText("Filter primitives"), { target: { value: "browser" } });
    // matching item surfaces without any manual expand; non-matches stay gone
    expect(screen.getByText("browser-check")).toBeTruthy();
    expect(screen.queryByText("deploy")).toBeNull();
  });

  test("a filter with no matches shows a 'No matches' state", async () => {
    mockValidLibrary();
    render(Library);
    await screen.findByText("Skills");
    await fireEvent.input(screen.getByPlaceholderText("Filter primitives"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No matches/)).toBeTruthy();
  });

  test("expanding then selecting a primitive loads its detail on demand", async () => {
    const deployDetail: LibraryPrimitiveDetail = {
      kind: "command", name: "deploy",
      metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z" },
      working: { kind: "md", frontmatter: "", body: "deploy the thing" },
      versions: ["v1", "v2"], current_version: "v2",
    };
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue(VALID);
    vi.spyOn(api, "getLibraryPrimitives").mockResolvedValue(PRIMS);
    vi.spyOn(api, "getLibraryKindInfo").mockResolvedValue({} as any);
    vi.spyOn(api, "getLibraryTargetInfo").mockResolvedValue({ targets: [] });
    const detailSpy = vi
      .spyOn(api, "getLibraryPrimitiveDetail")
      .mockImplementation((_kind, name) =>
        Promise.resolve(name === "deploy" ? deployDetail : DETAIL),
      );

    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Commands/i }));
    await fireEvent.click(screen.getByText("deploy"));
    expect(await screen.findByText(/deploy the thing/)).toBeTruthy();
    expect(detailSpy).toHaveBeenCalledWith("command", "deploy");
    // versions strip renders the on-demand versions ("v2" is also the current
    // version in the rail, so there are two — assert at least one).
    expect(screen.getAllByText("v2").length).toBeGreaterThanOrEqual(1);
  });
});
