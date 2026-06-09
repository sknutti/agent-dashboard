// Tiny reactive data resource. Call at component init; it refetches whenever the
// reactive `key()` changes (Svelte 5 runes). `$effect` here syncs with an external
// system (the API) — the one legitimate effect use — and cancels stale fetches.

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  reload(): void;
}

export function resource<T>(
  key: (() => string) | string,
  fetcher: (k: string) => Promise<T>,
): Resource<T> {
  // Accept a constant string key or a reactive getter; normalize to a getter so a
  // string key can never be called as a function (would throw in the flush).
  const keyFn = typeof key === "function" ? key : () => key;
  const state = $state<Resource<T>>({
    data: null,
    loading: true,
    error: false,
    reload: () => {},
  });

  let nonce = 0;
  function run(k: string) {
    const my = ++nonce;
    state.loading = true;
    fetcher(k)
      .then((d) => {
        if (my !== nonce) return; // a newer request superseded this one
        state.data = d;
        state.error = false;
      })
      .catch(() => {
        if (my !== nonce) return;
        state.error = true;
      })
      .finally(() => {
        if (my === nonce) state.loading = false;
      });
  }

  $effect(() => {
    const k = keyFn(); // tracked
    run(k);
  });

  state.reload = () => run(keyFn());
  return state;
}
