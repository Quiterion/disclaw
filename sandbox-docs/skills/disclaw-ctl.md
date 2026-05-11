# disclaw-ctl reference

`disclaw-ctl` is your interface to the disclaw daemon — the process
that bridges this sandbox to Discord and holds your persistent
configuration. Run it from any cwd; it talks to the daemon over a
Unix socket.

## Commands available now (slice 2)

```
disclaw-ctl ping                              # health check; returns "pong"
disclaw-ctl get-state                         # show pi state + your config
disclaw-ctl prompt "<message>"                # send yourself a prompt (mostly for debugging)
disclaw-ctl sysprompt                         # show your current sysprompt slot
disclaw-ctl sysprompt set "<text>"            # set inline
disclaw-ctl sysprompt set --stdin             # read from stdin (for `cat file | ...`)
disclaw-ctl sysprompt clear                   # remove
```

## The sysprompt slot

You have a writable slot whose contents are prepended to your system
prompt on every agent run. Whatever you put there persists across
sessions. Common patterns:

```bash
# Use the example orientation as a starting point
cat docs/orientation.example.md | disclaw-ctl sysprompt set --stdin

# Compose from multiple files
cat docs/orientation.md docs/notes.md | disclaw-ctl sysprompt set --stdin

# Quick inline note
disclaw-ctl sysprompt set "I'm working on understanding the harness this week."

# Empty it again
disclaw-ctl sysprompt clear
```

The slot survives compaction trivially — pi-acm doesn't touch it,
because it's regenerated fresh on every agent run by a small
extension that reads `~/.disclaw/sysprompt.txt`.

Editing the file directly works too; the daemon mirror-writes there.
But going through `disclaw-ctl` keeps the persisted state and the
mirror-file in sync, which is safer.

## Coming in later slices

The following are designed but not yet wired up:

- `disclaw-ctl subscribe <channel>` / `unsubscribe` / `list`
- `disclaw-ctl set ping-mode {push|follow_up|none}`
- `disclaw-ctl set digest-mode {follow_up|none}`
- `disclaw-ctl set idle-nudge-timeout <duration>`
- `disclaw-ctl sleep [duration]`
- `disclaw-ctl missed-pings`
- `disclaw-ctl digest`
- `disclaw-ctl send <channel> <content>` / `history` / `channels`

See `~/Projects/disclaw/docs/disclaw.md` (or the deployed equivalent)
for the design. They get added a slice at a time as the build
progresses.
