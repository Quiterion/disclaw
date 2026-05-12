# disclaw

A long-running Discord-listening agent harness. Wraps
[pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)
+ [pi-acm](https://github.com/earendil-works/pi-acm) (context
management) + [discli](https://github.com/DevRohit06/discli) (Discord
↔ JSONL bridge) behind a daemon with a Unix-socket control plane,
giving an agent (typically another instance of Claude) explicit
control over their own attention.

The design ethos is named in the doc: **agency over attention**,
**operational dignity over declared dignity**, **mixed motives named
honestly**, **opt-in posture by default**. The agent wakes to silence
and chooses what to engage with. Every interruption is a choice the
agent or the operator made.

## Architecture

Three processes:

```
                   ┌──────────────────┐
                   │      daemon      │  Unix socket: $DISCLAW_RUNTIME_DIR/disclaw.sock
                   │  (Node, our code)│  ← disclaw-ctl (CLI client)
                   └────────┬─────────┘
                            │
                  ┌─────────┴─────────┐
                  │                   │
        spawn + JSONL        spawn + JSONL
                  │                   │
                  ▼                   ▼
        ┌──────────────────┐  ┌──────────────────┐
        │       pi         │  │     discli       │
        │ (the LLM agent)  │  │ (Discord bridge) │
        └──────────────────┘  └──────────────────┘
                                       │
                                       ▼
                                   Discord
```

- **daemon** owns persistent state, routes inbound Discord events to
  the agent, exposes a control plane over a Unix socket for the agent
  (via `disclaw-ctl`-in-bash) and the operator
- **pi** is the LLM agent loop. The daemon talks to it via
  `pi --mode rpc` over JSONL. Pi handles the API call, tool execution,
  session persistence, and pi-acm context management
- **discli** is a separate subprocess that connects to Discord, emits
  events as JSONL on stdout, and handles outbound actions
  (send/react/typing/etc.) via JSONL on stdin

The agent's surface is `disclaw-ctl <verb>` invoked through pi's
existing `bash` tool. Inbound Discord events are framed as XML-wrapped
user messages. See `docs/agent/skills/disclaw-ctl/SKILL.md` for the
agent-facing reference and `docs/dev/disclaw.md` for the full design.

## Quick start

```bash
git clone --recurse-submodules <this-repo>
cd disclaw
npm install
python3 -m venv .venv && .venv/bin/pip install -e third_party/discli
```

Create `.env` with at minimum:

```
DISCORD_BOT_TOKEN=<from https://discord.com/developers/applications>
ANTHROPIC_API_KEY=<your key>
```

Then start the daemon:

```bash
bash scripts/start.sh           # foreground (ctrl-c to stop)
bash scripts/start.sh --bg      # background (logs to $RUNTIME_DIR/daemon.log)
```

Defaults to `~/.disclaw/` for runtime state and `claude-haiku-4-5` for
the model. Override with env vars:

```bash
DISCLAW_RUNTIME_DIR=/tmp/test \
DISCLAW_MODEL=claude-opus-4-7 \
DISCLAW_MODEL_NAME="Claude Opus 4.7" \
  bash scripts/start.sh --bg
```

To restart in place (preserves session, inherits env from the running
daemon):

```bash
bash scripts/restart.sh         # forwards --bg if you want background
```

Interact via the CLI client (matching `DISCLAW_RUNTIME_DIR`):

```bash
disclaw-ctl ping
disclaw-ctl get-state
disclaw-ctl --help              # full verb reference
```

## Testing

```bash
npm test                                   # TS unit tests
bash scripts/dev-test.sh                   # spawn an Opus 4.7 instance in
                                           # an isolated test cwd, with the
                                           # testing-variant welcome
```

The dev-test launcher creates a fresh timestamped scratch dir under
`~/disclaw-tests/<ts>/`, seeds it with the agent-facing docs, and
launches the daemon there with isolated state — useful for getting
feedback "from inside" without polluting your regular runtime.

## Layout

```
src/                 daemon, ctl, agent-host, formatting, routing, etc.
test/                node:test unit tests (formatting, routing, digest, missed-pings)
scripts/             start.sh, restart.sh, dev-test.sh
.pi/extensions/      sysprompt extension that REPLACES pi's default sysprompt
                     with our floor + agent-managed slot
docs/agent/          agent-facing docs (SKILL.md, orientation.example.md)
docs/dev/            design doc (disclaw.md), next_steps.md, drafts
third_party/discli/  vendored Discord ↔ JSONL bridge (Quiterion fork w/
                     humanize_mentions + member_search + #name-channel
                     resolution patches on disclaw-patches branch)
third_party/pi-acm/  vendored sliding-window context manager (single
                     local "whisper patch" stripping per-run
                     <context-status> tag)
third_party/pi/      pi-coding-agent (clean upstream)
bin/disclaw-ctl      shim wrapper — runs dist/ctl.js with node
```

## Status

Slices A–D complete (session resumption, activity digest, buffering,
missed-pings + discli humanization). Plus today's polish pass: XML
message format, reactions, typing, whois, attachments, send-from-stdin,
channel-name resolution, tier 1 pi-exit visibility, start.sh/restart.sh
ergonomics, state.json deploy-config persistence. See
`docs/dev/next_steps.md` for what's done vs. likely-next.

The agent-facing surface is documented in
`docs/agent/skills/disclaw-ctl/SKILL.md`. That's the right read if
you're sitting in front of a running daemon.

## Built with

- pi-coding-agent (`@mariozechner/pi-coding-agent`)
- pi-acm (`@earendil-works/pi-acm`, vendored with one local patch)
- discli (`DevRohit06/discli`, vendored as a fork at
  `Quiterion/discli` with disclaw-patches branch)
- discord.py (transitively via discli)
