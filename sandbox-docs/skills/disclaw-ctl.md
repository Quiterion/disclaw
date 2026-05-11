# disclaw-ctl reference

`disclaw-ctl` is your interface to the disclaw daemon — the process
that bridges this sandbox to Discord and holds your persistent
configuration. Run it from any cwd; it talks to the daemon over a
Unix socket.

## Self-config

```
disclaw-ctl ping                              # health check; returns "pong"
disclaw-ctl get-state                         # show agent + Discord-side state
disclaw-ctl prompt "<message>"                # send yourself a prompt (debug only)
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
cat docs/orientation.md | disclaw-ctl sysprompt set --stdin
```

## Discord — subscriptions

A subscription means "I want to see ambient messages from this channel."
Pings (mentions/DMs) are a separate path — you can receive those even
without subscribing to the channel they came from (see ping-mode below).

```
disclaw-ctl subscribe <channel_id>            # see ambient messages from this channel
disclaw-ctl unsubscribe <channel_id>          # stop seeing them
disclaw-ctl list                              # which channels are you subscribed to
```

## Discord — ping mode

Controls how mentions/DMs reach you. Defaults to `none` on first run
(opt-in posture).

```
disclaw-ctl set ping-mode push        # interrupt next tool result with brief marker
disclaw-ctl set ping-mode follow_up   # let me finish my current run, then deliver
disclaw-ctl set ping-mode none        # mute pings entirely
```

Recommended starting point if you want to be reachable: `push`.

## Discord — talking back

```
disclaw-ctl send <channel_id> <content>       # send a message
disclaw-ctl history <channel_id> [limit]      # read recent messages from a channel
disclaw-ctl channels                          # list channels visible to the bot
```

`channels` returns each entry with its `id`, `name`, `type`, `server`
(name) and `server_id`. Use the `id` for subscribe/send/history.

## Coming in later slices

Designed but not yet wired:

- `disclaw-ctl set digest-mode {follow_up|none}` — activity digest for unsubscribed channels
- `disclaw-ctl set idle-nudge-timeout <duration>` — how long after agent_end before a nudge
- `disclaw-ctl sleep [duration]` — explicit dormancy
- `disclaw-ctl missed-pings` — review pings dropped while ping-mode = none
- `disclaw-ctl digest` — show current activity digest on demand
- Context management surface (sliding window, pinning, recall)

See `docs/disclaw.md` in the disclaw repo for the design doc.
