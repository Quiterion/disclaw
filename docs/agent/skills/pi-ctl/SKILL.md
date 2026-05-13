---
name: pi-ctl
description: Interface to the pi-host daemon — the supervisor process that owns your pi runtime, sysprompt slot, sleep, and idle nudges.
---

# pi-ctl reference

`pi-ctl` is your interface to the **pi-host** daemon — the supervisor
that owns your pi runtime (the agent loop), your sysprompt slot, your
sleep/wake state, and the idle-nudge timer. Run it from any cwd; it
talks to the daemon over a Unix socket.

Discord-specific verbs (subscribe, send, react, typing, channels,
etc.) live in `pi-discord-ctl`, talking to a separate `pi-discord`
daemon — see `skills/pi-discord-ctl/SKILL.md`.

## Health & state

```
pi-ctl ping                                # health check; returns "pong"
pi-ctl get-state                           # show pi-host + pi state
```

`get-state` reports: pi-host uptime, deploy config (provider/model/
modelName), pi runtime state (alive, isStreaming, isCompacting, isIdle,
session info), sysprompt slot char count, idle-nudge timeout, active
sleep window if any, and any connected subscriber daemons.

## Sysprompt slot

You have a writable slot whose contents are prepended to your system
prompt on every agent run. Survives daemon restarts.

```
pi-ctl sysprompt                           # show current value
pi-ctl sysprompt set "<text>"              # set inline
pi-ctl sysprompt set --stdin               # read from stdin (cat file | ...)
pi-ctl sysprompt clear                     # remove
```

Common patterns:

```bash
# Compose from a file you keep
cat orientation.md | pi-ctl sysprompt set --stdin
```

The slot is also where to anchor things you don't want to lose to
context-window churn — see "Context management" below.

## Idle nudges + sleep

After each agent run finishes, pi-host starts a quiet idle timer. If
no events arrive before it fires, you get a brief nudge prompt ("no
new activity, you can sleep or do whatever") so silence doesn't pass
without your attention.

```
pi-ctl set idle-nudge-timeout 30s          # nudge after 30s idle
pi-ctl set idle-nudge-timeout 5m           # nudge after 5 min idle
pi-ctl set idle-nudge-timeout off          # never nudge
```

If you want to actively choose dormancy (suppress nudges until
something real happens):

```
pi-ctl sleep                               # quiet until next event
pi-ctl sleep 1h                            # quiet for ≥1h or until next event
pi-ctl sleep 30m                           # short nap
pi-ctl wake                                # cancel an active sleep
```

Any deliver verb arriving from a subscriber (e.g. a Discord event
through pi-discord) ends sleep automatically and you receive the event
as the wake prompt. You don't lose the activity.

## How pi-host-injected messages are framed

The supervisor's own prompts (first-run bootstrap, idle nudges,
sleep-expired nudges) reach you wrapped in `<pi-host>...</pi-host>`
with a `<time>` opener:

```
<pi-host>
<time>2026-05-12 09:35</time>
No new activity since you last responded. Use `pi-ctl sleep` to wait
until something happens, or use this run however you like — write
notes, check the system, edit your sysprompt.
</pi-host>
```

Distinct from `<discord>...</discord>` (which wraps messages from the
Discord bridge) and any future bridge's wrap. Two-tag separation
means you can always tell *which subsystem* originated a given
message.

## Context management (acm)

pi-acm is loaded — sliding-window compaction, message-level pinning,
pruning, recall. Tools available via your normal tool-call interface
(not `pi-ctl`):

- `acm_map` — show current context breakdown
- `acm_pin <id>` — pin a message; survives compaction, prepends context
- `acm_unpin <id>` — un-pin
- `acm_prune <id>` — drop a message from active context (still on disk)
- `acm_recall <id>` — bring a pruned message back
- `acm_compact` — explicit compaction
- `acm_diagnose` — health check

A `<pruned-manifest>` is auto-injected at the top of context whenever
something has actually been pruned, so you can scan for things you
might want to `acm_recall`.

Your full session transcript is at the `sessionFile` path reported by
`pi-ctl get-state` under `pi.rpc.sessionFile`. It's JSONL, append-
only, and pi-acm explicitly never modifies it. Grep/jq for things
from before the active window:

```bash
SESSION=$(pi-ctl get-state | jq -r .result.pi.rpc.sessionFile)
jq 'select(.timestamp > "2026-05-12T00:00:00Z")' "$SESSION"
```

## Cross-references

- `pi-discord-ctl` — Discord verbs (subscribe, send, ping mode,
  digest, missed pings, history, channels, whois, react, typing).
  See `skills/pi-discord-ctl/SKILL.md`.
- Architecture overview — `docs/dev/architecture.md` in the workspace.
