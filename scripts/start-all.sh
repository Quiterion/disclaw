#!/usr/bin/env bash
# start-all.sh — start pi-host and pi-discord both in background.
#
# Starts pi-host first so its socket is up before pi-discord tries to
# connect. (pi-discord retries on its own, but the initial-connect log
# message is friendlier when pi-host is already ready.)
#
# Both daemons go to background regardless of args — for foreground
# operation use start-host.sh or start-discord.sh directly.
#
# Usage:
#   bash scripts/start-all.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$REPO_DIR/scripts/start-host.sh" --bg
sleep 0.5
bash "$REPO_DIR/scripts/start-discord.sh" --bg

echo
echo "Both daemons started. Tail logs:"
echo "  tail -f ${PI_HOST_RUNTIME_DIR:-$HOME/.local/state/pi-host}/daemon.log"
echo "  tail -f ${PI_DISCORD_RUNTIME_DIR:-$HOME/.local/state/pi-discord}/daemon.log"
