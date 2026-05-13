#!/usr/bin/env bash
# start-host.sh — start the pi-host daemon.
#
# Reads (in precedence order, highest first):
#   1. Explicit env vars set by the operator
#   2. state.json in PI_HOST_RUNTIME_DIR (deploy-config persisted by
#      the previous daemon — provider / model / model_name)
#   3. Hardcoded defaults
#
# Env vars:
#   PI_HOST_RUNTIME_DIR   (default ~/.local/state/pi-host)
#   PI_HOST_PROVIDER      (default anthropic)
#   PI_HOST_MODEL         (default claude-haiku-4-5)
#   PI_HOST_MODEL_NAME    (default "Claude Haiku 4.5")
#
# Workspace-root .env (DISCORD_BOT_TOKEN + Anthropic key) is optional
# for pi-host — only needed if Anthropic key isn't already in env.
#
# Foreground by default — ctrl-c to stop. Pass --bg to daemonize:
# nohup'd, log redirected, returns immediately so the spawning shell
# can close without taking the daemon with it.
#
# Usage:
#   bash scripts/start-host.sh
#   bash scripts/start-host.sh --bg
#   PI_HOST_MODEL=claude-opus-4-7 bash scripts/start-host.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_DIR/packages/pi-host"
ENV_FILE="$REPO_DIR/.env"

BG=0
for arg in "${@:-}"; do
  [ -z "$arg" ] && continue
  case "$arg" in
    --bg) BG=1 ;;
    *) echo "==> ERROR: unknown arg: $arg" >&2; exit 1 ;;
  esac
done

echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

RUNTIME_DIR="${PI_HOST_RUNTIME_DIR:-$HOME/.local/state/pi-host}"
STATE_FILE="$RUNTIME_DIR/state.json"

# state.json fallback for deploy-config: only fills in vars the
# operator hasn't already set. Uses python3 because we already depend
# on it elsewhere; jq isn't a guaranteed install. Falls back silently
# if state.json is missing or malformed.
state_value() {
  local key="$1"
  python3 -c "
import json, sys
try:
    with open('$STATE_FILE') as f:
        v = json.load(f).get('$key')
        if v: print(v)
except Exception:
    pass
" 2>/dev/null
}

if [ -f "$STATE_FILE" ]; then
  : "${PI_HOST_PROVIDER:=$(state_value provider)}"
  : "${PI_HOST_MODEL:=$(state_value model)}"
  : "${PI_HOST_MODEL_NAME:=$(state_value model_name)}"
fi

PROVIDER="${PI_HOST_PROVIDER:-anthropic}"
MODEL="${PI_HOST_MODEL:-claude-haiku-4-5}"
MODEL_NAME="${PI_HOST_MODEL_NAME:-Claude Haiku 4.5}"

mkdir -p "$RUNTIME_DIR"

# .env is optional for pi-host (Anthropic key may be in shell env);
# if it exists, pass it through.
ENV_FLAG=()
if [ -f "$ENV_FILE" ]; then
  ENV_FLAG=(--env-file="$ENV_FILE")
fi

if [ "$BG" = "1" ]; then
  LOG="$RUNTIME_DIR/daemon.log"
  echo "==> starting pi-host (background)"
  echo "    runtime dir: $RUNTIME_DIR"
  echo "    socket:      $RUNTIME_DIR/pi-host.sock"
  echo "    model:       $MODEL ($MODEL_NAME)"
  echo "    provider:    $PROVIDER"
  echo "    log:         $LOG"
  nohup env \
    PI_HOST_RUNTIME_DIR="$RUNTIME_DIR" \
    PI_HOST_PROVIDER="$PROVIDER" \
    PI_HOST_MODEL="$MODEL" \
    PI_HOST_MODEL_NAME="$MODEL_NAME" \
    node "${ENV_FLAG[@]}" "$PKG_DIR/dist/daemon.js" \
    > "$LOG" 2>&1 &
  PID=$!
  disown
  echo "==> spawned pid $PID"
  exit 0
fi

echo "==> starting pi-host (foreground — ctrl-c to stop)"
echo "    runtime dir: $RUNTIME_DIR"
echo "    socket:      $RUNTIME_DIR/pi-host.sock"
echo "    model:       $MODEL ($MODEL_NAME)"
echo "    provider:    $PROVIDER"
echo

exec env \
  PI_HOST_RUNTIME_DIR="$RUNTIME_DIR" \
  PI_HOST_PROVIDER="$PROVIDER" \
  PI_HOST_MODEL="$MODEL" \
  PI_HOST_MODEL_NAME="$MODEL_NAME" \
  node "${ENV_FLAG[@]}" "$PKG_DIR/dist/daemon.js"
