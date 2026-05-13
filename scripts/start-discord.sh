#!/usr/bin/env bash
# start-discord.sh — start the pi-discord daemon (bridges Discord to pi-host).
#
# Env vars:
#   PI_DISCORD_RUNTIME_DIR   (default ~/.local/state/pi-discord)
#   PI_HOST_RUNTIME_DIR      (default ~/.local/state/pi-host — used to
#                             locate pi-host's socket if PI_HOST_SOCKET
#                             isn't set)
#   PI_HOST_SOCKET           (default $PI_HOST_RUNTIME_DIR/pi-host.sock)
#   DISCORD_BOT_TOKEN        Discord bot token (required for Discord side)
#
# Requires .env at workspace root (DISCORD_BOT_TOKEN).
#
# Usage:
#   bash scripts/start-discord.sh
#   bash scripts/start-discord.sh --bg

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_DIR/packages/pi-discord"
ENV_FILE="$REPO_DIR/.env"

BG=0
for arg in "${@:-}"; do
  [ -z "$arg" ] && continue
  case "$arg" in
    --bg) BG=1 ;;
    *) echo "==> ERROR: unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "==> ERROR: missing $ENV_FILE" >&2
  echo "    pi-discord needs DISCORD_BOT_TOKEN to talk to Discord." >&2
  exit 1
fi

echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

RUNTIME_DIR="${PI_DISCORD_RUNTIME_DIR:-$HOME/.local/state/pi-discord}"
mkdir -p "$RUNTIME_DIR"

if [ "$BG" = "1" ]; then
  LOG="$RUNTIME_DIR/daemon.log"
  echo "==> starting pi-discord (background)"
  echo "    runtime dir: $RUNTIME_DIR"
  echo "    socket:      $RUNTIME_DIR/pi-discord.sock"
  echo "    log:         $LOG"
  nohup env \
    PI_DISCORD_RUNTIME_DIR="$RUNTIME_DIR" \
    ${PI_HOST_RUNTIME_DIR:+PI_HOST_RUNTIME_DIR="$PI_HOST_RUNTIME_DIR"} \
    ${PI_HOST_SOCKET:+PI_HOST_SOCKET="$PI_HOST_SOCKET"} \
    node --env-file="$ENV_FILE" "$PKG_DIR/dist/daemon.js" \
    > "$LOG" 2>&1 &
  PID=$!
  disown
  echo "==> spawned pid $PID"
  exit 0
fi

echo "==> starting pi-discord (foreground — ctrl-c to stop)"
echo "    runtime dir: $RUNTIME_DIR"
echo "    socket:      $RUNTIME_DIR/pi-discord.sock"
echo

exec env \
  PI_DISCORD_RUNTIME_DIR="$RUNTIME_DIR" \
  ${PI_HOST_RUNTIME_DIR:+PI_HOST_RUNTIME_DIR="$PI_HOST_RUNTIME_DIR"} \
  ${PI_HOST_SOCKET:+PI_HOST_SOCKET="$PI_HOST_SOCKET"} \
  node --env-file="$ENV_FILE" "$PKG_DIR/dist/daemon.js"
