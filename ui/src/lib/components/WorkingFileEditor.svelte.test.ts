// Component coverage for the working-copy editor (working-copy slice). Renders
// WorkingFileEditor directly (named *.svelte.test.ts so the runes + resource()
// compile) and mocks the /api/library working-file fetchers. The load-bearing
// behaviors: the buffer is seeded from the primary at mount, a ref lazy-reads,
// edits flip dirty + Save calls the right fetcher, the buffer SURVIVES a 30s poll
// tick (risk-b), and every failure is a route-local inline message (risk-a).

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/svelte";
import WorkingFileEditor from "./WorkingFileEditor.svelte";
import * as api from "../api";
import { LibraryApiError, type WorkingContent, type WorkingFileEntry } from "../api";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0; // reset shared module state between tests
});

const WORKING: WorkingContent = {
  kind: "md",
  frontmatter: "display_name: Diagnose\n",
  body: "# Diagnose\n",
};
// The editor must ALWAYS emit fences (unlike the display-only <pre>) so an
// empty-frontmatter primary still re-parses on save.
const PRIMARY_BLOB = "---\ndisplay_name: Diagnose\n---\n# Diagnose\n";

const FILES: WorkingFileEntry[] = [
  { path: "SKILL.md", role: "primary", is_text: true, size_bytes: 30 },
  { path: "logo.bin", role: "ref", is_text: false, size_bytes: 4 },
  { path: "notes.md", role: "ref", is_text: true, size_bytes: 6 },
];

function mountEditor(onWrite = vi.fn()) {
  vi.spyOn(api, "getWorkingFiles").mockResolvedValue(FILES);
  const r = render(WorkingFileEditor, {
    kind: "skill",
    name: "diagnose",
    working: WORKING,
    onWrite,
  });
  return { ...r, onWrite };
}

const textarea = () => screen.getByLabelText("file contents") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: /^save(ing…)?$/i }) as HTMLButtonElement;
// A file's name appears in BOTH the tree (a button) and the pane-path (a span);
// scope tree lookups to the button role to disambiguate.
const treeEntry = (path: string) =>
  screen.findByRole("button", { name: new RegExp(path.replace(".", "\\.")) });

describe("WorkingFileEditor — tree + primary seeding", () => {
  test("renders the working-files tree and seeds the textarea from the primary (always fenced)", async () => {
    mountEditor();
    expect(await treeEntry("SKILL.md")).toBeTruthy();
    expect(await treeEntry("notes.md")).toBeTruthy();
    expect(await treeEntry("logo.bin")).toBeTruthy();
    // The primary is open by default — buffer is the fully-fenced blob.
    expect(textarea().value).toBe(PRIMARY_BLOB);
    // Not dirty at mount → Save disabled.
    expect(saveButton().disabled).toBe(true);
  });

  test("selecting a text ref lazy-reads its content into the buffer", async () => {
    mountEditor();
    const read = vi
      .spyOn(api, "readWorkingFile")
      .mockResolvedValue({ kind: "text", text: "hello\n", ext: "md" });
    await fireEvent.click(await treeEntry("notes.md"));
    await waitFor(() => expect(textarea().value).toBe("hello\n"));
    expect(read).toHaveBeenCalledWith("skill", "diagnose", "notes.md");
  });
});

describe("WorkingFileEditor — edit → save → dirty-clear (W6)", () => {
  test("editing the primary flips dirty and Save calls saveWorking, then clears dirty + reloads", async () => {
    const { onWrite } = mountEditor();
    const save = vi.spyOn(api, "saveWorking").mockResolvedValue({} as never);
    await treeEntry("SKILL.md");
    await fireEvent.input(textarea(), { target: { value: "---\n---\nedited\n" } });
    expect(saveButton().disabled).toBe(false); // dirty
    await fireEvent.click(saveButton());
    expect(save).toHaveBeenCalledWith("skill", "diagnose", "---\n---\nedited\n");
    await waitFor(() => expect(saveButton().disabled).toBe(true)); // baseline reset → dirty cleared
    expect(onWrite).toHaveBeenCalled(); // detailRes + primitivesRes reload
  });

  test("saving an open ref calls saveWorkingFile with its path", async () => {
    mountEditor();
    vi.spyOn(api, "readWorkingFile").mockResolvedValue({ kind: "text", text: "v1", ext: "md" });
    const saveRef = vi.spyOn(api, "saveWorkingFile").mockResolvedValue({} as never);
    await fireEvent.click(await treeEntry("notes.md"));
    await waitFor(() => expect(textarea().value).toBe("v1"));
    await fireEvent.input(textarea(), { target: { value: "v2" } });
    await fireEvent.click(saveButton());
    expect(saveRef).toHaveBeenCalledWith("skill", "diagnose", "notes.md", "v2");
  });
});

describe("WorkingFileEditor — buffer survives the poll (risk-b)", () => {
  test("an unsaved edit is NOT clobbered by a 30s poll tick (dataEpoch bump)", async () => {
    mountEditor();
    await treeEntry("SKILL.md");
    await fireEvent.input(textarea(), { target: { value: "WIP — do not lose me" } });
    // Simulate the background refresh: the tree resource refetches, but the buffer
    // is plain $state, never bound to resource data.
    dataEpoch.value += 1;
    await waitFor(() => expect(api.getWorkingFiles).toHaveBeenCalledTimes(2)); // refetched
    expect(textarea().value).toBe("WIP — do not lose me"); // survived
    expect(saveButton().disabled).toBe(false); // still dirty
  });
});

describe("WorkingFileEditor — binary + route-local errors (risk-a)", () => {
  test("a binary ref renders a placeholder with no textarea and no save", async () => {
    mountEditor();
    vi.spyOn(api, "readWorkingFile").mockResolvedValue({ kind: "binary", size: 4 });
    await fireEvent.click(await treeEntry("logo.bin"));
    expect(await screen.findByText(/binary file/i)).toBeTruthy();
    expect(screen.queryByLabelText("file contents")).toBeNull();
    expect(screen.queryByRole("button", { name: /^save(ing…)?$/i })).toBeNull();
  });

  test("a traversal file name surfaces a route-local inline message, never the shell", async () => {
    mountEditor();
    vi.spyOn(api, "createWorkingFile").mockRejectedValue(
      new LibraryApiError("library_invalid_working_path", "invalid working-file path"),
    );
    await fireEvent.click(await screen.findByRole("button", { name: /new/i }));
    await fireEvent.input(await screen.findByLabelText("new file path"), {
      target: { value: "../escape.md" },
    });
    await fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid file name/i);
  });

  test("create over an existing name shows a route-local message", async () => {
    mountEditor();
    vi.spyOn(api, "createWorkingFile").mockRejectedValue(
      new LibraryApiError("working_file_exists", "exists"),
    );
    await fireEvent.click(await screen.findByRole("button", { name: /new/i }));
    await fireEvent.input(await screen.findByLabelText("new file path"), {
      target: { value: "notes.md" },
    });
    await fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already exists/i);
  });
});

describe("WorkingFileEditor — delete (inline confirm, W7)", () => {
  test("deleting a ref takes an inline confirm, calls deleteWorkingFile, and reloads", async () => {
    const { container, onWrite } = mountEditor();
    const del = vi.spyOn(api, "deleteWorkingFile").mockResolvedValue({} as never);
    await treeEntry("notes.md");
    const row = container.querySelector('li[data-path="notes.md"]') as HTMLElement;
    // First click arms the inline confirm — no write yet.
    await fireEvent.click(within(row).getByTitle("Delete"));
    expect(del).not.toHaveBeenCalled();
    // The confirm "Delete" actually fires it.
    await fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(del).toHaveBeenCalledWith("skill", "diagnose", "notes.md");
    await waitFor(() => expect(onWrite).toHaveBeenCalled());
  });
});
