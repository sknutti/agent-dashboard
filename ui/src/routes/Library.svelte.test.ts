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

  test("an empty but valid library reads as empty, not broken", async () => {
    vi.spyOn(api, "getLibraryStatus").mockResolvedValue(VALID);
    vi.spyOn(api, "getLibraryPrimitives").mockResolvedValue([]);
    vi.spyOn(api, "getLibraryKindInfo").mockResolvedValue({} as any);
    vi.spyOn(api, "getLibraryTargetInfo").mockResolvedValue({ targets: [] });
    render(Library);
    expect(await screen.findByText(/Library is empty/)).toBeTruthy();
  });
});

describe("Library route — explorer, selection, detail", () => {
  test("renders primitives grouped by Kind and auto-loads the first detail", async () => {
    mockValidLibrary();
    render(Library);
    // explorer groups
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Commands")).toBeTruthy();
    // "diagnose" appears in BOTH the explorer button and the auto-selected detail
    expect(screen.getAllByText("diagnose").length).toBeGreaterThanOrEqual(1);
    // first primitive auto-selected → its working-copy body renders in the detail
    expect(await screen.findByText(/Reproduce\./)).toBeTruthy();
    // CVD: the dirty primitive carries a text label, not color alone
    expect(screen.getByText(/modified/)).toBeTruthy();
  });

  test("filtering by name narrows the explorer", async () => {
    mockValidLibrary();
    render(Library);
    await screen.findByText("browser-check");
    const input = screen.getByPlaceholderText("Filter primitives");
    await fireEvent.input(input, { target: { value: "deploy" } });
    // browser-check appears only in the explorer (never in the mocked detail), so
    // its disappearance proves the explorer list narrowed.
    expect(screen.queryByText("browser-check")).toBeNull();
    expect(screen.getByText("deploy")).toBeTruthy();
  });

  test("a filter with no matches shows a 'No matches' state", async () => {
    mockValidLibrary();
    render(Library);
    await screen.findByText("diagnose");
    await fireEvent.input(screen.getByPlaceholderText("Filter primitives"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No matches/)).toBeTruthy();
  });

  test("selecting a different primitive loads its detail on demand", async () => {
    const codexDetail: LibraryPrimitiveDetail = {
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
        Promise.resolve(name === "deploy" ? codexDetail : DETAIL),
      );

    render(Library);
    await screen.findByText(/Reproduce\./); // first auto-selected
    await fireEvent.click(screen.getByText("deploy"));
    expect(await screen.findByText(/deploy the thing/)).toBeTruthy();
    expect(detailSpy).toHaveBeenCalledWith("command", "deploy");
    // versions strip renders the on-demand versions ("v2" is also the current
    // version in the rail, so there are two — assert at least one).
    expect(screen.getAllByText("v2").length).toBeGreaterThanOrEqual(1);
  });
});
