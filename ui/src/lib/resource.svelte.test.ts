// Runes-level tests for resource() — the reactive data primitive every panel uses.
// Named *.svelte.test.ts so the Svelte plugin compiles the runes (see vitest.config.ts).
//
// The headline test is the regression for the freeze bug: a no-flicker tweak once
// read `state.data` inside the effect-synchronous run(), making state.data a
// DEPENDENCY of the effect; the fetch .then then SET state.data → effect re-ran →
// refetched → ∞ (a silent async loop that froze the whole app). These tests pin
// the contract: the effect's only triggers are the key and dataEpoch — never the
// resource's own data.

import { flushSync } from "svelte";
import { describe, test, expect } from "vitest";
import { resource } from "./resource.svelte";
import { dataEpoch } from "./stores.svelte";

/** A fetcher whose promises you resolve by hand, so async timing is deterministic. */
function controllable() {
  let calls = 0;
  const resolvers: Array<(v: unknown) => void> = [];
  const fetcher = () => {
    calls++;
    return new Promise((r) => resolvers.push(r as (v: unknown) => void));
  };
  return {
    fetcher,
    get calls() {
      return calls;
    },
    resolveLast(value: unknown) {
      resolvers[resolvers.length - 1]?.(value);
    },
  };
}

/** Let queued microtasks (a resolved .then) run, then flush Svelte effects. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

describe("resource() reactivity contract", () => {
  test("REGRESSION: setting its own data does NOT re-trigger the effect (no refetch loop)", async () => {
    const c = controllable();
    const cleanup = $effect.root(() => {
      resource(() => "k", c.fetcher);
    });
    try {
      flushSync(); // initial effect run → one fetch
      expect(c.calls).toBe(1);

      c.resolveLast({ value: 1 }); // .then sets state.data
      await settle();

      // The buggy version refetched here (state.data was a dependency) → calls ≥ 2,
      // and in the browser this spun forever. The fixed version stays at 1.
      expect(c.calls).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("a key change DOES refetch", async () => {
    const c = controllable();
    let key = $state("a");
    const cleanup = $effect.root(() => {
      resource(() => key, c.fetcher);
    });
    try {
      flushSync();
      expect(c.calls).toBe(1);
      c.resolveLast({ value: 1 });
      await settle();
      expect(c.calls).toBe(1); // still just the one — own data didn't retrigger

      key = "b"; // dependency changes → refetch
      flushSync();
      expect(c.calls).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("a dataEpoch bump refetches every resource (the 30s refresh path)", async () => {
    const c = controllable();
    const cleanup = $effect.root(() => {
      resource(() => "k", c.fetcher);
    });
    try {
      flushSync();
      expect(c.calls).toBe(1);
      c.resolveLast({ value: 1 });
      await settle();
      expect(c.calls).toBe(1);

      dataEpoch.value += 1; // the poll-driven refresh
      flushSync();
      expect(c.calls).toBe(2);
    } finally {
      cleanup();
      dataEpoch.value = 0; // reset shared module state for other tests
    }
  });

  test("loading is true only until the first response, then stays false on refetch", async () => {
    const c = controllable();
    let r!: ReturnType<typeof resource>;
    const cleanup = $effect.root(() => {
      r = resource(() => "k", c.fetcher);
    });
    try {
      flushSync();
      expect(r.loading).toBe(true); // first load shows the skeleton
      c.resolveLast({ value: 1 });
      await settle();
      expect(r.loading).toBe(false);
      expect(r.data).toEqual({ value: 1 });

      dataEpoch.value += 1; // background refresh
      flushSync();
      expect(r.loading).toBe(false); // no skeleton flash on refresh (stale data stays)
    } finally {
      cleanup();
      dataEpoch.value = 0;
    }
  });
});
