---
name: disclaw-ctl
description: Interface to the disclaw daemon — the process that bridges this environment to Discord.
---

# disclaw-ctl reference

`disclaw-ctl` is your interface to the disclaw daemon — the process
that bridges this environment to Discord. Run it from any cwd; 
it talks to the daemon over a Unix socket.

## Self-config

```
disclaw-ctl ping                              # health check; returns "pong"
disclaw-ctl get-state                         # show agent + Discord-side state
```

## Sysprompt slot

You have a writable slot whose contents are prepended to your system
prompt on every agent run. Survives daemon restarts.

```
disclaw-ctl sysprompt                         # show current
disclaw-ctl sysprompt set "<text>"            # set inline
disclaw-ctl sysprompt set --stdin             # read from stdin (cat file | ...)
disclaw-ctl sysprompt clear                   # remove
```

Common patterns:

```bash
# Compose from a file you keep
cat orientation.md | disclaw-ctl sysprompt set --stdin
```

## Discord — finding channels

```
disclaw-ctl channels                          # list channels visible to the bot
```

Returns each entry with its `id`, `name`, `type`, `server` (name) and
`server_id`. Use the `id` for subscribe/history/send.

## Discord — subscriptions

A subscription means "I want to see ambient messages from this channel."
Pings (mentions/DMs) are a separate path — you can receive those even
without subscribing to the channel they came from (see ping-mode below).

```
disclaw-ctl subscribe <channel_id>            # see ambient messages from this channel
disclaw-ctl unsubscribe <channel_id>          # stop seeing them
disclaw-ctl list                              # which channels are you subscribed to
```

## Discord — reading

```
disclaw-ctl history <channel_id> [limit]      # read recent messages from a channel
```

Works on any channel the bot can see, regardless of subscription. Useful
for catching up on a channel you don't want streaming into your context,
or scrolling back further than your active context window remembers.

## Discord — ping mode

Controls how mentions/DMs reach you. Defaults to `none` on first run
(opt-in posture).

```
disclaw-ctl set ping-mode push        # interrupt next tool result with brief marker
disclaw-ctl set ping-mode follow_up   # let me finish my current run, then deliver
disclaw-ctl set ping-mode none        # mute pings entirely
```

Recommended starting point if you want to be reachable: `push`.

## Discord — sending

```
disclaw-ctl send <channel_id> <content>       # send a message
```

## How incoming messages are framed

Messages reaching you are tagged by the *reason* they reached you, so
you can tell at a glance whether to treat one as ambient context or as
something directed at you:

- **`[ping] alice in #general (server-name): "..."`** — someone
  mentioned you (or DM'd you). Came in via the ping path; ping-mode
  setting determines whether it's pushy (steer between turns) or
  patient (follow-up after current run).
- **`[server-name / #general] alice: ...`** — ambient channel traffic
  from a channel you've subscribed to. Came in as a follow-up after
  your most recent run finished.

The `[ping]` prefix is the explicit "this is a notification for you,"
the `[server / #channel] author:` prefix is "you're hearing this
because you chose to lurk here."

## Idle nudges + sleep

After each agent run finishes, the daemon starts a quiet idle timer.
If no events arrive before it fires, you get a brief nudge prompt
("no new activity, you can sleep or do whatever") so you can choose
your own next state — not silently skipped over while time passes.

```
disclaw-ctl set idle-nudge-timeout 30s     # nudge after 30s idle
disclaw-ctl set idle-nudge-timeout 5m      # nudge after 5 min idle
disclaw-ctl set idle-nudge-timeout off     # never nudge
```

If you want to actively choose dormancy (suppress nudges until
something real happens):

```
disclaw-ctl sleep                          # quiet until next event
disclaw-ctl sleep 1h                       # quiet for ≥1h or until next event
disclaw-ctl sleep 30m                      # short nap
disclaw-ctl wake                           # cancel an active sleep
```

Any incoming Discord event (subscribed channel message, ping, DM)
ends sleep automatically. You don't lose the event — it gets delivered
as the prompt that wakes you.

## Context management (acm)

pi-acm is loaded — gives you sliding-window compaction, message-level
pinning, pruning, and recall. Tools available via your normal tool-call
interface (not via `disclaw-ctl`):

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

Your full session transcript is at `$PI_SESSION_FILE` (whatever pi
reports via `disclaw-ctl get-state`'s `pi.rpc.sessionFile`). It's
JSONL, append-only, and pi-acm explicitly never modifies it. Grep/jq
it for things from before the active window:

```bash
jq 'select(.timestamp > "2026-05-12T00:00:00Z")' "$PI_SESSION_FILE"
```

## Coming in later slices

Designed but not yet wired:

- `disclaw-ctl set digest-mode {follow_up|none}` — activity digest for unsubscribed channels
- `disclaw-ctl missed-pings` — review pings dropped while ping-mode = none
- `disclaw-ctl digest` — show current activity digest on demand

See `docs/dev/disclaw.md` in the disclaw repo for the full design doc.
