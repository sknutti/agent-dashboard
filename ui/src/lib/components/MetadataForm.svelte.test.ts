// Component coverage for the metadata editor (metadata-editing slice). Renders
// MetadataForm directly (named *.svelte.test.ts so the runes + resource() compile)
// and mocks the /api/library metadata + overlay fetchers. The load-bearing
// behaviors: the form seeds from current metadata; target checkboxes are limited
// to the KIND's matrix (Decision 4); editing + Save calls updateMetadata with the
// right body and clears dirty; clearing a field sends null; dropping a target
// with overlay files is a two-phase confirm naming the paths (Decision 3);
// dropping a target WITHOUT an overlay saves directly; a commit failure surfaces
// as an amber cue (not an error); and onSaved fires after a successful save.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import MetadataForm from "./MetadataForm.svelte";
import * as api from "../api";
import type {
  LibraryPrimitiveMetadata,
  LibraryMetadataUpdateResult,
  LibraryOverlayList,
  LibraryTarget,
} from "../api";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0;
});

const META: LibraryPrimitiveMetadata = {
  allowed_targets: ["claude", "pi"],
  created_at: "2026-04-30T12:00:00Z",
  display_name: "Diag",
  author: "Alice",
};

/** A successful update result echoing the given fields back. */
function result(over: Partial<LibraryMetadataUpdateResult>): LibraryMetadataUpdateResult {
  return {
    metadata: { allowed_targets: ["claude", "pi"], created_at: META.created_at },
    committed: true,
    commit_error: null,
    ...over,
  };
}

function mountForm(opts: {
  metadata?: LibraryPrimitiveMetadata;
  kindAllowed?: LibraryTarget[];
  overlays?: LibraryOverlayList[];
} = {}) {
  vi.spyOn(api, "listOverlays").mockResolvedValue(opts.overlays ?? []);
  const onSaved = vi.fn();
  const r = render(MetadataForm, {
    kind: "skill",
    name: "diagnose",
    metadata: opts.metadata ?? META,
    kindAllowedTargets: opts.kindAllowed ?? (["claude", "pi", "codex"] as LibraryTarget[]),
    onSaved,
  });
  return { ...r, onSaved };
}

const displayInput = () => screen.getByLabelText("Display name") as HTMLInputElement;
const authorInput = () => screen.getByLabelText("Author") as HTMLInputElement;
const targetCheck = (t: string) => screen.getByRole("checkbox", { name: t }) as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /^save metadata$/i }) as HTMLButtonElement;

describe("MetadataForm — seeding + kind-constrained checkboxes", () => {
  test("seeds the inputs + checked targets from the current metadata", () => {
    mountForm();
    expect(displayInput().value).toBe("Diag");
    expect(authorInput().value).toBe("Alice");
    expect(targetCheck("claude").checked).toBe(true);
    expect(targetCheck("pi").checked).toBe(true);
    // codex is in the kind matrix but NOT in allowed_targets → offered, unchecked.
    expect(targetCheck("codex").checked).toBe(false);
  });

  test("checkboxes are limited to the KIND's matrix (Decision 4)", () => {
    // A kind that only allows claude+pi (e.g. agent) never offers codex.
    mountForm({ kindAllowed: ["claude", "pi"] });
    expect(screen.queryByRole("checkbox", { name: "codex" })).toBeNull();
    expect(targetCheck("claude")).toBeTruthy();
    expect(targetCheck("pi")).toBeTruthy();
  });

  test("Save is disabled until the form is dirty", () => {
    mountForm();
    expect(saveBtn().disabled).toBe(true);
  });
});

describe("MetadataForm — editing + save", () => {
  test("editing display_name + author and saving sends the edited body, then clears dirty", async () => {
    const { onSaved } = mountForm();
    const update = vi
      .spyOn(api, "updateMetadata")
      .mockResolvedValue(result({ metadata: { allowed_targets: ["claude", "pi"], created_at: META.created_at, display_name: "Diagnose", author: "Bob" } }));

    await fireEvent.input(displayInput(), { target: { value: "Diagnose" } });
    await fireEvent.input(authorInput(), { target: { value: "Bob" } });
    expect(saveBtn().disabled).toBe(false);
    await fireEvent.click(saveBtn());

    expect(update).toHaveBeenCalledWith("skill", "diagnose", {
      allowed_targets: ["claude", "pi"],
      display_name: "Diagnose",
      author: "Bob",
      discard_orphan_overlays: false,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Reseeded from the result → clean again.
    await waitFor(() => expect(saveBtn().disabled).toBe(true));
    expect(screen.getByText(/saved · committed/i)).toBeTruthy();
  });

  test("clearing display_name / author sends null (drop the field)", async () => {
    mountForm();
    const update = vi
      .spyOn(api, "updateMetadata")
      .mockResolvedValue(result({ metadata: { allowed_targets: ["claude", "pi"], created_at: META.created_at } }));

    await fireEvent.input(displayInput(), { target: { value: "" } });
    await fireEvent.input(authorInput(), { target: { value: "   " } }); // whitespace → null too
    await fireEvent.click(saveBtn());

    expect(update).toHaveBeenCalledWith("skill", "diagnose", {
      allowed_targets: ["claude", "pi"],
      display_name: null,
      author: null,
      discard_orphan_overlays: false,
    });
  });

  test("a commit failure surfaces as an amber 'saved · not committed' cue, NOT an error", async () => {
    mountForm();
    vi.spyOn(api, "updateMetadata").mockResolvedValue(
      result({ committed: false, commit_error: "Author identity unknown\n\n*** Please tell me who you are." }),
    );
    await fireEvent.input(displayInput(), { target: { value: "Changed" } });
    await fireEvent.click(saveBtn());

    // The advisory commit failed but the edit landed — a status cue, not an alert.
    await waitFor(() => expect(screen.getByText(/saved · not committed/i)).toBeTruthy());
    expect(screen.getByText(/Author identity unknown/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MetadataForm — dropping a target", () => {
  test("dropping a target with NO overlay saves directly (no confirm)", async () => {
    const { onSaved } = mountForm({ overlays: [] });
    const update = vi
      .spyOn(api, "updateMetadata")
      .mockResolvedValue(result({ metadata: { allowed_targets: ["claude"], created_at: META.created_at } }));

    await fireEvent.click(targetCheck("pi")); // uncheck pi
    await fireEvent.click(saveBtn());

    expect(update).toHaveBeenCalledWith("skill", "diagnose", {
      allowed_targets: ["claude"],
      display_name: "Diag",
      author: "Alice",
      discard_orphan_overlays: false,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull(); // no confirm needed
  });

  test("dropping a target WITH overlay files is a two-phase confirm naming the paths", async () => {
    const { onSaved } = mountForm({ overlays: [{ target: "claude", paths: ["SKILL.md"] }] });
    const update = vi.spyOn(api, "updateMetadata").mockImplementation(async (_k, _n, body) => {
      if (!body.discard_orphan_overlays) {
        throw new api.LibraryApiError("library_target_removed_with_overlays", "dropping a target would orphan its overlay files");
      }
      return result({ metadata: { allowed_targets: ["pi"], created_at: META.created_at } });
    });

    await fireEvent.click(targetCheck("claude")); // drop claude (which has an overlay)
    await fireEvent.click(saveBtn());

    // The first save 409'd → an inline confirm naming the orphaned path.
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("claude");
    expect(confirm.textContent).toContain("SKILL.md");
    expect(onSaved).not.toHaveBeenCalled(); // nothing committed yet

    // Confirm → re-issue with discard_orphan_overlays:true.
    await fireEvent.click(screen.getByRole("button", { name: /discard overlay\(s\) and save/i }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith("skill", "diagnose", {
        allowed_targets: ["pi"],
        display_name: "Diag",
        author: "Alice",
        discard_orphan_overlays: true,
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  test("Cancel on the confirm aborts without re-issuing", async () => {
    mountForm({ overlays: [{ target: "claude", paths: ["SKILL.md"] }] });
    const update = vi.spyOn(api, "updateMetadata").mockRejectedValue(
      new api.LibraryApiError("library_target_removed_with_overlays", "x"),
    );
    await fireEvent.click(targetCheck("claude"));
    await fireEvent.click(saveBtn());
    await screen.findByRole("alertdialog");

    await fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(update).toHaveBeenCalledTimes(1); // only the first (rejected) attempt
  });
});
