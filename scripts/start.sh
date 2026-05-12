#!/usr/bin/env bash
# start.sh — start a disclaw daemon.
#
# Reads (in precedence order, highest first):
#   1. Explicit env vars set by the operator
#   2. State.json in DISCLAW_RUNTIME_DIR (deploy-config persisted by
#      the previous daemon — provider / model / model_name)
#   3. Hardcoded defaults
#
# Vars:
#   DISCLAW_RUNTIME_DIR  (default ~/.disclaw)
#   DISCLAW_PROVIDER     (default anthropic)
#   DISCLAW_MODEL        (default claude-haiku-4-5)
#   DISCLAW_MODEL_NAME   (default "Claude Haiku 4.5")
#
# .env at REPO_DIR/.env must exist (DISCORD_BOT_TOKEN + Anthropic key).
#
# Foreground by default — ctrl-c to stop. Pass --bg to daemonize:
# nohup'd, log redirected to $RUNTIME_DIR/daemon.log, returns
# immediately so the spawning shell can close without taking the
# daemon with it.
#
# Usage:
#   bash scripts/start.sh
#   bash scripts/start.sh --bg
#   DISCLAW_MODEL=claude-opus-4-7 bash scripts/start.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  echo "    disclaw needs DISCORD_BOT_TOKEN and an Anthropic API key." >&2
  exit 1
fi

echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

RUNTIME_DIR="${DISCLAW_RUNTIME_DIR:-$HOME/.disclaw}"
STATE_FILE="$RUNTIME_DIR/state.json"

# State.json fallback for deploy-config: only fills in vars the
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
  : "${DISCLAW_PROVIDER:=$(state_value provider)}"
  : "${DISCLAW_MODEL:=$(state_value model)}"
  : "${DISCLAW_MODEL_NAME:=$(state_value model_name)}"
fi

# Final defaults if neither env nor state.json provided a value.
PROVIDER="${DISCLAW_PROVIDER:-anthropic}"
MODEL="${DISCLAW_MODEL:-claude-haiku-4-5}"
MODEL_NAME="${DISCLAW_MODEL_NAME:-Claude Haiku 4.5}"

mkdir -p "$RUNTIME_DIR"

if [ "$BG" = "1" ]; then
  LOG="$RUNTIME_DIR/daemon.log"
  echo "==> starting daemon (background)"
  echo "    runtime dir: $RUNTIME_DIR"
  echo "    socket:      $RUNTIME_DIR/disclaw.sock"
  echo "    model:       $MODEL ($MODEL_NAME)"
  echo "    provider:    $PROVIDER"
  echo "    log:         $LOG"
  nohup env \
    DISCLAW_RUNTIME_DIR="$RUNTIME_DIR" \
    DISCLAW_PROVIDER="$PROVIDER" \
    DISCLAW_MODEL="$MODEL" \
    DISCLAW_MODEL_NAME="$MODEL_NAME" \
    node --env-file="$ENV_FILE" "$REPO_DIR/dist/daemon.js" \
    > "$LOG" 2>&1 &
  PID=$!
  disown
  echo "==> spawned pid $PID"
  exit 0
fi

echo "==> starting daemon (foreground — ctrl-c to stop)"
echo "    runtime dir: $RUNTIME_DIR"
echo "    socket:      $RUNTIME_DIR/disclaw.sock"
echo "    model:       $MODEL ($MODEL_NAME)"
echo "    provider:    $PROVIDER"
echo

exec env \
  DISCLAW_RUNTIME_DIR="$RUNTIME_DIR" \
  DISCLAW_PROVIDER="$PROVIDER" \
  DISCLAW_MODEL="$MODEL" \
  DISCLAW_MODEL_NAME="$MODEL_NAME" \
  node --env-file="$ENV_FILE" "$REPO_DIR/dist/daemon.js"
