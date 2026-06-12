// Component coverage for the bootstrap wizard (bootstrap slice). Renders the
// wizard directly and mocks the scan/execute/session fetchers. The load-bearing
// behaviors: the resume gate (session present → Resume/Discard; absent → Scan);
// scan → review with default-checked actions + the banner counts; unchecking
// drives the filtered plan + excluded_ids into execute; a partial run surfaces
// the skip remedy + a Resume; and the Reconcile tab mounts the orphan view.

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import BootstrapWizard from "./BootstrapWizard.svelte";
import * as api from "../api";
import type {
  LibraryBootstrapScanResult,
  LibraryBootstrapExecuteSummary,
  LibraryBootstrapSession,
} from "../api";
import type { OrphanInstall } from "../library";
import { dataEpoch } from "../stores.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataEpoch.value = 0;
});

const SCAN: LibraryBootstrapScanResult = {
  crossReferenced: {
    groups: [
      { kind: "skill", name: "alpha", classification: "new" },
      { kind: "skill", name: "beta", classification: "new" },
      { kind: "skill", name: "diag", classification: "drifted" },
      { kind: "agent", name: "old", classification: "already_imported" },
    ],
    needs_manual_review: [{ kind: "command", name: "weird" }],
    symlinked: 0,
    unclassified: 0,
    summary: { new: 2, already_imported: 1, drifted: 1, needs_manual_review: 1 },
  },
  plan: {
    creates: [
      { kind: "skill", name: "alpha", raw: { kind: "skill", name: "alpha", id: "a" } },
      { kind: "skill", name: "beta", raw: { kind: "skill", name: "beta", id: "b" } },
    ],
    reimports: [{ kind: "skill", name: "diag", raw: { kind: "skill", name: "diag", id: "d" } }],
  },
};

const CLEAN_RESULT: LibraryBootstrapExecuteSummary = {
  backup_path: "/data/backups/ts.tar.gz",
  created: 1,
  reimported: 0,
  skipped: 0,
  skipped_items: [],
  committed: true,
  commit_error: null,
};

const SKIPPED_RESULT: LibraryBootstrapExecuteSummary = {
  backup_path: "/data/backups/ts.tar.gz",
  created: 1,
  reimported: 0,
  skipped: 1,
  skipped_items: [{ kind: "skill", name: "diag", source_target: "claude", reason: "WorkingCopyDirty" }],
  committed: true,
  commit_error: null,
};

const SESSION: LibraryBootstrapSession = {
  formatVersion: 2,
  startedAt: "2026-06-12T00:00:00Z",
  raw: { format_version: 2, started_at: "2026-06-12T00:00:00Z" },
};

function mount(opts: { session?: LibraryBootstrapSession | null; orphans?: OrphanInstall[] } = {}) {
  vi.spyOn(api, "readBootstrapSession").mockResolvedValue(opts.session ?? null);
  const onClose = vi.fn();
  const onImported = vi.fn();
  const onForgotten = vi.fn();
  const r = render(BootstrapWizard, {
    onClose,
    onImported,
    orphans: opts.orphans ?? [],
    onForgotten,
  });
  return { ...r, onClose, onImported, onForgotten };
}

describe("BootstrapWizard — resume gate", () => {
  test("absent session → the Scan CTA", async () => {
    mount({ session: null });
    await waitFor(() => expect(screen.getByRole("button", { name: /scan my machine/i })).toBeTruthy());
  });

  test("session present → Resume / Discard", async () => {
    mount({ session: SESSION });
    await waitFor(() => expect(screen.getByRole("button", { name: /resume previous import/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
  });
});

describe("BootstrapWizard — scan → review", () => {
  test("scanning shows the banner counts and lists creates + reimports default-checked", async () => {
    vi.spyOn(api, "bootstrapScan").mockResolvedValue(SCAN);
    mount({ session: null });
    await fireEvent.click(await screen.findByRole("button", { name: /scan my machine/i }));

    // review step reached (the banner's counts are split across <strong> nodes,
    // so wait on the import button instead)
    await screen.findByRole("button", { name: /import 3 items/i });
    expect(screen.getByText(/new — will be created/i)).toBeTruthy(); // review rendered
    // creates + reimports rendered, all checked by default
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3); // alpha, beta, diag
    expect(boxes.every((b) => b.checked)).toBe(true);
    // the already-imported / needs-review rows are surfaced but not importable
    expect(screen.getByText(/found but not importable/i)).toBeTruthy();
  });

  test("unchecking an action drops it from the plan; execute gets the filtered plan + excluded_ids", async () => {
    vi.spyOn(api, "bootstrapScan").mockResolvedValue(SCAN);
    const execute = vi.spyOn(api, "bootstrapExecute").mockResolvedValue(CLEAN_RESULT);
    const { onImported } = mount({ session: null });
    await fireEvent.click(await screen.findByRole("button", { name: /scan my machine/i }));
    await screen.findByRole("button", { name: /import 3 items/i });

    // uncheck alpha
    await fireEvent.click(screen.getByRole("checkbox", { name: /alpha/i }));
    // Import the remaining 2 (beta + diag)
    await fireEvent.click(screen.getByRole("button", { name: /import 2 items/i }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const body = execute.mock.calls[0]![0];
    // alpha is excluded from the executable plan…
    expect(body.plan.creates).toEqual([{ kind: "skill", name: "beta", id: "b" }]);
    expect(body.plan.reimports).toEqual([{ kind: "skill", name: "diag", id: "d" }]);
    // …and recorded in excluded_ids (session bookkeeping)
    expect(body.excluded_ids).toEqual(["skill/alpha"]);
    expect(body.resume).toBeNull(); // a fresh run carries no resume
    expect(onImported).toHaveBeenCalled();
  });
});

describe("BootstrapWizard — result + skips", () => {
  test("a partial run surfaces the skip remedy + a Resume", async () => {
    vi.spyOn(api, "bootstrapScan").mockResolvedValue(SCAN);
    vi.spyOn(api, "bootstrapExecute").mockResolvedValue(SKIPPED_RESULT);
    mount({ session: null });
    await fireEvent.click(await screen.findByRole("button", { name: /scan my machine/i }));
    await screen.findByRole("button", { name: /import 3 items/i });
    await fireEvent.click(screen.getByRole("button", { name: /import 3 items/i }));

    await waitFor(() => expect(screen.getByText(/1 skipped/i)).toBeTruthy());
    // the remedy copy names the working-copy fix (distinguishable by label, not color)
    expect(screen.getByText(/working copy has unpublished edits/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /resume the skipped items/i })).toBeTruthy();
  });
});

describe("BootstrapWizard — Reconcile tab", () => {
  test("the Reconcile tab mounts the orphan view", async () => {
    mount({
      session: null,
      orphans: [{ kind: "agent", name: "ghost", targets: ["claude"] }],
    });
    await fireEvent.click(screen.getByRole("tab", { name: /reconcile/i }));
    expect(screen.getByText("ghost")).toBeTruthy();
    expect(screen.getByText(/no library primitive/i)).toBeTruthy();
  });
});
