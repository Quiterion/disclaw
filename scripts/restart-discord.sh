#!/usr/bin/env bash
# restart-discord.sh — kill the running pi-discord daemon (if any) and start fresh.
#
# Identifies the daemon by its command line ending in
# `packages/pi-discord/dist/daemon.js`. Inherits PI_DISCORD_* and
# PI_HOST_* env vars from the killed process.
#
# Usage:
#   bash scripts/restart-discord.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PIDS=$(pgrep -f 'packages/pi-discord/dist/daemon\.js$' || true)
COUNT=$(echo "$PIDS" | wc -w)

if [ "$COUNT" -gt 1 ]; then
  echo "==> ERROR: multiple pi-discord processes found, refusing to choose:" >&2
  pgrep -af 'packages/pi-discord/dist/daemon\.js$' >&2
  exit 1
fi

INHERITED_ENV=()
if [ -n "$PIDS" ]; then
  PID="$PIDS"
  if [ -r "/proc/$PID/environ" ]; then
    while IFS= read -r line; do
      INHERITED_ENV+=("$line")
    done < <(tr '\0' '\n' < "/proc/$PID/environ" \
             | grep -E '^(PI_DISCORD_RUNTIME_DIR|PI_HOST_(RUNTIME_DIR|SOCKET))=' || true)
    if [ "${#INHERITED_ENV[@]}" -gt 0 ]; then
      echo "==> inheriting from running daemon (pid $PID):"
      for kv in "${INHERITED_ENV[@]}"; do
        echo "    $kv"
      done
    fi
  fi

  echo "==> stopping pi-discord pid $PID"
  kill -TERM "$PID"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "    exited after ${i}s"
      break
    fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "==> ERROR: pi-discord $PID did not exit after 10s" >&2
    exit 1
  fi
else
  echo "==> no running pi-discord — just starting"
fi

for kv in "${INHERITED_ENV[@]:-}"; do
  [ -z "$kv" ] && continue
  key="${kv%%=*}"
  if [ -z "${!key:-}" ]; then
    export "$kv"
  fi
done

exec bash "$REPO_DIR/scripts/start-discord.sh" "${@:-}"
