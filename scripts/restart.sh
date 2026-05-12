#!/usr/bin/env bash
# restart.sh — kill the running disclaw daemon (if any) and start fresh.
#
# Identifies the daemon by command line ending in `dist/daemon.js`
# (the end-anchor avoids matching the operator's own shell, which is
# the trap that bit us in earlier sessions). If multiple processes
# match, refuses to choose and prints them — kill manually.
#
# Same env / .env / build behavior as start.sh; runs start.sh under
# the hood after the kill.
#
# Usage:
#   bash scripts/restart.sh
#   DISCLAW_MODEL=claude-opus-4-7 bash scripts/restart.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# pgrep -f matches against the full command line. The `$` end-anchor
# restricts to processes whose cmdline ends with dist/daemon.js — so
# this script's own shell (whose cmdline contains the regex literal,
# but doesn't END with dist/daemon.js) won't false-positive.
PIDS=$(pgrep -f 'dist/daemon\.js$' || true)
COUNT=$(echo "$PIDS" | wc -w)

if [ "$COUNT" -gt 1 ]; then
  echo "==> ERROR: multiple daemon processes found, refusing to choose:" >&2
  pgrep -af 'dist/daemon\.js$' >&2
  echo "    Kill manually then re-run." >&2
  exit 1
fi

if [ -n "$PIDS" ]; then
  PID="$PIDS"
  echo "==> stopping daemon pid $PID"
  kill -TERM "$PID"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "    exited after ${i}s"
      break
    fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "==> ERROR: daemon $PID did not exit after 10s" >&2
    echo "    SIGTERM ignored or shutdown hung. Inspect with: ps -p $PID" >&2
    exit 1
  fi
else
  echo "==> no running daemon — just starting"
fi

exec bash "$REPO_DIR/scripts/start.sh"
