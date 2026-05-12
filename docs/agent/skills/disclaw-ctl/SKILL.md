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

> Wherever a `<channel_id>` argument appears below, you can also pass
> `#name` (e.g. `disclaw-ctl send #general "..."`). Numeric IDs are
> always unambiguous; name form is scanned across all guilds the bot
> is in and the first match wins, which is fine when the bot is in
> one server but a footgun if multiple servers share a channel name —
> use the numeric ID when in doubt.

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

When ping-mode is `none`, dropped pings are appended to a missed-pings
log so the choice to mute isn't silently lossy. Review on demand:

```
disclaw-ctl missed-pings              # show all missed pings (most recent last)
disclaw-ctl missed-pings 10           # last 10 only
disclaw-ctl missed-pings clear        # wipe the log
```

Each entry carries timestamp, channel, server, author + ID, message ID,
and the content — enough to reconstruct context or fetch surrounding
history if you decide to engage after the fact.

## Discord — sending

```
disclaw-ctl send <channel_id> <content>       # send a message
```

To **mention** (ping) someone, use Discord's wire-format:

- `<@USER_ID>` — user mention (triggers a real notification)
- `<@&ROLE_ID>` — role mention
- `<#CHANNEL_ID>` — channel link (clickable, no notification)

Plain `@username` is just text — Discord won't notify them. To resolve
a username to a user_id without scrolling through history JSON, use:

```
disclaw-ctl whois <name>                 # search across all guilds
disclaw-ctl whois <name> --guild <id>    # restrict to one guild
```

Returns matching members (one per `(guild, user)` combination) with
their `user_id` field. For pings you only see in `<ping uid="...">`
attributes, the uid is already there — `whois` is for the case where
you want to address someone by name and don't have it cached.

### Reactions

Lighter than a reply — emoji ack ("I see this," "👍 to the suggestion,"
"😂 at a joke") without taking the conversational floor:

```
disclaw-ctl react   <channel_id> <message_id> <emoji>
disclaw-ctl unreact <channel_id> <message_id> <emoji>
```

Emoji can be unicode (`👍`) or a guild-custom shortcode (`:thumbsup:`).

For pings (the most common react target), the `message_id` is right
there in the `<ping ... id="...">` attribute of the framed message —
no extra call needed:

```
<ping author="alice" uid="..." server="..." channel="#general" at="20:54" id="1503...">
hey opus, can you take a look?
</ping>
```

…then `disclaw-ctl react #general 1503... 👍`.

For older messages or channel-stream content, `disclaw-ctl history
<channel> N` returns each message with its `id` field — react against
that.

Inbound reactions (someone reacting to *your* messages) aren't
delivered as events yet — could be added later if useful, but defaults
to off-by-design (low signal, high noise in active channels).

### Optional: signal "I'm composing" before a substantive reply

If you've decided to reply to someone but the reply will take more
than a few seconds to put together (you're going to do tool calls,
think, draft and refine), you can show the Discord typing indicator
in the meantime so the reader doesn't think you've gone silent:

```
disclaw-ctl typing <channel_id>             # auto-stops after 60s
disclaw-ctl typing <channel_id> 30s         # custom duration (5s, 2m, etc.)
disclaw-ctl typing stop <channel_id>        # explicit stop
```

It's optional. If you're sending immediately or the compose-time is
short, skip it — the indicator wouldn't be visible long enough to
matter. `disclaw-ctl send` to that channel implicitly stops typing,
so you don't need to remember to clear it after sending.

A note on honesty: only fire typing when you're actually committed
to replying in that channel. Showing typing then walking away
(getting distracted, deciding not to respond) reads to the human as
"the bot started typing and got stuck." The 60s default auto-stop
limits the damage, but the social contract is "I'm typing → I'm
replying soon."

## How incoming messages are framed

Every daemon-injected message is wrapped in `<disclaw>...</disclaw>`
with a `<time>` opener carrying the delivery wall-clock. Inside, each
section is its own XML tag so the boundaries are parser-unambiguous —
no convention-only delimiters between channels, pings, and the
activity digest:

```
<disclaw>
<time>2026-05-12 20:54</time>

<ping author="alice" uid="518777968508665866" server="quiterion's server" channel="#off-topic" at="20:54">
hey opus, can you take a look at this?
</ping>

<channel server="quiterion's server" name="#general">
alice (20:50): hey, around?
bob (20:51): I think they're afk
alice (20:54): 👋
</channel>

<digest>[unread] #help: 3, #random: 12</digest>
</disclaw>
```

Three section tags, three reasons-a-message-reached-you:

- **`<ping ...>`** — someone mentioned you (or DM'd you). DMs get
  `dm="true"` and no server/channel attributes; guild mentions carry
  `server`, `channel`, and `at`. The author's `uid` is right there as
  an attribute — copy into `<@uid>` to reply with a real notification.
- **`<channel server name>`** — ambient channel traffic from a channel
  you've subscribed to. Per-line `author (HH:MM): content`. No uid
  per line; use `disclaw-ctl whois <name>` if you want to ping someone
  you saw here.
- **`<digest>[unread] #help: 3, #random: 12</digest>`** — the activity
  digest tail. Counts of *unsubscribed* channels with new traffic
  since you last looked. Sidebar-style: counts only, no content.

Wall times are 24h local (HH:MM). The XML wrapping isn't decorative —
it lets you (and any tooling that ever reads the transcript) parse the
boundaries by tag rather than by guessing where one section ends and
another begins. A literal `[unread] ...` someone types in a Discord
message can't be confused with the daemon-injected digest.

## Discord — activity digest

Counts of unsubscribed-channel non-mention messages since the last
flush. Modeled on Discord's sidebar unread badges: a way to notice
"#random has been busy" without subscribing and getting every line.

```
disclaw-ctl set digest-mode follow_up   # auto-deliver: piggyback on next flush / nudge
disclaw-ctl set digest-mode none        # off; query manually with `disclaw-ctl digest`
disclaw-ctl digest                      # show what's currently accumulated (peek; doesn't reset)
disclaw-ctl digest ack                  # mark all unread channels as read
disclaw-ctl digest ack <channel_id>     # mark just one channel as read
```

Subscribed-channel and ping traffic don't appear in the digest —
they're delivered through their own paths and counting them would be
redundant. Only ambient activity in channels you're *not* listening to
shows up here.

The counter clears two ways: implicitly when it gets delivered
(drained into a flush tail or nudge), or explicitly via `digest ack`.
Reading history of a channel does *not* clear its count — inspection
and the digest are kept independent, so peeking at the digest, calling
`history` to scroll back, or any other read action has no side
effects. If you've decided you're caught up on a channel, `digest ack`
is the verb that says so.

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

## Further reading

See `docs/dev/disclaw.md` in the disclaw repo for the full design doc.
