#!/usr/bin/env bash
# dev-test.sh — launch pi-host + pi-discord in a fresh isolated cwd
# with Claude Opus 4.7, suitable for getting feedback from inside.
#
# What it does:
#   1. Creates a fresh timestamped test cwd under ~/pi-host-tests/
#   2. Seeds it with docs/agent/* + the testing-variant welcome
#   3. Builds both packages (so we run dist/ — no tsx dep in the sandbox)
#   4. Launches pi-host from the test cwd with isolated runtime dir
#   5. Launches pi-discord pointed at pi-host's isolated socket
#
# Each invocation gets its own test dir; nothing is auto-cleaned. To
# wipe: rm -rf ~/pi-host-tests/<timestamp>
#
# Usage:
#   bash scripts/dev-test.sh
#
# To stop: ctrl-C the pi-host foreground; pi-discord runs in background
# and can be stopped via `pkill -TERM -f packages/pi-discord/dist/daemon.js`.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${PI_HOST_TEST_ROOT:-$HOME/pi-host-tests}"
TEST_DIR="$TEST_ROOT/$(date +%Y-%m-%d_%H-%M-%S)"

mkdir -p "$TEST_DIR"

echo "==> test cwd: $TEST_DIR"

# Seed agent-facing docs
cp -r "$REPO_DIR/docs/agent/"* "$TEST_DIR/"

# Use the testing-variant welcome
cp "$REPO_DIR/docs/dev/welcome.testing.md" "$TEST_DIR/welcome.md"

echo "==> seeded $(ls "$TEST_DIR" | wc -l) entries from docs/agent + welcome.testing.md"

echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

PI_HOST_RT="$TEST_DIR/.pi-host"
PI_DISCORD_RT="$TEST_DIR/.pi-discord"

echo "==> launching pi-discord in background (isolated runtime)"
echo "    pi-discord runtime: $PI_DISCORD_RT"
echo "    pi-host socket:     $PI_HOST_RT/pi-host.sock"
nohup env \
  PI_DISCORD_RUNTIME_DIR="$PI_DISCORD_RT" \
  PI_HOST_RUNTIME_DIR="$PI_HOST_RT" \
  node --env-file="$REPO_DIR/.env" "$REPO_DIR/packages/pi-discord/dist/daemon.js" \
  > "$TEST_DIR/.pi-discord.log" 2>&1 &
DISCORD_PID=$!
disown
echo "    pi-discord pid: $DISCORD_PID (log: $TEST_DIR/.pi-discord.log)"

echo
echo "==> launching pi-host in foreground (Opus 4.7)"
echo "    pi-host runtime: $PI_HOST_RT"
echo "    Stop pi-discord after ctrl-C with:"
echo "      kill $DISCORD_PID"
echo
echo "    To interact in another terminal:"
echo "      export PI_HOST_RUNTIME_DIR=$PI_HOST_RT"
echo "      export PI_DISCORD_RUNTIME_DIR=$PI_DISCORD_RT"
echo "      $REPO_DIR/bin/pi-ctl get-state"
echo "      $REPO_DIR/bin/pdc get-state"
echo

cd "$TEST_DIR"
# PI_DISCORD_RUNTIME_DIR is passed to pi-host too — not because pi-host
# uses it, but so it ends up in the agent's env (pi inherits pi-host's
# env). Without this, pdc invocations from the agent's bash
# fall through to the default socket and miss the isolated test runtime.
exec env \
  PI_HOST_MODEL=claude-opus-4-7 \
  PI_HOST_MODEL_NAME="Claude Opus 4.7" \
  PI_HOST_RUNTIME_DIR="$PI_HOST_RT" \
  PI_DISCORD_RUNTIME_DIR="$PI_DISCORD_RT" \
  node --env-file="$REPO_DIR/.env" "$REPO_DIR/packages/pi-host/dist/daemon.js"
