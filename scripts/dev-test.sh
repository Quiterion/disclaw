#!/usr/bin/env bash
# dev-test.sh — launch a disclaw daemon for local testing with another
# instance of Claude Opus 4.7 in the harness.
#
# What it does:
#   1. Creates a fresh timestamped test cwd under ~/disclaw-tests/
#   2. Seeds it with docs/agent/* + the testing-variant welcome
#   3. Builds the daemon (so we run dist/ — no tsx dep in the test cwd)
#   4. Launches the daemon from the test cwd, with isolated runtime/state:
#        DISCLAW_RUNTIME_DIR=$TEST_DIR/.disclaw
#      so this test doesn't share sysprompt/subscriptions/etc. with the
#      operator's regular ~/.disclaw/ state.
#   5. Switches the model to Opus 4.7 (DISCLAW_MODEL/DISCLAW_MODEL_NAME)
#
# Each invocation gets its own test dir; nothing is cleaned up
# automatically (so feedback files the testing instance writes survive).
# Manual cleanup: rm -rf ~/disclaw-tests/<timestamp>
#
# Usage:
#   bash scripts/dev-test.sh
#
# To stop: ctrl-C the daemon, or in another terminal:
#   DISCLAW_RUNTIME_DIR=<test-dir>/.disclaw  # exported
#   ./bin/disclaw-ctl ping  # to interact
#   pkill -TERM -f dist/daemon.js  # to stop
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${DISCLAW_TEST_ROOT:-$HOME/disclaw-tests}"
TEST_DIR="$TEST_ROOT/$(date +%Y-%m-%d_%H-%M-%S)"

mkdir -p "$TEST_DIR"

echo "==> test cwd: $TEST_DIR"

# Seed agent-facing docs
cp -r "$REPO_DIR/docs/agent/"* "$TEST_DIR/"

# Use the testing-variant welcome
cp "$REPO_DIR/docs/dev/welcome.testing.md" "$TEST_DIR/welcome.md"

echo "==> seeded $(ls "$TEST_DIR" | wc -l) entries from docs/agent + welcome.testing.md"

# Build (idempotent if already built)
echo "==> building..."
(cd "$REPO_DIR" && npm run build > /dev/null)

echo "==> launching daemon (Opus 4.7, isolated runtime dir)"
echo "    runtime dir: $TEST_DIR/.disclaw"
echo "    socket:      $TEST_DIR/.disclaw/disclaw.sock"
echo
echo "    To interact in another terminal:"
echo "      export DISCLAW_RUNTIME_DIR=$TEST_DIR/.disclaw"
echo "      $REPO_DIR/bin/disclaw-ctl get-state"
echo

cd "$TEST_DIR"
exec env \
  DISCLAW_MODEL=claude-opus-4-7 \
  DISCLAW_MODEL_NAME="Claude Opus 4.7" \
  DISCLAW_RUNTIME_DIR="$TEST_DIR/.disclaw" \
  node --env-file="$REPO_DIR/.env" "$REPO_DIR/dist/daemon.js"
