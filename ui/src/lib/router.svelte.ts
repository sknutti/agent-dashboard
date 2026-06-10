// Minimal history-API router (no SvelteKit). Three top-level nav routes plus
// dynamic `/session/:id` detail pages; everything else falls through to the
// command page. Reactive via Svelte 5 runes.

export type RoutePath = "/" | "/activity" | "/skills";

export const ROUTES: { path: RoutePath; label: string; icon: string }[] = [
  { path: "/", label: "Command", icon: "command" },
  { path: "/activity", label: "Activity", icon: "activity" },
  { path: "/skills", label: "Skills & MCP", icon: "sparkles" },
];

// Store the raw pathname so dynamic routes (e.g. /session/abc) survive — nav
// highlighting still matches on the three known ROUTES paths. `search` holds the
// query string (incl. leading "?", or "") so views can read ?tab=errors without a
// new path segment (ADR-0005); sessionIdFromPath stays pathname-only, unaffected.
export const router = $state({
  path: window.location.pathname,
  search: window.location.search,
});

/** Extract the session id from a `/session/:id` path, else null. */
export function sessionIdFromPath(path: string): string | null {
  const m = /^\/session\/([^/]+)$/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** The active session tab from a query string. Only "?tab=errors" selects Errors;
 *  anything else (incl. empty / unrelated) defaults to Messages. */
export function tabFromSearch(search: string): "errors" | "messages" {
  return new URLSearchParams(search).get("tab") === "errors" ? "errors" : "messages";
}

/** Navigate to a path, optionally with a query string (e.g. "?tab=errors").
 *  Compares path AND search so a query-only change (same path, new tab) is NOT
 *  suppressed — the old `path === router.path` guard would have dropped it. */
export function navigate(path: string, search = ""): void {
  if (path === router.path && search === router.search) return;
  history.pushState({}, "", path + search);
  router.path = path;
  router.search = search;
}

window.addEventListener("popstate", () => {
  router.path = window.location.pathname;
  router.search = window.location.search;
});
