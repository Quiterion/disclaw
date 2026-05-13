# Architecture

How the workspace is factored, why, and what each piece is
responsible for.

## Two daemons, one philosophy

The workspace splits cleanly along the question *"is this about the
agent's own continuity, or about a specific external service?"*

- **pi-host** is the continuity layer. It owns one `pi --mode rpc`
  subprocess for as long as the daemon is up, the sysprompt slot, the
  per-(provider,model) session registry, the idle-nudge timer, and
  sleep state. It exposes a Unix-socket RPC that ctl clients and
  subscriber daemons both connect to.

- **pi-discord** is the first bridge. It owns a discli subprocess
  (Discord ↔ JSONL), routes Discord events into pi-host via the
  supervisor's deliver verbs, exposes Discord-specific ctl verbs
  (`subscribe`, `send`, `react`, `set-ping-mode`, etc.), and is the
  *only* thing in this workspace that knows about Discord. A future
  Slack or IRC or wiki-watcher bridge would slot in identically.

This is the post-split shape; the prior single-daemon design (named
"disclaw") welded these two concerns and they're now separated. The
philosophy is unchanged:

**Agency over attention. Opt-in posture by default.** The agent wakes
to silence — no subscriptions, ping-mode=none, digest-mode=none,
empty sysprompt slot. Every configurable surface puts control of the
agent's attention with the agent. The harness imposes nothing.

## Process topology

```
                            pi (rpc, single owner of stdio)
                                ▲
                                │ JSONL
                                ▼
        ┌───────────────────────────────────────────┐
        │      pi-host daemon                       │
        │                                           │  ← pi-ctl (admin verbs)
        │  Owns pi's stdio exclusively.             │  ← pi-discord (subscriber)
        │  Exposes a higher-level RPC that          │  ← any future bridge
        │  re-emits pi events and originates        │
        │  its own.                                 │
        └───────────────┬───────────────────────────┘
                        │ subscribes via Unix socket
                        ▼
        ┌───────────────────────────────────────────┐
        │      pi-discord daemon                    │  ← pdc
        │                                           │
        │  Translates Discord events ↔ pi-host      │
        │  deliver verbs. Owns its own state,       │
        │  socket, ctl surface.                     │
        └───────────────────────────────────────────┘
                        │
                        ▼
                     Discord
```

Sockets live under `~/.local/state/<pkg>/`:

- `~/.local/state/pi-host/pi-host.sock`
- `~/.local/state/pi-discord/pi-discord.sock`

Override either with `PI_HOST_RUNTIME_DIR` /
`PI_DISCORD_RUNTIME_DIR`, or `PI_HOST_SOCKET` (explicit path) for
unusual setups.

## pi-host's outward RPC

JSONL framing over Unix socket, same connection style as today's
control plane plus a subscriber surface for long-lived clients.

### Verbs

**Connection / event stream:**
- `ping` → `"pong"`
- `hello { name, purpose? }` — identify yourself (logged; visible in
  `get-state.host.subscribers`)
- `subscribe { events?: string[] }` — opt into the event push.
  Without `events`, all events flow. Filters are prefix matches:
  `["pi:", "host:nudge_*"]` or similar.
- `unsubscribe` — stop the event push on this connection;
  request/response still works.

**Agent self-administration:**
- `get-state` → unified snapshot (host meta, pi runtime, agent config)
- `sysprompt-get` → `{ value }`
- `sysprompt-set { value }` → `{ chars }`
- `sysprompt-clear` → `{}`
- `set-idle-nudge-timeout { timeout_ms | null }` → `{ timeout_ms }`
- `sleep { duration_ms? }` → `{ until_ms | null }`
- `wake` → `{}`

**Pi pass-through (deliver verbs):**
- `prompt { message }` → `{ delivered_as }`
- `follow-up { message }` → `{ delivered_as }`
- `steer { message }` → `{ delivered_as }`
- `abort` → `{}`

The three deliver verbs let subscribers push activity into pi without
sharing the pipe. They centralize "real activity arrived"
semantics — every deliver auto-cancels any pending nudge and any
active sleep before forwarding. They also smart-fall-back: if pi's
state doesn't match the verb (e.g. `prompt` while pi is mid-turn),
pi-host downgrades to `follow-up`; the response's `delivered_as`
announces the actual disposition.

### Events

Pushed asynchronously to subscribers after `subscribe`. No `req_id`
(matches pi's RPC convention; events have an `event:` field instead
of a `cmd:`/`ok:` pair).

**`pi:*` — pass-through of pi's RPC event stream:**

`pi:agent_start`, `pi:agent_end`, `pi:turn_start`, `pi:turn_end`,
`pi:message_start`, `pi:message_update`, `pi:message_end`,
`pi:tool_execution_*`, `pi:compaction_*`, `pi:auto_retry_*`,
`pi:queue_update`, `pi:extension_error`.

We deliberately drop `extension_ui_request` (bidirectional sub-
protocol we don't expose to subscribers).

**`host:*` — originated by the supervisor:**

- `host:welcome { host_uptime_ms, deploy }` — sent to a subscriber
  right after their `hello`, identifies the host and deploy config
- `host:pi_alive` — pi is up (sent after welcome; emitted on respawn
  if/when implemented)
- `host:pi_exit { code, signal }` — pi died
- `host:bootstrap_first_run` — first-run prompt was injected
- `host:sysprompt_changed { chars }` — slot was updated
- `host:sleep_started { until_ms }` / `host:sleep_expired` /
  `host:sleep_cancelled { by }` — sleep state transitions
- `host:nudge_fired { reason }` — `reason` is `"idle"` or
  `"sleep-expired"`
- `host:idle_nudge_timeout_changed { timeout_ms }`

## pi-discord's surface

JSONL over its own Unix socket. Strictly request/response — pi-
discord doesn't push events. The verbs:

- `ping`, `get-state`
- Subscriptions: `subscribe`, `unsubscribe`, `list-subscriptions`
- Routing modes: `set-ping-mode`, `set-digest-mode`
- Digest: `digest`, `digest-ack`
- Missed pings: `missed-pings`, `missed-pings-clear`
- Discord I/O: `send`, `history`, `channels`, `whois`, `typing-start`,
  `typing-stop`, `react`, `unreact`

`get-state` reports bridge state, discli connection, pi-host
connection status, last-known pi idle state, and routing config.

## Message framing

Two distinct XML wraps, one per origin:

- pi-host's own injected messages (first-run bootstrap, idle nudges,
  sleep-expired nudges): `<pi-host>...</pi-host>`
- pi-discord deliveries: `<discord>...</discord>` containing
  `<ping>`/`<channel>`/`<digest>`/`<attachment>` sub-elements

A `<time>` opener inside each wrap carries the delivery wall-clock so
transcript readers years later can place each message in time.

Future bridges follow the same pattern: their own wrap element
(`<slack>`, `<irc>`, whatever) so the agent can always tell *which
subsystem* originated a message just by reading the framing tag.

## State boundaries

Each daemon owns its own state file under its runtime dir; they
don't share storage.

**pi-host state.json:**
- `initialized` (first-run flag)
- `sysprompt`
- `provider`, `model`, `model_name` (deploy config, for cold-restart
  recovery)
- `idle_nudge_timeout_ms`
- `sessions: Record<provider:model, path>` (per-(provider, model)
  session registry)

**pi-discord state.json:**
- `subscriptions: string[]`
- `ping_mode`
- `digest_mode`

The digest accumulator and typing-timer state are in-memory only.
The missed-pings log is its own append-only JSONL file under pi-
discord's runtime dir.

## Why this shape

The earlier (pre-split) project bundled all of this into a single
"disclaw" daemon that owned both pi and discli, where Discord-shaped
state (subscriptions, ping mode, missed pings, the activity digest)
and pi-shaped state (sysprompt, sessions, sleep) lived in the same
config file and were controlled by the same ctl tool. This worked,
but it framed the entire project as "a Discord-bot-agent-harness"
when the actual deployment intent is closer to "a continuity layer
for pi, with Discord wired up as one of several possible bridges."

The split makes that explicit:

- **pi-host is the constant.** It does the same job whether or not
  any bridge is connected. A future Slack bridge doesn't need to
  re-implement sleep, nudges, sysprompt slot, or session resumption.

- **bridges plug in.** They subscribe to pi-host's event stream,
  speak the supervisor's deliver-verb protocol, and own their own
  external-service state. Adding a bridge is a new package; removing
  one is a `rm -rf packages/X`.

- **state boundaries are honest.** Subscriptions live with pi-
  discord because they describe what reaches the agent *from
  Discord*. The sysprompt lives with pi-host because it's a property
  of the agent's identity. The bridge can't accidentally write the
  agent's sysprompt; the agent can't subscribe to a Discord channel
  from `pi-ctl`. The natural boundary is enforced by which socket
  you're talking to.

## Why subscriber model (vs. shared pi RPC)

A naive alternative would have been to have pi-discord (and future
bridges) talk directly to pi's stdin/stdout. Pi-host exposes a
*higher-level* surface instead — re-emitting pi events with stable
shape, originating its own (nudge / sleep / bootstrap / sysprompt-
changed), and centralizing the smart-fallback that adapts deliver
verbs to pi's current state.

Three reasons:

1. **Single owner of pi's stdio.** Two writers on stdin would
   contend for `id` correlation. The pipe needs an exclusive owner.
2. **Stable contract.** Subscribers depend on pi-host's protocol,
   not pi's. Pi can evolve (or be replaced) without breaking
   bridges.
3. **Supervisor-originated events live with everything else.** An
   idle nudge, a sleep timer firing, a bootstrap prompt arriving —
   all of these are signals a bridge might want to react to (e.g.
   update Discord presence). They flow through the same event
   stream as pi's RPC events; subscribers don't need a second
   channel to learn about them.

## Layout

```
packages/
  shared/             jsonl framing, duration parsing
  pi-host/
    src/
      protocol.ts          host RPC types (HostRequest, HostResponse, HostEvent)
      pi-rpc-types.ts      narrow pi-RPC fragments we depend on
      state.ts             sysprompt, sessions, idle-nudge config
      pi-io.ts             PiProcess: wraps `pi --mode rpc`
      agent-host.ts        AgentHost: lifecycle + prompt/follow-up/steer/abort
      bootstrap.ts         first-run-prompt
      sleep-nudge.ts       sleep state + idle-nudge timer
      event-hub.ts         subscriber registry + event dispatch
      control-server.ts    Unix-socket server (req/resp + pub/sub)
      wrap.ts              <pi-host>...</pi-host> framing
      daemon.ts            entry point — wires it all together
      ctl.ts               pi-ctl CLI
    bin/pi-ctl
    .pi/extensions/sysprompt/   pi extension that *replaces* default sysprompt
    third_party/
      pi-acm/                   vendored sliding-window context mgmt
      pi/                       clean upstream submodule (not the runtime pi)

  pi-discord/
    src/
      protocol.ts          ctl request/response + DiscordDaemonState
      state.ts             subscriptions, ping-mode, digest-mode
      discli-io.ts         DiscliProcess: wraps `discli serve`
      routing.ts           pure-function routing decisions
      buffering.ts         per-mode event buffers + flush triggers
      digest.ts            activity-digest accumulator + formatter
      missed-pings.ts      append-only log of dropped pings
      formatting.ts        <discord>/<ping>/<channel>/<digest>/<attachment> wraps
      pi-host-client.ts    subscriber connection to pi-host
      control-server.ts    Unix-socket server (req/resp only)
      daemon.ts            entry point
      ctl.ts               pdc CLI
    bin/pdc
    third_party/
      discli/                   vendored Discord ↔ JSONL bridge (Quiterion fork)

scripts/                   start-host, start-discord, start-all,
                           restart-host, restart-discord, dev-test
bin/                       workspace-level symlinks to the two ctl binaries
                           (added to pi's agent PATH by pi-host on spawn)
docs/agent/                agent-facing skill docs + orientation example
docs/dev/                  this file, next_steps.md, welcome.testing.md
```
