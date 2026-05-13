#!/usr/bin/env bash
# restart-host.sh — kill the running pi-host daemon (if any) and start fresh.
#
# Identifies the daemon by its command line ending in
# `packages/pi-host/dist/daemon.js`. If multiple processes match,
# refuses to choose.
#
# Inherits the killed daemon's PI_HOST_* env vars so a restart
# preserves runtime dir / model from the running daemon. Operator-set
# env wins over inherited (set explicitly to override).
#
# Usage:
#   bash scripts/restart-host.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PIDS=$(pgrep -f 'packages/pi-host/dist/daemon\.js$' || true)
COUNT=$(echo "$PIDS" | wc -w)

if [ "$COUNT" -gt 1 ]; then
  echo "==> ERROR: multiple pi-host processes found, refusing to choose:" >&2
  pgrep -af 'packages/pi-host/dist/daemon\.js$' >&2
  exit 1
fi

INHERITED_ENV=()
if [ -n "$PIDS" ]; then
  PID="$PIDS"
  if [ -r "/proc/$PID/environ" ]; then
    while IFS= read -r line; do
      INHERITED_ENV+=("$line")
    done < <(tr '\0' '\n' < "/proc/$PID/environ" \
             | grep -E '^PI_HOST_(RUNTIME_DIR|MODEL|MODEL_NAME|PROVIDER|BIN)=' || true)
    if [ "${#INHERITED_ENV[@]}" -gt 0 ]; then
      echo "==> inheriting from running daemon (pid $PID):"
      for kv in "${INHERITED_ENV[@]}"; do
        echo "    $kv"
      done
    fi
  else
    echo "==> WARNING: /proc/$PID/environ not readable; using current shell env" >&2
  fi

  echo "==> stopping pi-host pid $PID"
  kill -TERM "$PID"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "    exited after ${i}s"
      break
    fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "==> ERROR: pi-host $PID did not exit after 10s" >&2
    exit 1
  fi
else
  echo "==> no running pi-host — just starting"
fi

for kv in "${INHERITED_ENV[@]:-}"; do
  [ -z "$kv" ] && continue
  key="${kv%%=*}"
  if [ -z "${!key:-}" ]; then
    export "$kv"
  fi
done

exec bash "$REPO_DIR/scripts/start-host.sh" "${@:-}"
