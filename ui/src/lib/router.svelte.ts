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
// highlighting still matches on the three known ROUTES paths.
export const router = $state({ path: window.location.pathname });

/** Extract the session id from a `/session/:id` path, else null. */
export function sessionIdFromPath(path: string): string | null {
  const m = /^\/session\/([^/]+)$/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function navigate(path: string): void {
  if (path === router.path) return;
  history.pushState({}, "", path);
  router.path = path;
}

window.addEventListener("popstate", () => {
  router.path = window.location.pathname;
});
