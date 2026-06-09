// Minimal history-API router (no SvelteKit). Three routes; everything else
// falls through to the command page. Reactive via Svelte 5 runes.

export type RoutePath = "/" | "/activity" | "/skills";

export const ROUTES: { path: RoutePath; label: string; icon: string }[] = [
  { path: "/", label: "Command", icon: "command" },
  { path: "/activity", label: "Activity", icon: "activity" },
  { path: "/skills", label: "Skills & MCP", icon: "sparkles" },
];

function normalize(p: string): RoutePath {
  return ROUTES.some((r) => r.path === p) ? (p as RoutePath) : "/";
}

export const router = $state({ path: normalize(window.location.pathname) });

export function navigate(path: RoutePath): void {
  if (path === router.path) return;
  history.pushState({}, "", path);
  router.path = path;
}

window.addEventListener("popstate", () => {
  router.path = normalize(window.location.pathname);
});
