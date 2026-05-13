---
name: pi-discord-ctl
description: Interface to the pi-discord daemon — the bridge between this environment and Discord.
---

# pi-discord-ctl reference

`pi-discord-ctl` is your interface to the **pi-discord** daemon — the
process that bridges this environment to Discord. Run it from any cwd;
it talks to the daemon over a Unix socket. Agent self-administration
(sysprompt slot, sleep, idle-nudge timeout) lives in `pi-ctl` — see
`skills/pi-ctl/SKILL.md`.

## Health & state

```
pi-discord-ctl ping                       # health check; returns "pong"
pi-discord-ctl get-state                  # show bridge + Discord-side state
```

> For most verbs that take a `<channel_id>`, you can also pass `#name`
> (e.g. `pi-discord-ctl send #general "..."`). Numeric IDs are always
> unambiguous; name form is scanned across all guilds the bot is in
> and the first match wins.
>
> **Exception: `subscribe` / `unsubscribe` require numeric IDs.**
> Subscriptions are stored by ID for routing-side matching, and
> resolving a name at subscribe-time on a cross-guild collision would
> silently subscribe the wrong channel — a *recurring* footgun (every
> message in the wrong channel becomes a follow_up forever). Use
> `pi-discord-ctl channels` to look up the numeric ID first.

## Finding channels

```
pi-discord-ctl channels                   # list channels visible to the bot
```

Returns each entry with its `id`, `name`, `type`, `server`, and
`server_id`. Use the `id` for subscribe/history/send.

## Subscriptions

A subscription means "I want to see ambient messages from this
channel." Pings (mentions/DMs) are a separate path — you can receive
those even without subscribing to the channel they came from (see
ping-mode below).

```
pi-discord-ctl subscribe <channel_id>     # see ambient messages from this channel
pi-discord-ctl unsubscribe <channel_id>   # stop seeing them
pi-discord-ctl list                       # which channels are you subscribed to
```

**Use the numeric channel_id, not `#name`.** Subscribe/unsubscribe are
the exception to the `#name` shortcut — see the note above.

## Reading

```
pi-discord-ctl history <channel_id> [limit]   # read recent messages from a channel
```

Works on any channel the bot can see, regardless of subscription.
Useful for catching up on a channel you don't want streaming into your
context, or scrolling back further than your active context window
remembers.

## Ping mode

Controls how mentions/DMs reach you. Defaults to `none` on first run
(opt-in posture).

```
pi-discord-ctl set ping-mode push         # interrupt next tool result with brief marker
pi-discord-ctl set ping-mode follow_up    # let me finish my current run, then deliver
pi-discord-ctl set ping-mode none         # mute pings entirely
```

Recommended starting point if you want to be reachable: `push`.

When ping-mode is `none`, dropped pings are appended to a missed-pings
log so the choice to mute isn't silently lossy. Review on demand:

```
pi-discord-ctl missed-pings               # show all missed pings (most recent last)
pi-discord-ctl missed-pings 10            # last 10 only
pi-discord-ctl missed-pings clear         # wipe the log
```

Each entry carries timestamp, channel, server, author + ID, message
ID, and the content — enough to reconstruct context or fetch
surrounding history if you decide to engage after the fact.

## Sending

```
pi-discord-ctl send <channel_id> <content>           # send a message
pi-discord-ctl send <channel_id> --stdin             # read content from stdin
pi-discord-ctl send --quiet <channel_id> <content>   # print just the jump URL on success
```

The `--stdin` form is the right choice for any message you'd otherwise
have to escape or quote your way around — multi-line replies, content
containing backticks, `$vars`, embedded `"quotes"`, code blocks, etc.

```bash
pi-discord-ctl send #general --stdin <<'EOF'
multi-line content with `backticks` and "quotes" travels
through clean — no escaping required.
EOF

cat /tmp/draft.md | pi-discord-ctl send #general --stdin
```

`--quiet` skips the JSON wrapper on success and prints just the jump
URL — lighter for back-and-forth conversational use.

To **mention** (ping) someone, use Discord's wire format:

- `<@USER_ID>` — user mention (triggers a real notification)
- `<@&ROLE_ID>` — role mention
- `<#CHANNEL_ID>` — channel link (clickable, no notification)

Plain `@username` is just text — Discord won't notify them. To resolve
a username to a user_id:

```
pi-discord-ctl whois <name>                  # search across all guilds
pi-discord-ctl whois <name> --guild <id>     # restrict to one guild
```

For pings you only see in `<ping uid="...">` attributes, the uid is
already there — `whois` is for the case where you want to address
someone by name and don't have it cached.

### Reactions

Lighter than a reply — emoji ack ("I see this," "👍 to the suggestion,"
"😂 at a joke") without taking the conversational floor:

```
pi-discord-ctl react   <channel_id> <message_id> <emoji>
pi-discord-ctl unreact <channel_id> <message_id> <emoji>
```

Emoji can be unicode (`👍`) or a guild-custom shortcode (`:thumbsup:`).
For pings, the `message_id` is right there in the `<ping ... id="...">`
attribute — no extra call needed.

Inbound reactions (someone reacting to *your* messages) aren't
delivered as events yet.

### Optional: signal "I'm composing"

If you've decided to reply but the reply will take more than a few
seconds, you can show Discord's typing indicator so the reader doesn't
think you've gone silent:

```
pi-discord-ctl typing <channel_id>           # auto-stops after 60s
pi-discord-ctl typing <channel_id> 30s       # custom duration
pi-discord-ctl typing stop <channel_id>      # explicit stop
```

`send` implicitly stops typing for that channel. A note on honesty:
only fire typing when you're actually committed to replying. Showing
typing then walking away reads as "the bot started typing and got
stuck."

## How incoming Discord messages are framed

Discord-originated messages reach you wrapped in `<discord>...</discord>`
with a `<time>` opener carrying the delivery wall-clock. Inside, each
section is its own XML tag so the boundaries are parser-unambiguous —
no convention-only delimiters between channels, pings, and the
activity digest:

```
<discord>
<time>2026-05-12 20:54</time>

<ping author="alice" uid="518777968508665866" server="quiterion's server" channel="#off-topic" at="20:54" id="1503...">
hey opus, can you take a look at this?
</ping>

<channel server="quiterion's server" name="#general">
alice (20:50): hey, around?
bob (20:51): I think they're afk
alice (20:54): 👋
</channel>

<digest>[unread] #help: 3, #random: 12</digest>
</discord>
```

Section tags:

- **`<ping ...>`** — someone mentioned you (or DM'd you). DMs get
  `dm="true"` and no server/channel attributes; guild mentions carry
  `server`, `channel`, and `at`. The author's `uid` is right there as
  an attribute — copy into `<@uid>` to reply with a real notification.
- **`<channel server name>`** — ambient channel traffic from a
  subscribed channel. Per-line `author (HH:MM): content`. No uid per
  line; use `pi-discord-ctl whois <name>` if you want to ping someone
  you saw here.
- **`<attachment filename size url />`** — Discord file attachment
  (image, PDF, anything). Appears on the line after the message it
  belongs to (inside either a `<channel>` or `<ping>` block). The url
  is the Discord CDN URL — fetch via bash if you want the bytes.
- **`<digest>[unread] #help: 3, #random: 12</digest>`** — the activity
  digest tail. Counts of *unsubscribed* channels with new traffic
  since you last looked. Sidebar-style: counts only, no content.

Wall times are 24h local (HH:MM). The XML wrapping isn't decorative —
it lets any tooling reading the transcript parse boundaries by tag
rather than guessing.

Messages from pi-host (idle nudges, the first-run bootstrap) use a
different wrap: `<pi-host>...</pi-host>`. Two distinct frames, two
distinct origins.

## Activity digest

Counts of unsubscribed-channel non-mention messages since the last
flush. Modeled on Discord's sidebar unread badges.

```
pi-discord-ctl set digest-mode follow_up   # auto-deliver: piggyback on next Discord flush
pi-discord-ctl set digest-mode none        # off; query manually
pi-discord-ctl digest                      # show what's accumulated (peek; doesn't reset)
pi-discord-ctl digest ack                  # mark all unread channels as read
pi-discord-ctl digest ack <channel_id>     # mark just one channel as read
```

Subscribed-channel and ping traffic don't appear in the digest —
they're delivered through their own paths and counting them would be
redundant. Only ambient activity in channels you're *not* listening to
shows up here.

The counter clears two ways: implicitly when delivered (drained into a
follow-up flush tail), or explicitly via `digest ack`. Reading history
of a channel does *not* clear its count — inspection and the digest
are kept independent.

## Cross-references

- `pi-ctl` — agent self-administration (sysprompt slot, sleep, idle
  nudges, context mgmt). See `skills/pi-ctl/SKILL.md`.
- Architecture overview — `docs/dev/architecture.md` in the workspace.
