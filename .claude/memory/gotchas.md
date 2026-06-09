# Gotchas

## esbuild binary fails to install (corporate registry) + Svelte 5 incompat
- `bun install` in `ui/` 403s on scoped `@esbuild/darwin-arm64` from the default
  (corporate jfrog) registry → Vite build dies with "host version does not match
  binary version" or "could not be found".
- **Fix (committed):** `ui/bunfig.toml` scopes `@esbuild` to `https://registry.npmjs.org`.
  After that a clean `bun install --force` resolves the binary matching Vite's
  esbuild host (currently 0.25.12).
- **Do NOT** "fix" it by pinning esbuild to 0.28.0 — that version has a
  destructuring-downlevel regression that breaks Svelte 5's runtime at build.
- `*.lock` and any path containing `/bin/` are blocked by the damage-control
  hook; can't `rm bun.lock` (use `bun install --force`) or `rm ~/.local/bin/cc`.

## Schema init ownership: getDb() inits, openDb() does NOT
- `scripts/db.ts`: `openDb()` only opens a WAL connection; `getDb()` opens +
  runs `initSchema()` (thread-local singleton). Any entrypoint that touches the
  DB standalone (worker `--once`, doctor) must use `getDb()`, or it hits
  "no such table". CREATE TABLE IF NOT EXISTS is idempotent + WAL-safe, so the
  worker re-initing alongside the server is fine.
