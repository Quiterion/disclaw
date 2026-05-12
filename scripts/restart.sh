#!/usr/bin/env bash
# restart.sh — kill the running disclaw daemon (if any) and start fresh.
#
# Identifies the daemon by command line ending in `dist/daemon.js`
# (the end-anchor avoids matching the operator's own shell, which is
# the trap that bit us in earlier sessions). If multiple processes
# match, refuses to choose and prints them — kill manually.
#
# **Inherits the killed daemon's DISCLAW_* env vars** so a restart
# preserves the runtime dir / model / model name from the running
# daemon. Without this, a restart from an unrelated shell would silently
# kill (e.g.) the test daemon at $TEST_DIR/.disclaw and start a fresh
# one at the default ~/.disclaw with a different model — losing the
# session and answering as the wrong agent. Reads /proc/$PID/environ
# (Linux); if not readable, falls back to the operator's current env
# with a warning.
#
# To override an inherited var, set it explicitly when invoking:
#   DISCLAW_MODEL=claude-haiku-4-5 bash scripts/restart.sh
#
# Usage:
#   bash scripts/restart.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PIDS=$(pgrep -f 'dist/daemon\.js$' || true)
COUNT=$(echo "$PIDS" | wc -w)

if [ "$COUNT" -gt 1 ]; then
  echo "==> ERROR: multiple daemon processes found, refusing to choose:" >&2
  pgrep -af 'dist/daemon\.js$' >&2
  echo "    Kill manually then re-run." >&2
  exit 1
fi

INHERITED_ENV=()
if [ -n "$PIDS" ]; then
  PID="$PIDS"

  # Capture inherited env BEFORE killing — /proc/PID/environ vanishes
  # with the process. We only inherit DISCLAW_* (the daemon's own
  # config); inheriting the full env could surprise (e.g. PATH from a
  # different shell context).
  if [ -r "/proc/$PID/environ" ]; then
    while IFS= read -r line; do
      INHERITED_ENV+=("$line")
    done < <(tr '\0' '\n' < "/proc/$PID/environ" \
             | grep -E '^DISCLAW_(RUNTIME_DIR|MODEL|MODEL_NAME|PI_BIN|PROVIDER)=' || true)
    if [ "${#INHERITED_ENV[@]}" -gt 0 ]; then
      echo "==> inheriting from running daemon (pid $PID):"
      for kv in "${INHERITED_ENV[@]}"; do
        echo "    $kv"
      done
    fi
  else
    echo "==> WARNING: /proc/$PID/environ not readable; using current shell env" >&2
  fi

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

# Operator-set env wins over inherited (allows DISCLAW_MODEL=foo
# bash scripts/restart.sh to override). `env -S` would let us be
# precise but isn't needed here — we just pre-export the inherited
# values and let any operator-set ones shadow them naturally via
# start.sh's `${VAR:-default}` reads.
for kv in "${INHERITED_ENV[@]:-}"; do
  [ -z "$kv" ] && continue
  key="${kv%%=*}"
  # Only set if operator hasn't already set it
  if [ -z "${!key:-}" ]; then
    export "$kv"
  fi
done

# Forward any flags (e.g. --bg) to start.sh.
exec bash "$REPO_DIR/scripts/start.sh" "${@:-}"
