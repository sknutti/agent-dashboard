// Component coverage for the production Library route (ADR-0007, Variant B).
// Mocks the /api/library/* client fns and renders via @testing-library/svelte
// (jsdom). Named *.svelte.test.ts so the runes in the component + resource()
// compile (see vitest.config.ts).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import Library from "./Library.svelte";
import * as api from "../lib/api";
import type {
  LibraryStatus,
  LibraryPrimitiveSummary,
  LibraryPrimitiveDetail,
  LibraryInstalledTarget,
  LibraryDriftReport,
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

/** Mock every library fetcher for the happy (valid + populated) path. The
 *  install/drift reads default to empty (nothing installed, no drift); pass
 *  overrides for write-flow tests. */
function mockValidLibrary(
  detail: LibraryPrimitiveDetail = DETAIL,
  opts: { installs?: LibraryInstalledTarget[]; drift?: LibraryDriftReport[]; batch?: LibraryDriftReport[] } = {},
) {
  vi.spyOn(api, "getLibraryStatus").mockResolvedValue(VALID);
  vi.spyOn(api, "getLibraryPrimitives").mockResolvedValue(PRIMS);
  vi.spyOn(api, "getLibraryKindInfo").mockResolvedValue({} as any);
  vi.spyOn(api, "getLibraryTargetInfo").mockResolvedValue({
    targets: [{ target: "claude", dir_name: "claude" }, { target: "pi", dir_name: "pi" }, { target: "codex", dir_name: "codex" }],
  });
  vi.spyOn(api, "getLibraryPrimitiveDetail").mockResolvedValue(detail);
  vi.spyOn(api, "getInstallsForPrimitive").mockResolvedValue(opts.installs ?? []);
  vi.spyOn(api, "getDrift").mockResolvedValue(opts.drift ?? []);
  vi.spyOn(api, "getDriftBatch").mockResolvedValue(opts.batch ?? []);
  // The working-copy editor mounts inside the detail pane and lists its files;
  // default to a primary-only bundle so the tree doesn't hit a real fetch.
  vi.spyOn(api, "getWorkingFiles").mockResolvedValue([
    { path: "SKILL.md", role: "primary", is_text: true, size_bytes: 30 },
  ]);
  // The target-overlay pane mounts whenever allowed_targets is non-empty; default
  // to no overlays + a base-passthrough view so it doesn't hit a real fetch.
  vi.spyOn(api, "listOverlays").mockResolvedValue([]);
  vi.spyOn(api, "readPrimitiveTarget").mockResolvedValue({
    working: detail.working,
    has_overlay: false,
  });
}

// A published, installable skill (current_version set + allowed_targets) so the
// install rows render (they gate on a pinned version).
const INSTALLABLE: LibraryPrimitiveDetail = {
  kind: "skill", name: "diagnose",
  metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z", author: "Ada Lovelace" },
  working: { kind: "md", frontmatter: "", body: "x" },
  versions: ["v1"], current_version: "v1",
};

const INSTALLED_CLAUDE: LibraryInstalledTarget = {
  target: "claude", installed_version: "v1", installed_at: "2026-04-30T12:00:00Z",
};

async function selectDiagnose() {
  await fireEvent.click(await screen.findByRole("button", { name: /Skills/i }));
  await fireEvent.click(screen.getByText("diagnose"));
  await screen.findByText("Install targets");
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
    vi.spyOn(api, "getWorkingFiles").mockResolvedValue([
      { path: "deploy.md", role: "primary", is_text: true, size_bytes: 20 },
    ]);
    const detailSpy = vi
      .spyOn(api, "getLibraryPrimitiveDetail")
      .mockImplementation((_kind, name) =>
        Promise.resolve(name === "deploy" ? deployDetail : DETAIL),
      );

    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Commands/i }));
    await fireEvent.click(screen.getByText("deploy"));
    // The working copy is now an EDITOR (textarea), not a read-only <pre>: the body
    // rides the textarea value, always re-fenced (empty frontmatter → `---\n---\n…`).
    const editor = (await screen.findByLabelText("file contents")) as HTMLTextAreaElement;
    expect(editor.value).toContain("deploy the thing");
    expect(detailSpy).toHaveBeenCalledWith("command", "deploy");
    // versions strip renders the on-demand versions ("v2" is also the current
    // version in the rail, so there are two — assert at least one).
    expect(screen.getAllByText("v2").length).toBeGreaterThanOrEqual(1);
  });
});

describe("Library route — install rows, two-phase confirm, drift, import", () => {
  test("a published primitive renders per-target rows; a not-installed target offers Install", async () => {
    mockValidLibrary(INSTALLABLE);
    render(Library);
    await selectDiagnose();
    expect(screen.getByText("Install targets")).toBeTruthy();
    // "claude" appears in both the row and the rail's allowed-targets summary
    expect(screen.getAllByText("claude").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/not installed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

  test("a clean install shows the installed cue (no silent no-op)", async () => {
    mockValidLibrary(INSTALLABLE);
    vi.spyOn(api, "installPrimitive").mockResolvedValue({
      successes: [{ target: "claude", outcome: { kind: "installed", version: "v1" } }],
      failures: [],
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText(/claude: installed/)).toBeTruthy();
  });

  test("a colliding_content install opens the two-phase dialog with the exact conflict paths; NO force write before confirm", async () => {
    mockValidLibrary(INSTALLABLE);
    const installSpy = vi.spyOn(api, "installPrimitive").mockResolvedValue({
      successes: [{ target: "claude", outcome: { kind: "colliding_content", version: "v1", conflicts: ["SKILL.md"] } }],
      failures: [],
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));

    // dialog appears, naming the captured target + the exact conflict path.
    // Scope to the dialog — "SKILL.md" also appears in the editor's file tree now.
    const conflictDialog = await screen.findByRole("dialog");
    expect(within(conflictDialog).getByText(/Overwrite drifted files/)).toBeTruthy();
    expect(within(conflictDialog).getByText("SKILL.md")).toBeTruthy();
    // the FIRST call was force:false; force:true has NOT fired yet (no auto-force)
    expect(installSpy).toHaveBeenCalledWith("skill", "diagnose", { targets: ["claude"], force: false });
    expect(installSpy).not.toHaveBeenCalledWith("skill", "diagnose", { targets: ["claude"], force: true });

    // confirming re-issues force:true scoped to THIS target only (D5)
    await fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    expect(installSpy).toHaveBeenCalledWith("skill", "diagnose", { targets: ["claude"], force: true });
  });

  test("a pre-flight failure (occupied path) is rendered, and NEVER offers the overwrite dialog (D5)", async () => {
    mockValidLibrary(INSTALLABLE);
    const installSpy = vi.spyOn(api, "installPrimitive").mockResolvedValue({
      successes: [],
      failures: [
        { target: "claude", reason: { kind: "occupied_by_unexpected_kind", path: "p", expected: "dir", actual: "file" } },
      ],
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));
    // the failure is surfaced as a route-local message…
    expect(await screen.findByText(/occupies the install path/)).toBeTruthy();
    // …and NO confirm dialog appears (occupied is not an overwrite-able collision)
    expect(screen.queryByText(/Overwrite drifted files/)).toBeNull();
    expect(installSpy).not.toHaveBeenCalledWith("skill", "diagnose", { targets: ["claude"], force: true });
  });

  test("cancelling the dialog issues no force write", async () => {
    mockValidLibrary(INSTALLABLE);
    const installSpy = vi.spyOn(api, "installPrimitive").mockResolvedValue({
      successes: [{ target: "claude", outcome: { kind: "colliding_content", version: "v1", conflicts: ["SKILL.md"] } }],
      failures: [],
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(installSpy).not.toHaveBeenCalledWith("skill", "diagnose", { targets: ["claude"], force: true });
  });

  test("a drifted (modified) target offers Acknowledge, which calls acknowledgeDrift", async () => {
    mockValidLibrary(INSTALLABLE, {
      installs: [INSTALLED_CLAUDE],
      drift: [{ kind: "skill", name: "diagnose", target: "claude", status: { kind: "modified", conflicts: ["SKILL.md"] } }],
    });
    const ackSpy = vi.spyOn(api, "acknowledgeDrift").mockResolvedValue({} as any);
    render(Library);
    await selectDiagnose();
    // the row reads as drifted (text, not color alone)
    expect(screen.getByText(/drifted/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(ackSpy).toHaveBeenCalledWith("skill", "diagnose", "claude");
  });

  test("a missing-externally target offers Uninstall, NOT Acknowledge", async () => {
    mockValidLibrary(INSTALLABLE, {
      installs: [INSTALLED_CLAUDE],
      drift: [{ kind: "skill", name: "diagnose", target: "claude", status: { kind: "missing", missing: ["SKILL.md"] } }],
    });
    render(Library);
    await selectDiagnose();
    expect(screen.getByText(/missing externally/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  test("the explorer shows a drift badge for a primitive with a drifted target", async () => {
    mockValidLibrary(INSTALLABLE, {
      batch: [{ kind: "skill", name: "diagnose", target: "claude", status: { kind: "modified", conflicts: ["x"] } }],
    });
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Skills/i }));
    expect(screen.getByText(/drift/)).toBeTruthy();
  });

  test("the Import button calls importInstalls and reports the imported count", async () => {
    mockValidLibrary(INSTALLABLE);
    const importSpy = vi.spyOn(api, "importInstalls").mockResolvedValue({ imported: 5 });
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Import existing installs/i }));
    expect(importSpy).toHaveBeenCalled();
    expect(await screen.findByText(/Imported 5 install/)).toBeTruthy();
  });

  test("an already-imported destination surfaces a route-local message (not the shell)", async () => {
    mockValidLibrary(INSTALLABLE);
    vi.spyOn(api, "importInstalls").mockRejectedValue(
      new api.LibraryApiError("installs_already_present", "installs already imported"),
    );
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Import existing installs/i }));
    expect(await screen.findByText(/Already imported/)).toBeTruthy();
  });

  test("a format-version mismatch tells the user to upgrade the dashboard build", async () => {
    mockValidLibrary(INSTALLABLE);
    vi.spyOn(api, "importInstalls").mockRejectedValue(
      new api.LibraryApiError("installs_format_mismatch", "installs format version mismatch"),
    );
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: /Import existing installs/i }));
    expect(await screen.findByText(/upgrade the dashboard/)).toBeTruthy();
  });
});

describe("Library route — target overlays + drift explanation (Decision 3)", () => {
  test("the Target overlays section renders a tab per allowed target", async () => {
    mockValidLibrary(INSTALLABLE); // allowed_targets: ["claude"]
    render(Library);
    await selectDiagnose();
    expect(screen.getByText("Target overlays")).toBeTruthy();
    expect(await screen.findByRole("tab", { name: /claude/ })).toBeTruthy();
  });

  test("editing an overlay on an INSTALLED target surfaces the reinstall/drift note next to its row", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] }); // claude is installed
    vi.spyOn(api, "writeOverlay").mockResolvedValue({} as never);
    render(Library);
    await selectDiagnose();

    // Drive the overlay pane: Add overlay → edit → Save.
    const ta = (await screen.findByLabelText("claude overlay contents")) as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /add overlay for claude/i }));
    await fireEvent.input(ta, { target: { value: "---\n---\nclaude-delta\n" } });
    await fireEvent.click(screen.getByRole("button", { name: /^save overlay$/i }));

    // The reinstall note appears (Decision 3) — drift is explained, not hidden.
    expect(await screen.findByText(/reach the installed copy/i)).toBeTruthy();
  });

  test("editing an overlay on a NOT-installed target shows no reinstall note (nothing to drift)", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [] }); // claude allowed but NOT installed
    vi.spyOn(api, "writeOverlay").mockResolvedValue({} as never);
    render(Library);
    await selectDiagnose();

    const ta = (await screen.findByLabelText("claude overlay contents")) as HTMLTextAreaElement;
    await fireEvent.click(screen.getByRole("button", { name: /add overlay for claude/i }));
    await fireEvent.input(ta, { target: { value: "---\n---\nclaude-delta\n" } });
    await fireEvent.click(screen.getByRole("button", { name: /^save overlay$/i }));

    // No install record → no drift to explain.
    expect(screen.queryByText(/reach the installed copy/i)).toBeNull();
  });
});

// A primitive with published versions so the strip renders clickable chips and
// the publish/inspect/set-current/restore flow is exercisable. v2 is current.
const VERSIONED: LibraryPrimitiveDetail = {
  kind: "skill", name: "diagnose",
  metadata: { allowed_targets: ["claude"], created_at: "2026-04-30T12:00:00Z", author: "Ada Lovelace" },
  working: { kind: "md", frontmatter: "", body: "current body\n" },
  versions: ["v1", "v2"], current_version: "v2",
};
const FROZEN_V1: api.LibraryPrimitiveVersionView = {
  working: { kind: "md", frontmatter: "", body: "frozen v1 body\n" },
  metadata: { created_at: "2026-03-01T00:00:00Z", notes: "first cut" },
};

describe("Library route — versioning / publishing", () => {
  test("publishing a version calls publishVersion and shows the committed-locally cue", async () => {
    mockValidLibrary(VERSIONED);
    const pubSpy = vi.spyOn(api, "publishVersion").mockResolvedValue({ committed: true, commit_error: null });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    await fireEvent.input(screen.getByPlaceholderText("v1"), { target: { value: "v3" } });
    await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(pubSpy).toHaveBeenCalledWith("skill", "diagnose", "v3", undefined);
    expect(await screen.findByText(/committed locally/)).toBeTruthy();
  });

  test("a publish whose commit failed shows 'not committed' + the git remediation, NOT an error", async () => {
    mockValidLibrary(VERSIONED);
    vi.spyOn(api, "publishVersion").mockResolvedValue({
      committed: false,
      commit_error: "Author identity unknown",
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    await fireEvent.input(screen.getByPlaceholderText("v1"), { target: { value: "v3" } });
    await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/not committed/)).toBeTruthy();
    expect(screen.getByText(/user\.email/)).toBeTruthy(); // the remediation
    expect(screen.getByText(/Author identity unknown/)).toBeTruthy(); // the git message
  });

  test("an invalid version label is refused client-side before any round-trip", async () => {
    mockValidLibrary(VERSIONED);
    const pubSpy = vi.spyOn(api, "publishVersion").mockResolvedValue({ committed: true, commit_error: null });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    await fireEvent.input(screen.getByPlaceholderText("v1"), { target: { value: "1.0" } });
    await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/looks like v1/)).toBeTruthy();
    expect(pubSpy).not.toHaveBeenCalled();
  });

  test("publish refuses while the editor has unsaved edits (no stale snapshot)", async () => {
    mockValidLibrary(VERSIONED);
    const pubSpy = vi.spyOn(api, "publishVersion").mockResolvedValue({ committed: true, commit_error: null });
    render(Library);
    await selectDiagnose();
    // Dirty the editor buffer (the textarea is the live working-copy editor).
    const editor = (await screen.findByLabelText("file contents")) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "---\n---\nuncommitted edit\n" } });
    await fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    await fireEvent.input(screen.getByPlaceholderText("v1"), { target: { value: "v3" } });
    await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/Save your edits/)).toBeTruthy();
    expect(pubSpy).not.toHaveBeenCalled();
  });

  test("clicking a version opens the inspector with frozen content + the two distinct actions", async () => {
    mockValidLibrary(VERSIONED);
    vi.spyOn(api, "readPrimitiveVersion").mockResolvedValue(FROZEN_V1);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: /^v1/ })); // the past version chip
    expect(await screen.findByText(/frozen v1 body/)).toBeTruthy();
    expect(screen.getByText(/first cut/)).toBeTruthy(); // the notes
    // The two actions are distinct + distinctly labelled (not color-coded only).
    expect(screen.getByRole("button", { name: "Set as current" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore working copy" })).toBeTruthy();
  });

  test("'Set as current' on a past version calls setCurrentVersion (not a revert)", async () => {
    mockValidLibrary(VERSIONED);
    vi.spyOn(api, "readPrimitiveVersion").mockResolvedValue(FROZEN_V1);
    const setSpy = vi.spyOn(api, "setCurrentVersion").mockResolvedValue({ committed: true, commit_error: null });
    const revSpy = vi.spyOn(api, "revertToVersion").mockResolvedValue({} as any);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: /^v1/ }));
    await fireEvent.click(await screen.findByRole("button", { name: "Set as current" }));
    expect(setSpy).toHaveBeenCalledWith("skill", "diagnose", "v1");
    expect(revSpy).not.toHaveBeenCalled(); // distinct op — set-current never reverts the working copy
  });

  test("'Restore working copy' is two-phase; only confirming calls revertToVersion", async () => {
    mockValidLibrary(VERSIONED);
    vi.spyOn(api, "readPrimitiveVersion").mockResolvedValue(FROZEN_V1);
    const revSpy = vi.spyOn(api, "revertToVersion").mockResolvedValue({} as any);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: /^v1/ }));
    await fireEvent.click(await screen.findByRole("button", { name: "Restore working copy" }));
    // The confirm dialog is up; NO write has fired yet.
    expect(revSpy).not.toHaveBeenCalled();
    const dlg = await screen.findByRole("dialog");
    await fireEvent.click(within(dlg).getByRole("button", { name: /Restore from v1/ }));
    expect(revSpy).toHaveBeenCalledWith("skill", "diagnose", "v1");
  });
});

// ── reimport-from-drift (reimport slice) ────────────────────────────────────
// The deliverable: a Modified drift row offers THREE distinguishable actions
// (Acknowledge / Reinstall / Reimport), and the two interactive results
// (working_copy_dirty / broken_source) are handled, not dropped.

const DRIFTED_CLAUDE: LibraryDriftReport = {
  kind: "skill", name: "diagnose", target: "claude", status: { kind: "modified", conflicts: ["SKILL.md"] },
};

/** Render with diagnose installed + drifted on claude, then select it. */
async function selectDriftedDiagnose() {
  mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE], drift: [DRIFTED_CLAUDE] });
  render(Library);
  await selectDiagnose();
}

describe("Library route — reimport-from-drift", () => {
  test("a Modified row offers THREE distinguishable actions: Acknowledge / Reinstall / Reimport", async () => {
    await selectDriftedDiagnose();
    // All three present, and distinguishable by LABEL (not color — Scott is CVD).
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    const reinstall = screen.getByRole("button", { name: "Reinstall" });
    const reimport = screen.getByRole("button", { name: "Reimport" });
    expect(ack).toBeTruthy();
    expect(reinstall).toBeTruthy();
    expect(reimport).toBeTruthy();
    // The two destructive actions name their OPPOSITE directions in the tooltip.
    expect(reinstall.getAttribute("title")).toMatch(/overwrite the installed copy on disk/i);
    expect(reimport.getAttribute("title")).toMatch(/pull the on-disk edits back into the library/i);
  });

  test("Reimport is offered ONLY on a Modified row, never on clean / missing / not-installed", async () => {
    // clean install → no Reimport (and the update button reads 'Update', not 'Reinstall')
    mockValidLibrary(INSTALLABLE, {
      installs: [INSTALLED_CLAUDE],
      drift: [{ kind: "skill", name: "diagnose", target: "claude", status: { kind: "clean" } }],
    });
    render(Library);
    await selectDiagnose();
    expect(screen.queryByRole("button", { name: "Reimport" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reinstall" })).toBeNull();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  test("missing-externally offers neither Reimport nor Reinstall (only Uninstall)", async () => {
    mockValidLibrary(INSTALLABLE, {
      installs: [INSTALLED_CLAUDE],
      drift: [{ kind: "skill", name: "diagnose", target: "claude", status: { kind: "missing", missing: ["SKILL.md"] } }],
    });
    render(Library);
    await selectDiagnose();
    expect(screen.queryByRole("button", { name: "Reimport" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reinstall" })).toBeNull();
  });

  test("a clean reimport calls reimportInstall with the captured target + label and shows the cue", async () => {
    await selectDriftedDiagnose();
    const spy = vi.spyOn(api, "reimportInstall").mockResolvedValue({
      kind: "reimported", new_version: "v2", committed: true, commit_error: null,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Reimport" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.input(within(dlg).getByPlaceholderText("v1"), { target: { value: "v2" } });
    await fireEvent.click(within(dlg).getByRole("button", { name: "Reimport" }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", expect.objectContaining({
      source_target: "claude", version_label: "v2", discard_working: false,
    }));
    expect(await screen.findByText(/reimported.*as v2/)).toBeTruthy();
  });

  test("an invalid version label is refused client-side; no reimport fires", async () => {
    await selectDriftedDiagnose();
    const spy = vi.spyOn(api, "reimportInstall").mockResolvedValue({ kind: "reimported", new_version: "v2", committed: true, commit_error: null });
    await fireEvent.click(screen.getByRole("button", { name: "Reimport" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.input(within(dlg).getByPlaceholderText("v1"), { target: { value: "nope" } });
    await fireEvent.click(within(dlg).getByRole("button", { name: "Reimport" }));
    expect(within(dlg).getByText(/looks like v1/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test("working_copy_dirty opens a discard confirm; confirming re-issues with discard_working:true", async () => {
    await selectDriftedDiagnose();
    const spy = vi.spyOn(api, "reimportInstall")
      .mockResolvedValueOnce({ kind: "working_copy_dirty" })
      .mockResolvedValueOnce({ kind: "reimported", new_version: "v2", committed: true, commit_error: null });
    await fireEvent.click(screen.getByRole("button", { name: "Reimport" }));
    const form = await screen.findByRole("dialog");
    await fireEvent.input(within(form).getByPlaceholderText("v1"), { target: { value: "v2" } });
    await fireEvent.click(within(form).getByRole("button", { name: "Reimport" }));
    // The first call was discard:false; the discard confirm appears naming the direction.
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", expect.objectContaining({ discard_working: false }));
    expect(await screen.findByText(/Discard working-copy edits/)).toBeTruthy();
    // Confirm → retry with discard_working:true.
    await fireEvent.click(screen.getByRole("button", { name: /Discard & reimport as v2/ }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", expect.objectContaining({ discard_working: true, version_label: "v2" }));
  });

  test("broken_source shows the parse error + an editable buffer; save retries with fixed_primary_text", async () => {
    await selectDriftedDiagnose();
    const spy = vi.spyOn(api, "reimportInstall")
      .mockResolvedValueOnce({
        kind: "broken_source", primary_path: "SKILL.md",
        raw_bytes: Array.from(new TextEncoder().encode("broken frontmatter")), parse_error: "missing ---",
      })
      .mockResolvedValueOnce({ kind: "reimported", new_version: "v2", committed: true, commit_error: null });
    await fireEvent.click(screen.getByRole("button", { name: "Reimport" }));
    const form = await screen.findByRole("dialog");
    await fireEvent.input(within(form).getByPlaceholderText("v1"), { target: { value: "v2" } });
    await fireEvent.click(within(form).getByRole("button", { name: "Reimport" }));
    // The fix sheet shows the parse error + the raw bytes decoded into the buffer.
    expect(await screen.findByText(/missing ---/)).toBeTruthy();
    const buffer = screen.getByDisplayValue("broken frontmatter");
    await fireEvent.input(buffer, { target: { value: "---\n---\nfixed\n" } });
    await fireEvent.click(screen.getByRole("button", { name: /Fix & reimport as v2/ }));
    expect(spy).toHaveBeenLastCalledWith("skill", "diagnose", expect.objectContaining({
      fixed_primary_text: "---\n---\nfixed\n", version_label: "v2",
    }));
  });
});
