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

// ── flatten (ADR-0009) ──────────────────────────────────────────────────────
// A skill installed to claude+codex with a CLAUDE overlay (codex is a
// base-follower). Flatten is offered only for the overlay-bearing target; a
// hand-edited converging install routes to a force confirm.
const FLATTENABLE: LibraryPrimitiveDetail = {
  kind: "skill", name: "diagnose",
  metadata: { allowed_targets: ["claude", "codex"], created_at: "2026-04-30T12:00:00Z", author: "Ada Lovelace" },
  working: { kind: "md", frontmatter: "", body: "x" },
  versions: ["v1"], current_version: "v1",
};
const INSTALLED_CODEX: LibraryInstalledTarget = {
  target: "codex", installed_version: "v1", installed_at: "2026-04-30T12:00:00Z",
};
const FLATTENED_OK = {
  kind: "flattened" as const, new_version: "v2",
  converged_targets: ["codex" as const], preserved_targets: [],
  reinstall: { successes: [], failures: [] }, committed: true, commit_error: null,
};

function mockFlattenable(opts: { installs?: LibraryInstalledTarget[] } = {}) {
  mockValidLibrary(FLATTENABLE, { installs: opts.installs ?? [INSTALLED_CLAUDE, INSTALLED_CODEX] });
  // Claude has an overlay; codex does not → only claude is flatten-eligible.
  vi.spyOn(api, "listOverlays").mockResolvedValue([{ target: "claude", paths: ["SKILL.md"] }]);
}

describe("Library route — flatten an overlay into the base", () => {
  test("Flatten is offered ONLY for overlay-bearing targets", async () => {
    mockFlattenable();
    render(Library);
    await selectDiagnose();
    await screen.findByText("Flatten an overlay into the base");
    const buttons = screen.getAllByRole("button", { name: /Flatten into base/ });
    expect(buttons).toHaveLength(1); // claude only — codex is a base-follower
    expect(screen.getByText("Flatten an overlay into the base")).toBeTruthy();
  });

  test("a clean flatten calls flattenPrimitive with the captured target + label and shows the cue", async () => {
    mockFlattenable();
    const spy = vi.spyOn(api, "flattenPrimitive").mockResolvedValue(FLATTENED_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(await screen.findByRole("button", { name: /Flatten into base/ }));
    const form = screen.getByRole("group", { name: /Flatten overlay into base/ });
    await fireEvent.input(within(form).getByPlaceholderText("v2"), { target: { value: "v2" } });
    await fireEvent.click(within(form).getByRole("button", { name: "Flatten" }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", expect.objectContaining({
      source_target: "claude", version_label: "v2", force: false,
    }));
    expect(await screen.findByText(/flattened.*as v2/)).toBeTruthy();
  });

  test("the form surfaces which base-follower targets will be rewritten before confirm", async () => {
    mockFlattenable();
    render(Library);
    await selectDiagnose();
    await fireEvent.click(await screen.findByRole("button", { name: /Flatten into base/ }));
    // codex is an installed base-follower → named as a target that will be rewritten.
    expect(await screen.findByText(/Rewritten on disk to match the new base: codex/)).toBeTruthy();
  });

  test("converging_conflicts shows the blocking targets + a force retry that re-calls with force:true", async () => {
    mockFlattenable();
    const spy = vi.spyOn(api, "flattenPrimitive")
      .mockResolvedValueOnce({ kind: "converging_conflicts", conflicts: [{ target: "codex", paths: ["SKILL.md"] }] })
      .mockResolvedValueOnce(FLATTENED_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(await screen.findByRole("button", { name: /Flatten into base/ }));
    const form = screen.getByRole("group", { name: /Flatten overlay into base/ });
    await fireEvent.input(within(form).getByPlaceholderText("v2"), { target: { value: "v2" } });
    await fireEvent.click(within(form).getByRole("button", { name: "Flatten" }));

    // The conflict surfaces; confirming overwrites with force:true.
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/codex/)).toBeTruthy();
    await fireEvent.click(within(alert).getByRole("button", { name: /Flatten anyway/ }));
    expect(spy).toHaveBeenLastCalledWith("skill", "diagnose", expect.objectContaining({ force: true }));
    expect(await screen.findByText(/flattened.*as v2/)).toBeTruthy();
  });

  test("an invalid version label is refused client-side; no flatten fires", async () => {
    mockFlattenable();
    const spy = vi.spyOn(api, "flattenPrimitive").mockResolvedValue(FLATTENED_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(await screen.findByRole("button", { name: /Flatten into base/ }));
    const form = screen.getByRole("group", { name: /Flatten overlay into base/ });
    await fireEvent.input(within(form).getByPlaceholderText("v2"), { target: { value: "nope" } });
    await fireEvent.click(within(form).getByRole("button", { name: "Flatten" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(/looks like v1, v2/)).toBeTruthy();
  });
});

describe("Library route — content search (search slice)", () => {
  const HIT = { kind: "command" as const, name: "deploy", line_number: 3, line_text: "deploy the thing" };

  test("typing debounces to a SINGLE fetch with the final term (not per keystroke)", async () => {
    mockValidLibrary();
    const search = vi.spyOn(api, "searchLibrary").mockResolvedValue([HIT]);
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    // Three rapid keystrokes (well under the 250ms debounce) coalesce to one timer.
    await fireEvent.input(box, { target: { value: "dep" } });
    await fireEvent.input(box, { target: { value: "deplo" } });
    await fireEvent.input(box, { target: { value: "deploy" } });
    // The result surfaces only after the debounce settles + the fetch resolves.
    expect(await screen.findByText("deploy the thing")).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("deploy");
  });

  test("a whitespace-only term fetches nothing and shows no results section", async () => {
    mockValidLibrary();
    const search = vi.spyOn(api, "searchLibrary").mockResolvedValue([HIT]);
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    await fireEvent.input(box, { target: { value: "   " } });
    // Give any (incorrectly scheduled) debounce time to fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByText(/Content matches/)).toBeNull();
  });

  test("results render name + kind + line, and are independent of the name filter", async () => {
    mockValidLibrary();
    vi.spyOn(api, "searchLibrary").mockResolvedValue([HIT]);
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    await fireEvent.input(box, { target: { value: "deploy" } });
    expect(await screen.findByText("Content matches")).toBeTruthy();
    expect(screen.getByText("deploy the thing")).toBeTruthy();
    expect(screen.getByText("L3")).toBeTruthy();
    // The name-filter input is untouched — both filters are separate state.
    expect((screen.getByPlaceholderText("Filter primitives") as HTMLInputElement).value).toBe("");
  });

  test("clicking a result selects the matched primitive (loads its detail)", async () => {
    mockValidLibrary();
    vi.spyOn(api, "searchLibrary").mockResolvedValue([HIT]);
    const detailSpy = vi.spyOn(api, "getLibraryPrimitiveDetail");
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    await fireEvent.input(box, { target: { value: "deploy" } });
    await fireEvent.click(await screen.findByText("deploy the thing"));
    // Selecting routes detail to (command, deploy) — the matched primitive.
    expect(detailSpy).toHaveBeenCalledWith("command", "deploy");
  });

  test("a non-idle empty result shows the 'No content matches' state", async () => {
    mockValidLibrary();
    vi.spyOn(api, "searchLibrary").mockResolvedValue([]);
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    await fireEvent.input(box, { target: { value: "zzz" } });
    expect(await screen.findByText(/No content matches/)).toBeTruthy();
  });

  test("a fetch error shows the error state (Retry), not a blank panel", async () => {
    mockValidLibrary();
    vi.spyOn(api, "searchLibrary").mockRejectedValue(new Error("boom"));
    render(Library);
    const box = await screen.findByPlaceholderText("Search file contents");
    await fireEvent.input(box, { target: { value: "boom" } });
    // The honest error EmptyState (amber glyph + Retry) — distinct from the
    // genuinely-empty "No content matches" state, which has no Retry button.
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

// ── primitive lifecycle (lifecycle slice) ───────────────────────────────────
// The deliverables: create / rename / duplicate / import affordances, and — the
// headline — a TWO-PHASE delete confirm that lists the blast radius, fires
// nothing before the second confirm, and surfaces a bailed force-uninstall
// instead of reporting false success.

const DELETE_OK = {
  uninstall: { successes: [{ target: "claude" as const, outcome: { kind: "removed" as const } }], failures: [] },
  library_dir_removed: true,
  committed: true,
  commit_error: null,
};
const DELETE_BAILED = {
  uninstall: {
    successes: [],
    failures: [{ target: "claude" as const, reason: { kind: "io" as const, path: "p", message: "ENOTDIR" } }],
  },
  library_dir_removed: false,
  committed: false,
  commit_error: null,
};

describe("Library route — primitive lifecycle (create / rename / duplicate / import)", () => {
  test("create: New → form → Create calls createPrimitive(kind,name) and shows a success cue", async () => {
    mockValidLibrary();
    const spy = vi.spyOn(api, "createPrimitive").mockResolvedValue({ committed: true, commit_error: null });
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await fireEvent.input(screen.getByPlaceholderText("my-primitive"), { target: { value: "triage" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(spy).toHaveBeenCalledWith("skill", "triage");
    expect(await screen.findByText(/Created triage/)).toBeTruthy();
  });

  test("create: an empty name is refused client-side before any round-trip", async () => {
    mockValidLibrary();
    const spy = vi.spyOn(api, "createPrimitive").mockResolvedValue({ committed: true, commit_error: null });
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText(/Enter a name/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test("create: a name collision (409) shows an INLINE field notice, never a shell toast", async () => {
    mockValidLibrary();
    vi.spyOn(api, "createPrimitive").mockRejectedValue(
      new api.LibraryApiError("library_primitive_exists", "a primitive with that name already exists"),
    );
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await fireEvent.input(screen.getByPlaceholderText("my-primitive"), { target: { value: "diagnose" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // The route-local message renders inline; the dialog stays open to fix the name.
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByPlaceholderText("my-primitive")).toBeTruthy();
  });

  test("import-from-path: a NotClassifiable result routes to a bootstrap hint, not an error", async () => {
    mockValidLibrary();
    const spy = vi.spyOn(api, "importFromPath").mockResolvedValue({
      kind: "not_classifiable",
      reason: "path is not under a recognized install root",
    });
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.input(within(dlg).getByPlaceholderText(/\.claude\/skills/), { target: { value: "/tmp/stray" } });
    await fireEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    expect(spy).toHaveBeenCalledWith("/tmp/stray");
    expect(await screen.findByText(/not auto-importable/)).toBeTruthy();
  });

  test("import-from-path: an Imported result selects the new primitive + shows a success cue", async () => {
    mockValidLibrary();
    vi.spyOn(api, "importFromPath").mockResolvedValue({
      kind: "imported",
      primitive_kind: "skill",
      name: "imported-skill",
      committed: true,
      commit_error: null,
    });
    const detailSpy = vi.spyOn(api, "getLibraryPrimitiveDetail");
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.input(within(dlg).getByPlaceholderText(/\.claude\/skills/), {
      target: { value: "/home/me/.claude/skills/imported-skill" },
    });
    await fireEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/Imported imported-skill/)).toBeTruthy();
    expect(detailSpy).toHaveBeenCalledWith("skill", "imported-skill"); // routed selection
  });

  test("rename: confirming calls renamePrimitive and surfaces the 'installed copies keep the old name' caveat", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] });
    const spy = vi.spyOn(api, "renamePrimitive").mockResolvedValue({
      install_records_updated: 1,
      committed: true,
      commit_error: null,
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.input(within(dlg).getByRole("textbox"), { target: { value: "triage" } });
    await fireEvent.click(within(dlg).getByRole("button", { name: "Rename" }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", "triage");
    expect(await screen.findByText(/1 installed copy keeps the old name/)).toBeTruthy();
  });

  test("duplicate: confirming calls duplicatePrimitive with the prefilled '-copy' name", async () => {
    mockValidLibrary();
    const spy = vi.spyOn(api, "duplicatePrimitive").mockResolvedValue({
      new_name: "diagnose-copy",
      committed: true,
      commit_error: null,
    });
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const dlg = await screen.findByRole("dialog");
    // The new-name input is prefilled with `<name>-copy`.
    expect((within(dlg).getByRole("textbox") as HTMLInputElement).value).toBe("diagnose-copy");
    await fireEvent.click(within(dlg).getByRole("button", { name: "Duplicate" }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose", "diagnose-copy");
    expect(await screen.findByText(/Duplicated to diagnose-copy/)).toBeTruthy();
  });
});

describe("Library route — delete (the headline two-phase confirm)", () => {
  test("delete is TWO-PHASE: the confirm lists the blast radius and NO request fires before the second confirm", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] });
    const spy = vi.spyOn(api, "deletePrimitive").mockResolvedValue(DELETE_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Phase 1: the confirm is up, listing what's installed + the version count.
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("claude")).toBeTruthy(); // the installed target (blast radius)
    expect(within(dlg).getByText(/no backup/i)).toBeTruthy(); // the destructive warning
    expect(spy).not.toHaveBeenCalled(); // nothing fired yet
    // Phase 2: only the explicit confirm dispatches the delete.
    await fireEvent.click(within(dlg).getByRole("button", { name: "Delete permanently" }));
    expect(spy).toHaveBeenCalledWith("skill", "diagnose");
    expect(await screen.findByText(/Deleted diagnose/)).toBeTruthy();
  });

  test("a BAILED delete (uninstall failure, dir untouched) surfaces the unreachable target, never a flat success", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] });
    vi.spyOn(api, "deletePrimitive").mockResolvedValue(DELETE_BAILED);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.click(within(dlg).getByRole("button", { name: "Delete permanently" }));
    // The bail is surfaced in the still-open dialog; success is NOT claimed.
    expect(await screen.findByText(/uninstall from claude/)).toBeTruthy(); // names the unreachable target
    expect(screen.queryByText(/Deleted diagnose ·/)).toBeNull(); // never a false success cue
  });

  test("the destructive confirm is distinguishable WITHOUT color: an explicit label + warning copy", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] });
    vi.spyOn(api, "deletePrimitive").mockResolvedValue(DELETE_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dlg = await screen.findByRole("dialog");
    // The danger is carried by an unambiguous LABEL + copy (Scott is red/green
    // CVD — color alone must never be the signal).
    expect(within(dlg).getByRole("button", { name: "Delete permanently" })).toBeTruthy();
    expect(within(dlg).getByText(/There is no backup/)).toBeTruthy();
  });

  test("cancelling the delete confirm fires no request and keeps the primitive selected", async () => {
    mockValidLibrary(INSTALLABLE, { installs: [INSTALLED_CLAUDE] });
    const spy = vi.spyOn(api, "deletePrimitive").mockResolvedValue(DELETE_OK);
    render(Library);
    await selectDiagnose();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dlg = await screen.findByRole("dialog");
    await fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Install targets")).toBeTruthy(); // still on the detail
  });
});

describe("Library route — URL import (Slice 10b)", () => {
  const FETCHED = {
    content: "---\nauthor: Ada\n---\n# Diagnose\n\nReproduce, then fix.\n",
    suggested_name: "diagnose-fetched",
    author: "Ada",
    source_url: "https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md",
    ref_files: [{ rel_path: "reference/notes.md", content: [104, 105] }],
  };

  async function openCreate() {
    render(Library);
    await fireEvent.click(await screen.findByRole("button", { name: "New" }));
  }
  const urlInput = () => screen.getByTestId("create-url-input") as HTMLInputElement;
  const nameInput = () => screen.getByPlaceholderText("my-primitive") as HTMLInputElement;

  test("fetch pre-fills the name + shows the preview with the ref-file count", async () => {
    mockValidLibrary();
    vi.spyOn(api, "fetchPrimitiveFromUrl").mockResolvedValue(FETCHED);
    await openCreate();
    await fireEvent.input(urlInput(), { target: { value: "https://github.com/o/r/blob/main/SKILL.md" } });
    await fireEvent.click(screen.getByTestId("create-fetch-btn"));
    expect(await screen.findByTestId("fetch-preview")).toBeTruthy();
    expect(screen.getByText(/\+ 1 file/)).toBeTruthy();
    expect(nameInput().value).toBe("diagnose-fetched"); // pre-filled from suggested_name
  });

  test("an unsupported URL shows an inline notice, never a preview/toast", async () => {
    mockValidLibrary();
    vi.spyOn(api, "fetchPrimitiveFromUrl").mockRejectedValue(
      new api.LibraryApiError("library_unsupported_source_url", "unsupported source URL"),
    );
    await openCreate();
    await fireEvent.input(urlInput(), { target: { value: "https://gitlab.com/o/r" } });
    await fireEvent.click(screen.getByTestId("create-fetch-btn"));
    expect(await screen.findByText(/unsupported source URL/)).toBeTruthy();
    expect(screen.queryByTestId("fetch-preview")).toBeNull();
  });

  test("a rate-limited fetch surfaces its distinct, actionable message", async () => {
    mockValidLibrary();
    vi.spyOn(api, "fetchPrimitiveFromUrl").mockRejectedValue(
      new api.LibraryApiError("library_github_rate_limited", "GitHub rate limit reached — wait and retry"),
    );
    await openCreate();
    await fireEvent.input(urlInput(), { target: { value: "https://github.com/o/r/blob/main/SKILL.md" } });
    await fireEvent.click(screen.getByTestId("create-fetch-btn"));
    expect(await screen.findByText(/rate limit reached/i)).toBeTruthy();
  });

  test("create forwards the fetched seed as `imported`", async () => {
    mockValidLibrary();
    vi.spyOn(api, "fetchPrimitiveFromUrl").mockResolvedValue(FETCHED);
    const create = vi.spyOn(api, "createPrimitive").mockResolvedValue({ committed: true, commit_error: null });
    await openCreate();
    await fireEvent.input(urlInput(), { target: { value: "https://github.com/o/r/blob/main/SKILL.md" } });
    await fireEvent.click(screen.getByTestId("create-fetch-btn"));
    await screen.findByTestId("fetch-preview");
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(create).toHaveBeenCalledWith("skill", "diagnose-fetched", FETCHED);
  });

  test("editing the URL after a fetch invalidates the stash — no stale seed on create", async () => {
    mockValidLibrary();
    vi.spyOn(api, "fetchPrimitiveFromUrl").mockResolvedValue(FETCHED);
    const create = vi.spyOn(api, "createPrimitive").mockResolvedValue({ committed: true, commit_error: null });
    await openCreate();
    await fireEvent.input(urlInput(), { target: { value: "https://github.com/o/r/blob/main/SKILL.md" } });
    await fireEvent.click(screen.getByTestId("create-fetch-btn"));
    await screen.findByTestId("fetch-preview");
    // edit the URL → the preview (and its stash) is dropped
    await fireEvent.input(urlInput(), { target: { value: "https://github.com/o/r/blob/main/OTHER.md" } });
    expect(screen.queryByTestId("fetch-preview")).toBeNull();
    // create now sends the empty-scaffold 2-arg form (no imported seed)
    await fireEvent.input(nameInput(), { target: { value: "manual" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(create).toHaveBeenCalledWith("skill", "manual");
  });
});
