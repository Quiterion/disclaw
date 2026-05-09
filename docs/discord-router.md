# discord-router — design sketch

A minimal router daemon that bridges `discli serve` to `pi --mode rpc`,
with a Unix socket control plane for subscription management.

---

## Process topology

```
discli serve >> /var/log/discli.jsonl
                      |
               [log follower]          # reads file, seeks to saved offset
                      |
               [router core]  <------  /run/router.sock  <------  router-ctl
                      |
              /run/pi_in (fifo)
                      |
              pi --mode rpc
```

### Why a file + fifo instead of pipes

- `discli` appends to a plain log file — no lifecycle coupling to the relay,
  no SIGPIPE on relay restart, offset can be persisted for replay
- `pi` reads from a named pipe with an anchor writer (`sleep infinity > /run/pi_in &`)
  so it never sees EOF when the relay restarts
- relay can be killed, modified, and restarted without touching either daemon

---

## Components

### `daemon.py` — entry point

Wires two concurrent threads and shared state:

```
main()
 ├── load_state()                 # restore offset + subscriptions from disk
 ├── Thread: follow_log(state)    # blocking file-follow loop
 └── Thread: control_server()     # blocking unix socket server
```

Threads share a `state` dict guarded by a `threading.Lock`.
State is persisted to disk on every mutation.

### `routes.py` — transform dispatch table

Pure functions, no I/O. Each route receives the raw event and current state,
returns an outbound JSONL dict or `None` to drop.

```python
ROUTES = {
    "message": route_message,   # gates on subscriptions + mentions_bot
    "ready":   route_ready,     # could notify control clients
}

def route_message(ev, state):
    if ev["channel_id"] not in state["subscriptions"]:
        return None
    if not ev.get("mentions_bot") and not ev.get("is_dm"):
        return None
    return {
        "id":      f"req-{ev['message_id']}",
        "type":    "prompt",
        "message": ev["content"],
    }
```

### `state.py` — persistence

```python
# in-memory shape
state = {
    "offset":        0,          # byte offset into discli.jsonl
    "subscriptions": set(),      # channel_ids to forward
}

def load(path) -> dict: ...
def save(path, state): ...       # called after every mutation
```

Saving after every processed line means a crash loses at most one event.

### `ctl.py` — CLI control plane

Standalone — shares no code with the daemon. Just a socket client.

```
router-ctl ping
router-ctl subscribe   <channel_id>
router-ctl unsubscribe <channel_id>
router-ctl list
```

Protocol over the Unix socket is JSONL (consistent with everything else):

```jsonl
// requests
{"cmd": "ping"}
{"cmd": "subscribe",   "channel_id": "789"}
{"cmd": "unsubscribe", "channel_id": "789"}
{"cmd": "list"}

// responses
{"ok": true, "result": "pong"}
{"ok": true}
{"ok": true}
{"ok": true, "subscriptions": ["789", "123"]}
```

---

## File layout

```
discord-router/
├── daemon.py       # entry point + thread wiring
├── routes.py       # ROUTES table + transform functions
├── state.py        # load/save offset + subscriptions
└── ctl.py          # CLI client (no shared imports with daemon)
```

Runtime files (configurable):

```
/var/log/discli.jsonl       # discli appends here
/var/run/router.state       # persisted offset + subscriptions
/run/router.sock            # control plane socket
/run/pi_in                  # named pipe to pi
```

---

## Startup sequence

```sh
# one-time setup
mkfifo /run/pi_in
sleep infinity > /run/pi_in &    # anchor writer — keeps pi from seeing EOF

# start daemons
discli serve >> /var/log/discli.jsonl &
pi --mode rpc < /run/pi_in &

# start router (safe to kill/restart at any time)
python3 -m discord_router.daemon
```

---

## Key design decisions

| decision | choice | rationale |
|---|---|---|
| IPC (daemon ↔ cli) | Unix domain socket | request/response semantics; FIFO is unidirectional |
| producer decoupling | append to file | no SIGPIPE, offset survives restarts |
| consumer decoupling | FIFO + anchor writer | pi never sees EOF |
| concurrency model | two threads + lock | simple; avoids asyncio for blocking file I/O |
| subscription filter | in router core | pi stays generic; doesn't need discord channel awareness |
| protocol | JSONL everywhere | consistent with discli and pi; no extra parsing |
| ctl.py isolation | no shared imports | control plane deployable/restartable independently |

---

## Extension points

- **Multiple consumers**: swap the single `open(OUT)` for a fan-out writer;
  each consumer gets its own FIFO + anchor
- **Event log replay**: `router-ctl replay --from <timestamp>` — seek offset
  back and re-process; routes are pure so replay is safe
- **Dynamic routes**: load `routes.py` with `importlib.reload()` on SIGHUP —
  zero-downtime route updates without restarting the daemon
- **Metrics**: a `stats` command on the control socket (events seen/routed/dropped
  per type) costs almost nothing to add
