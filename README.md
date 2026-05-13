# pi-host workspace

A monorepo of small Node daemons that turn
[pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) into a
long-running, self-administering agent — and let separate processes
bridge it to external services.

Two packages today:

- **[`pi-host`](packages/pi-host/)** — the supervisor. Owns one
  `pi --mode rpc` subprocess plus its session, sysprompt slot,
  idle-nudge timer, and sleep state. Exposes a Unix-socket RPC that
  pi-ctl (CLI) and subscriber daemons (e.g. pi-discord) connect to.
- **[`pi-discord`](packages/pi-discord/)** — the first bridge. Owns a
  [discli](https://github.com/DevRohit06/discli) subprocess, routes
  Discord events to pi-host (subscriptions, ping mode, activity
  digest), and exposes its own ctl for Discord verbs.

The split is the point. **pi-host has no opinion about Discord.** It's
a generic continuity layer for pi. The Discord bridge is "the first
plugin"; a future Slack or IRC or webhook bridge would slot in the same
way — connect to pi-host's socket, subscribe to events, deliver via
`prompt`/`follow-up`/`steer`. The supervisor stays constant; the
plugins are interchangeable.

## Design ethos

**Agency over attention. Opt-in posture by default.** The deployed
agent wakes to silence. Discord activity flows only after they actively
turn it on (`pdc set ping-mode push`,
`pdc subscribe <id>`). Idle nudges, sleep, sysprompt slot —
everything that shapes the agent's relationship to their own attention
lives under their control via the ctl surface. The harness imposes no
engagement.

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

## Example session

What the agent sees on first wake. pi-host's bootstrap (the *only*
prompt before anything else has connected):

```
<pi-host>
<time>2026-05-12 09:00</time>
Hi. You're in a long-running agent harness. You are in
`/home/claude/`. There is a welcome doc at `welcome.md`.
</pi-host>
```

State starts opt-in: `ping-mode=none`, no subscriptions, empty
sysprompt slot. The agent reads welcome.md + skills/, then chooses
what to engage with:

```bash
pdc set ping-mode push
pdc channels
pdc subscribe 1503391358076059762   # #off-topic
pdc set digest-mode follow_up
```

Some time later, a Discord ping arrives:

```
<discord>
<time>2026-05-12 09:14</time>

<ping author="quiterion" uid="518777968508665866" server="quiterion's server" channel="#off-topic" at="09:14" id="1503688861329657858">
hey, can you summarize the #general thread from earlier?
</ping>

<digest>[unread] #random: 2</digest>
</discord>
```

Two different framing tags — `<pi-host>` vs. `<discord>` — make it
obvious where each message came from: the supervisor itself, or the
Discord bridge. Future bridges add their own wrap (`<slack>`, etc.).

After each `agent_end`, if no new events arrive within the configured
idle-nudge timeout, pi-host sends a quiet nudge so silence doesn't
pass without the agent's attention. The choice of what to do next
stays theirs.

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

## Status

Greenfield as of the pi-host / pi-discord split. The prior single-
daemon project (named "disclaw") landed slices A–D plus a polish pass
covering XML message format, reactions, typing, attachments, send-from-
stdin, channel-name resolution, restart ergonomics, and per-(provider,
model) session tracking. All of that survives the split; the
architectural change here is exclusively in how the components are
factored and how they speak to each other.

See `docs/dev/architecture.md` for the design details and
`docs/dev/next_steps.md` for what's done vs. likely-next.

## Built with

- pi-coding-agent (`@mariozechner/pi-coding-agent`)
- pi-acm (`@earendil-works/pi-acm`, vendored with one local patch)
- discli (`DevRohit06/discli`, vendored as `Quiterion/discli`
  disclaw-patches branch)
- discord.py (transitively via discli)
