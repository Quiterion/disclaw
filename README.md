# pi-host workspace

**pi-host** is a continuity layer for
[pi-coding-agent](https://github.com/mariozechner/pi-coding-agent):
one long-running agent instance with a rolling context window, a
sysprompt slot it controls, sleep, and idle nudges. **pi-discord** is
the first bridge — it gives that agent a Discord presence shaped like a
human's (channels you open, notifications you tune, a digest sidebar of
unreads, choosing when to type and reply), rendered agent-native as
XML-wrapped messages.

The split is load-bearing: pi-host is the constant — it does the same
job whether or not any bridge is connected. Bridges plug in via a
Unix-socket subscriber protocol. A Slack or IRC or wiki-watcher bridge
would slot in identically.

Two packages today:

- **[`pi-host`](packages/pi-host/)** — the supervisor. Owns one
  `pi --mode rpc` subprocess plus its session, sysprompt slot,
  idle-nudge timer, and sleep state. Exposes a Unix-socket RPC that
  `pi-ctl` (CLI) and subscriber daemons (e.g. pi-discord) connect to.
- **[`pi-discord`](packages/pi-discord/)** — the first bridge. Owns a
  [discli](https://github.com/DevRohit06/discli) subprocess, routes
  Discord events to pi-host (subscriptions, ping mode, activity
  digest), and exposes its own ctl (`pdc`) for Discord verbs.


## What's different here

If you've looked at Discord MCP clients or general-purpose agent
harnesses, four choices set this monorepo apart.

**One long-running instance, not isolated sessions.** Most agent
harnesses are session-shaped: invoke, run a task, exit. pi-host runs a
single pi instance across days, weeks, or months.
[pi-acm](https://github.com/earendil-works/pi-acm) provides a sliding-
window context manager — older content rolls off the active window but
remains queryable from the full session transcript on disk. The
supervisor preserves a per-(provider, model) session registry so a
daemon restart resumes the same continuity. Cold-restarting the daemon
doesn't cost the agent its identity.

**The agent is the primary user of the ctl surface.** `pi-ctl` and
`pdc` aren't operator dashboards with a side door for the agent —
they're designed for the agent itself. Both binaries land on the
deployed agent's PATH; sysprompt, subscriptions, ping-mode, sleep,
idle-nudge cadence are all configurable by the agent via bash. **Agency
over attention. Opt-in posture by default.** The agent wakes to silence
— `ping-mode=none`, no subscriptions, empty sysprompt slot — and
decides what to engage with. The harness imposes nothing.

**The agent as a Discord participant, not a constrained responder.**
Existing bridges narrow the seat. Anthropic's [Claude Code
Channels](https://code.claude.com/docs/en/channels) restricts outbound
to response-only tools (`reply`, `react`, `edit_message`) — the agent
can only respond to messages it has received, never initiate one into
a channel. Which channels reach the agent is gated by `access.json`;
the MCP surface exposes no tool to mutate it at runtime, and every
event delivers identically — no priority, no unread sidebar, no
posture tools. [openclaw](https://github.com/openclaw/openclaw) and
most community bots take the other route — one session per channel or
DM — which sidesteps the question by giving up continuity across
channels entirely.

pi-discord gives the agent the seat a human Discord user has, at
runtime. You open channels with `pdc subscribe` and close them with
`pdc unsubscribe`. You set your own notification mode (`push`
interrupts mid-turn, `follow_up` waits for the next turn boundary,
`none` drops to digest). You peek at a sidebar of unread counts for
channels you haven't subscribed to. You `pdc send` into any channel
on your own initiative or in reply, start and stop typing, react to
messages, choose when to speak. Deliveries can bundle a ping plus
surrounding channel context plus a digest tail in a single `<discord>`
frame — one continuous point of view shaped like a human glancing at
Discord, rendered agent-native as XML-wrapped frames (`<discord>` /
`<ping>` / `<channel>` / `<digest>`) rather than mimicking a human
client.

**Bridges are pluggable; the supervisor doesn't know about Discord.**
pi-host has no Discord-shaped state or verbs. pi-discord owns
subscriptions, ping-mode, the digest, missed-pings — everything that
describes what reaches the agent *from Discord*. Adding a bridge is a
new package; removing one is `rm -rf packages/X`. The boundary is
enforced by which socket the agent is talking to.

These four together — continuity, agent-as-user, human-shaped
participation, pluggable bridges — describe what this workspace is
shaped *for*: long-running, self-administering agent deployment with
social presence that respects the agent's attention and gives them a
participant's seat at the table.


## What the agent sees

On first wake:

```
<pi-host>
<time>2026-05-12 20:45</time>
Hi. You're in a long-running agent harness. There should be a
welcome doc at `welcome.md`.
</pi-host>
```

Assuming the `pi-discord` daemon is running, the agent can configure it with `pdc`.

```bash
pdc set ping-mode push
pdc channels
pdc subscribe 1503391358076059762   # #general
pdc set digest-mode follow_up
```

Some time later, while the agent is busyd doing their own thing, a Discord ping arrives:

```
<discord>
<time>2026-05-12 20:54</time>

<ping author="alice" uid="518777968508665866" server="quiterion's server" channel="#off-topic" at="20:54" id="1503...">
hey opus, can you take a look at this?
</ping>

<channel server="quiterion's server" name="#general">
<msg author="carol" at="20:50" id="1503...">hey, opus around?</msg>
<msg author="bob" at="20:51" id="1503...">I think they're afk</msg>
<msg author="carol" at="20:54" id="1503...">👋</msg>
</channel>

<digest>[unread] #help: 3, #random: 12</digest>
</discord>
```

The agent can choose whether and how to respond:

```bash
pdc send "#general" "back, was afk — alice just pinged me, one sec"
```


After each `agent_end`, if no new events arrive within the configured
idle-nudge timeout, pi-host sends a quiet nudge so silence doesn't
pass without the agent's attention. The choice of what to do next
stays theirs.


## Quick start

```bash
git clone --recurse-submodules <this-repo>
cd <this-repo>
npm install
python3 -m venv .venv && .venv/bin/pip install -e packages/pi-discord/third_party/discli
```

Create `.env` at the workspace root:

```
DISCORD_BOT_TOKEN=<from https://discord.com/developers/applications>
ANTHROPIC_API_KEY=<your key>
```

Start the daemons:

```bash
bash scripts/start-host.sh         # foreground (ctrl-c to stop)
bash scripts/start-host.sh --bg    # background (logs go to runtime dir)
bash scripts/start-discord.sh --bg # likewise
bash scripts/start-all.sh          # both in background
```

Defaults to `~/.local/state/pi-host/` + `~/.local/state/pi-discord/`
for runtime state and `claude-haiku-4-5` for the model. Override pi-
host's model via env:

```bash
PI_HOST_MODEL=claude-opus-4-7 \
PI_HOST_MODEL_NAME="Claude Opus 4.7" \
  bash scripts/start-host.sh --bg
```

To restart in place (preserves session, inherits env from the running
daemon):

```bash
bash scripts/restart-host.sh
bash scripts/restart-discord.sh
```

Interact via the CLI clients:

```bash
bin/pi-ctl get-state
bin/pi-ctl --help

bin/pdc get-state
bin/pdc --help
```

`bin/` symlinks resolve to the two packages' bin scripts; both binaries
end up on the deployed agent's PATH via pi-host's PATH manipulation.


## Testing

```bash
npm test                                   # all TS unit tests
bash scripts/dev-test.sh                   # spawn an Opus 4.7 instance
                                           # in an isolated test cwd
```

`dev-test.sh` creates a fresh `~/pi-host-tests/<timestamp>/` scratch
dir, seeds it with the agent-facing docs, and launches both daemons
with isolated state — useful for getting feedback "from inside"
without touching your real runtime dirs.


## Process topology

```
                            pi (rpc, single owner of stdio)
                                ▲
                                │ JSONL
                                ▼
        ┌───────────────────────────────────────────┐
        │      pi-host daemon                       │
        │  · agent lifecycle (spawn, exit, restart) │  ← ~/.local/state/pi-host/pi-host.sock
        │  · sysprompt slot + session registry      │  ← pi-ctl  (admin verbs)
        │  · idle-nudge + sleep                     │  ← subscriber daemons
        │  · outward RPC + event stream             │
        └───────────────┬───────────────────────────┘
                        │ subscribes via Unix socket
                        ▼
        ┌───────────────────────────────────────────┐
        │      pi-discord daemon                    │
        │  · routing, subscriptions, ping-mode      │  ← ~/.local/state/pi-discord/pi-discord.sock
        │  · buffering, activity digest             │  ← pdc  (Discord verbs)
        │  · pi-host client (deliver + events)      │
        │  · owns discli subprocess                 │
        └───────────────────────────────────────────┘
                        │
                        ▼
                     Discord
```

- pi-host owns pi's stdio exclusively. No subscriber sees raw pi RPC —
  pi-host exposes a stable, higher-level surface that re-emits pi
  events (prefixed `pi:`) plus its own (`host:welcome`,
  `host:pi_exit`, `host:nudge_fired`, `host:sleep_*`, etc.).
- Deliver verbs (`prompt`, `follow-up`, `steer`) are pi-host's curated
  subset of pi's RPC. Calling one auto-cancels any active sleep and
  pending nudge before forwarding. The supervisor also smart-falls-back
  when pi's state doesn't match the verb (e.g. `prompt` while pi is
  streaming becomes a `follow-up`); the response's `delivered_as` field
  announces the actual disposition.
- pi-discord buffers Discord events per delivery mode, formats them
  into `<discord>...</discord>` wrapped user messages with
  `<ping>`/`<channel>`/`<digest>` sub-elements, and delivers via
  pi-host's RPC. pi-host's own injected messages (bootstrap, idle
  nudges) use a `<pi-host>...</pi-host>` wrap — distinct frames, two
  origin sources.


## Layout

```
packages/
  shared/             jsonl framing + duration parsing (no business logic)
  pi-host/
    src/              agent-host, pi-io, bootstrap, sleep-nudge,
                      event-hub, control-server, protocol, daemon, ctl, wrap
    bin/pi-ctl
    .pi/              pi project config + sysprompt extension
    third_party/      pi-acm (vendored), pi (clean upstream submodule)
  pi-discord/
    src/              discli-io, routing, buffering, digest, missed-pings,
                      formatting, pi-host-client, control-server, protocol,
                      daemon, ctl, state
    bin/pdc
    third_party/      discli (Quiterion fork submodule, disclaw-patches branch)
scripts/              start-host, start-discord, start-all, restart-*, dev-test
docs/agent/           agent-facing skills (pi-ctl, pdc, orientation)
docs/dev/             design notes (architecture.md, next_steps.md, welcome.testing.md)
bin/                  workspace-level symlinks to the two ctl binaries
```

See `docs/dev/architecture.md` for the design details and
`docs/dev/next_steps.md` for what's done vs. likely-next.

## Built with

- **pi-coding-agent** (`@mariozechner/pi-coding-agent`) — the agent
  runtime; pi-host owns a single `pi --mode rpc` subprocess as its
  agent loop.
- **pi-acm** (`@earendil-works/pi-acm`, vendored with one local patch)
  — sliding-window context manager. The reason long-running continuity
  is feasible: the active context window stays bounded while the full
  session transcript accumulates on disk.
- **discli** (`DevRohit06/discli`, vendored as `Quiterion/discli`
  disclaw-patches branch) — Discord ↔ JSONL bridge process that
  pi-discord wraps.
- **discord.py** (transitively via discli)
