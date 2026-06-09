#!/usr/bin/env bash
# Command Centre — Phase 0 installer (skeleton).
#
# Stands up the runnable-but-empty foundation: installs deps, builds the UI,
# creates the data dir, auto-detects agent dirs, and (optionally) installs +
# loads the launchd service. Idempotent; safe to re-run.
#
#   ./install.sh [--yes] [--port=N] [--project-root=PATH]
#                [--no-launchd] [--no-start] [--no-build]
set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────
ASSUME_YES=0
PORT=8765
PROJECT_ROOT=""
DO_LAUNCHD=1
DO_START=1
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y)            ASSUME_YES=1 ;;
    --port=*)            PORT="${arg#*=}" ;;
    --project-root=*)    PROJECT_ROOT="${arg#*=}" ;;
    --no-launchd)        DO_LAUNCHD=0 ;;
    --no-start)          DO_START=0 ;;
    --no-build)          DO_BUILD=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -11; exit 0 ;;
    *) echo "install: unknown arg '$arg'" >&2; exit 2 ;;
  esac
done

# ── Resolve script dir / project root ───────────────────────────────────────
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"
LABEL="com.commandcentre.server"
DATA_DIR="$PROJECT_ROOT/data"
LOG_DIR="$DATA_DIR/logs"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$PROJECT_ROOT/templates/launchd/$LABEL.plist.template"

step() { printf "\n\033[1;34m▸ %s\033[0m\n" "$1"; }
info() { printf "  %s\n" "$1"; }

# ── 1. Toolchain ─────────────────────────────────────────────────────────────
step "Checking toolchain"
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "install: bun is required (https://bun.sh)" >&2; exit 1; }
BUN_DIR="$(dirname "$BUN")"
info "bun $("$BUN" --version) at $BUN"
info "project root: $PROJECT_ROOT"

# ── 2. Dependencies + UI build ───────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  step "Installing dependencies"
  ( cd "$PROJECT_ROOT" && "$BUN" install )
  step "Building UI (ui/dist)"
  ( cd "$PROJECT_ROOT/ui" && "$BUN" install && "$BUN" run build )
else
  info "skipping build (--no-build)"
fi

# ── 3. Data dir ──────────────────────────────────────────────────────────────
step "Creating data directory"
mkdir -p "$LOG_DIR"
info "$DATA_DIR"

# ── 4. Auto-detect agents ────────────────────────────────────────────────────
step "Detecting agents"
( cd "$PROJECT_ROOT" && CC_PROJECT_ROOT="$PROJECT_ROOT" "$BUN" run scripts/detect_agents.ts ) || info "detection skipped"

# ── 5. cc shim on PATH ───────────────────────────────────────────────────────
step "Linking cc launcher"
chmod +x "$PROJECT_ROOT/bin/cc"
mkdir -p "$HOME/.local/bin"
ln -sf "$PROJECT_ROOT/bin/cc" "$HOME/.local/bin/cc"
info "$HOME/.local/bin/cc -> $PROJECT_ROOT/bin/cc"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) info "note: add ~/.local/bin to your PATH to use 'cc' directly" ;;
esac

# ── 6. launchd service ───────────────────────────────────────────────────────
if [ "$DO_LAUNCHD" -eq 1 ]; then
  step "Installing launchd service"
  [ -f "$TEMPLATE" ] || { echo "install: missing $TEMPLATE" >&2; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents"
  sed -e "s|{{BUN}}|$BUN|g" \
      -e "s|{{BUN_DIR}}|$BUN_DIR|g" \
      -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
      -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
      -e "s|{{PORT}}|$PORT|g" \
      "$TEMPLATE" > "$PLIST_DEST"
  info "wrote $PLIST_DEST"
  # Reload cleanly if already loaded.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [ "$DO_START" -eq 1 ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null \
      || launchctl load -w "$PLIST_DEST"
    info "loaded + started (RunAtLoad)"
  else
    info "installed but not started (--no-start)"
  fi
else
  info "skipping launchd (--no-launchd)"
  if [ "$DO_START" -eq 1 ]; then
    info "start the server in the foreground with: cc start"
  fi
fi

# ── 7. Next steps ────────────────────────────────────────────────────────────
step "Done"
info "Open    http://127.0.0.1:$PORT"
info "Health  cc doctor"
info "Logs    cc logs"
