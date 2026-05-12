#!/usr/bin/env bash
# start.sh — start a disclaw daemon in the foreground.
#
# Reads:
#   DISCLAW_RUNTIME_DIR  (default ~/.disclaw)
#   DISCLAW_MODEL        (default claude-haiku-4-5)
#   DISCLAW_MODEL_NAME   (default "Claude Haiku 4.5")
#   .env at REPO_DIR/.env (must exist; provides DISCORD_BOT_TOKEN +
#                          an Anthropic API key)
#
# Foregrounds the daemon — ctrl-c to stop. To run backgrounded, do
# the redirect / `&` / nohup yourself, or use a process supervisor.
#
# Usage:
#   bash scripts/start.sh
#   DISCLAW_MODEL=claude-opus-4-7 bash scripts/start.sh
#   DISCLAW_RUNTIME_DIR=/tmp/test bash scripts/start.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> ERROR: missing $ENV_FILE" >&2
  echo "    disclaw needs DISCORD_BOT_TOKEN and an Anthropic API key." >&2
  exit 1
fi

# Build (idempotent if already built; tsc is fast on no-change).
echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

RUNTIME_DIR="${DISCLAW_RUNTIME_DIR:-$HOME/.disclaw}"
MODEL="${DISCLAW_MODEL:-claude-haiku-4-5}"
MODEL_NAME="${DISCLAW_MODEL_NAME:-Claude Haiku 4.5}"

mkdir -p "$RUNTIME_DIR"

echo "==> starting daemon"
echo "    runtime dir: $RUNTIME_DIR"
echo "    socket:      $RUNTIME_DIR/disclaw.sock"
echo "    model:       $MODEL ($MODEL_NAME)"
echo

exec env \
  DISCLAW_RUNTIME_DIR="$RUNTIME_DIR" \
  DISCLAW_MODEL="$MODEL" \
  DISCLAW_MODEL_NAME="$MODEL_NAME" \
  node --env-file="$ENV_FILE" "$REPO_DIR/dist/daemon.js"
