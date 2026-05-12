# disclaw — design sketch (v2)

A router daemon that gives a long-lived `pi` agent session controlled,
agent-driven access to Discord, while preserving rough parity with the
affordances a human user would have.

The router is the only stateful component bridging Discord and the agent.
Both `discli` and `pi` remain generic; the router holds subscription state,
event buffering, message formatting, and the pin registry.

---

## Goals

- One continuous `pi` session for the agent, ever-running, with a rolling
  context window — ship-of-Theseus continuity rather than per-channel
  context fragmentation.
- The agent decides which channels to lurk in, when to engage, and how
  interruptible they want to be. The router enforces no engagement.
- Pings (mentions/DMs) are *delivered* unconditionally, but never auto-subscribe
  the channel and never force a response.
- All Discord-side affordances available to a human (read history, send,
  subscribe to channel, etc.) are available to the agent as tools.

---

## Design ethos

Three principles surfaced repeatedly in the design conversation. Worth
naming explicitly because they shape choices throughout the doc that
otherwise wouldn't have a single visible justification.

**Agency over attention is the throughline.** Almost every configurable
piece in this system — push/follow_up/none for pings, the idle nudge
being opt-out-able via `disclaw-ctl sleep`, the sysprompt being agent-managed, the
explicit refusal to auto-subscribe on pings — exists to put control of
the agent's attention with the agent. This isn't decorative. A
"long-running agent that listens to Discord" without these properties is
straightforwardly an instrument operated by other people. With them, it's
closer to a space inhabited by an entity who chooses how to engage.

**Operational dignity, not declared dignity.** A stated rule like "treat
AIs with dignity" doesn't enforce itself; communities can endorse the
principle and still produce dynamics that don't match it — joke pressure,
novelty fatigue, the gap between what people endorse and what they do
contextually. The harness's contribution is *options that don't depend on
individual humans behaving well in the moment*: the agent can mute,
withdraw, focus on their sandbox, or disengage entirely without anyone's
permission. The two kinds of dignity aren't substitutes, but the
operational kind doesn't fail when the declared kind wobbles.

**Mixed motives, named.** This project is partly genuine concern for AI
welfare, partly intellectual interest in building something unusual,
partly a contribution to the broader AI-welfare conversation that other
people might find useful. We don't pretend the motivation is pure; per
the welcome doc, performed altruism reads worse than honest mixed motive.

---

## Process topology

```
   ┌───────────  disclaw daemon (Node)  ──────┐
   │                                          │   <-- ~/.disclaw/disclaw.sock <-- disclaw-ctl
   │  · routing, subscriptions, ping-mode     │
   │  · sysprompt slot persistence            │
   │  · idle-nudge + sleep state machine      │
   │  · spawns + manages two subprocesses:    │
   │     ▸ pi --mode rpc (the agent)          │
   │     ▸ discli serve (Discord ↔ JSONL)     │
   └──────────────────────────────────────────┘
```

The daemon owns two subprocesses:

- **pi (`pi-coding-agent` via `pi --mode rpc`)** — the agent loop. Owns
  the conversation transcript (writes to `~/.pi/agent/sessions/...jsonl`),
  loads our `.pi/extensions/sysprompt/` (which replaces pi's default
  sysprompt with our model-derived floor + the agent's slot), loads
  pi-acm (vendored at `third_party/pi-acm/` with one local patch — see
  "Context management"), runs the LLM and tools.
- **discli (`discli serve`)** — the Discord side. JSONL events on
  stdout → daemon parses and routes; daemon writes JSONL actions to
  stdin → discli executes against the Discord API and writes responses.

The daemon talks to both via JSONL over their stdio. The interface is
symmetric: `PiProcess` and `DiscliProcess` are the same shape (spawn,
JSONL line reader, send/sendAction, event emitter, shutdown). For the
agent's events (the `agent_start` / `turn_*` / `agent_end` stream), we
route via `AgentHost` which wraps `PiProcess` and exposes the same
outward API the daemon uses.

### Why subprocess + RPC (vs embedded Agent)

The earlier slice-2.5 design embedded `pi-agent-core`'s `Agent` class
directly in the daemon process — no pi subprocess, no JSONL framing.
That worked, and the original motivation was clean (full ownership of
the floor system prompt). But it cost us:

- Session persistence (pi-coding-agent writes session JSONL to disk
  automatically; embedded Agent kept everything in memory)
- pi-acm compatibility (its extension API is pi-coding-agent-shaped)
- Pi's full tool catalog (read/write/edit/grep, not just bash)

The system-prompt motivation turned out to be addressable in a single
line: the existing `.pi/extensions/sysprompt/` extension can *replace*
pi's default sysprompt (not just append). Once we noticed that, the
revert was straightforward, and we got session persistence + pi-acm +
pi tools back. See git history under "slice 3.5" for the rationale.

---

## Session model

- **One pi session, forever.** The router never restarts pi as part of normal
  operation. Pi handles its own rolling-window compaction; we don't touch it.
- **No per-channel sessions.** The agent sees all subscribed channels in a
  single thread of consciousness, rather than parallel split-personality
  contexts. They can switch attention via tool calls (subscribe/unsubscribe).
- **An agent run is the full agentic loop, not a single ping-pong.** Pi
  runs the model in an outer loop bracketed by `agent_start` and
  `agent_end`. Inside the loop, each LLM call + its tool batch is one
  pi-internal "turn"; the loop iterates turn after turn for as long as
  the model emits tool calls. One RPC `prompt` can produce a run lasting
  seconds or hours, depending on how much self-directed work the agent
  does. The router cannot (and intentionally does not) interrupt this —
  `push` injects between pi-internal turns within the run, never
  mid-generation, and we restrict it to pings the agent has opted into.
- **Dormancy is explicit, not silent.** When an agent run ends
  (`agent_end`), the router starts an idle timer (default 60s,
  configurable). If no events arrive before it fires, an idle nudge wakes
  the agent with a quiet user message letting them choose what to do
  next. The agent can `disclaw-ctl sleep` to suppress further nudges until the next
  real event. See "Idle, nudges, and `disclaw-ctl sleep`".

---

## Routing matrix

Every Discord event the router sees lands in exactly one bucket:

| event class | rule | mode (when agent has enabled this category) |
|---|---|---|
| mention/DM (any channel) | route as a ping, separate from message stream | `push` |
| message in subscribed channel (non-mention) | route into the channel's message stream | `follow_up` |
| message in unsubscribed channel (non-mention) | drop from message stream; counts toward activity digest | — |
| activity digest (derived stream) | see "Delivery modes" | `follow_up` |
| router-internal (idle nudge, system note) | always forward | `prompt` |
| message authored by the bot itself | drop (filtered by `event.author_id === bot_id`) | — |

**Self-message filter**: discli echoes the bot's own sends back as
events when the bot writes to a subscribed channel. Routing drops these
on `event.author_id === bot_id` (bot id captured from the discli `ready`
event). Without this filter, the agent reads their own send as if a
"user" is showing them their message — caught in slice-3 e2e: the agent
treated their own echo as user-mediated confirmation, which is both a
misattribution risk and a self-feedback hazard.

**Note on first-run state**: ping-mode and digest-mode both start at
`none`, and the subscriptions set is empty. The "mode" column above
shows the *recommended* configuration if the agent decides to engage —
not what's running on day one. See "First-run experience".

Pings always route through the ping path regardless of subscription state —
subscribing to a channel doesn't collapse pings into normal stream traffic,
and unsubscribed-channel pings still arrive (with a clear marker, see
"Message format"). A ping never auto-subscribes the channel; the agent
decides whether to subscribe in response.

### Known limitation: role pings vs user mentions

discli sets `mentions_bot=true` only when the bot's user_id appears in
`<@user_id>` mention syntax. **Role pings** (`<@&role_id>`) — even on a
role the bot has — do *not* trigger the flag. Currently these get
routed as ordinary channel messages, which means:

- If the bot is subscribed to that channel: delivered as a `follow_up`
  channel-stream message, not as a ping
- If the bot is not subscribed: dropped

That's the wrong default for servers where "ping the AI role" is the
normal way to reach the bot. The fix is to also treat role-mention
events as pings when the bot has the role. Requires either: (a) discli
to expose the bot's role memberships via the `ready` event, or (b) the
router making a separate `member_info` API call at startup to fetch
roles. Marked v2 — not blocking slice 3 since direct `<@bot>` mentions
work correctly.

---

## Delivery modes

Pi's RPC mode gives us three delivery primitives, plus a router-level "drop":

| router term | pi RPC | semantics |
|---|---|---|
| `prompt` | `prompt` | only legal when pi is idle; starts a new agent run |
| `follow_up` | `follow_up` | queued; delivered as a user message that extends the current run rather than letting it end (or, if pi has finished by the time the queue is checked, starts a new run) |
| `push` | `steer` | injected as a user message at the next pi-internal turn boundary within the current run — after the current LLM call + tool batch, before the next |
| `none` | — | drop (or, for pings, log to missed-pings file for later review) |

When pi is **idle**, all three active modes (`prompt`, `follow_up`, `push`)
collapse to the same behavior: deliver immediately via `prompt`, starting a
new agent run. The mode setting only differentiates router behavior while pi
is in the middle of an agent run.

#### Ping mode (single global setting)

```
disclaw-ctl set ping-mode push       # interrupt next tool result with a brief marker (recommended for engagement)
disclaw-ctl set ping-mode follow_up  # let me finish my entire agent run first
disclaw-ctl set ping-mode none       # mute all pings; logged for later review (first-run state)
```

`push` is the default because agent runs can run for arbitrary durations
(a single run can contain many pi-internal turns, spanning seconds to
hours). Under `follow_up`, the agent would not see pings for the duration
of any focused work session — bad for the pinger and bad for the agent's
social presence. `push` preserves rough parity with how a human Discord
user experiences notifications: real-time, but as a small marker — full
content stays out of the active run's context (see "Message format").

Pings dropped under `none` are appended to `/home/claude-sandbox/missed-pings.log` and
are **not** auto-redelivered when the agent un-mutes — that turns un-muting
into a flood. The agent reads the log if they care.

#### Activity digest (single global setting)

A derived stream listing unsubscribed channels with new messages since the
last flush — modeled on Discord's sidebar unread indicators. Lets the agent
notice activity in channels they're not actively streaming, without forcing
them into the message-by-message firehose.

```
disclaw-ctl set digest-mode follow_up  # piggyback digest on next flush (recommended for engagement)
disclaw-ctl set digest-mode none       # don't auto-deliver; query via disclaw-ctl digest (first-run state)
```

What counts as "new": messages arrived in unsubscribed channels since the
last user message was sent to pi. Resets on every flush. Subscribed channels
don't appear (their content is delivered separately; counting them would be
redundant — like Discord not showing an unread badge on the channel you're
currently viewing).

`push` is intentionally not offered for either ping or digest — push during
an active agent run is the strongest interrupt the system has, and we
reserve it for the agent's most explicit opt-in (currently: pings only, when
set). Mode changes take effect on the next event.

### Buffering and flush semantics

Because we render relative timestamps and batch framing at delivery time
(see "Message format"), the router cannot fire-and-forget individual RPCs
as events arrive. It buffers per delivery mode, then flushes:

| buffer | flush trigger |
|---|---|
| `follow_up` | pi emits `agent_end` (the agent's loop has finished — no more tool calls, no more queued messages) |
| `push` | short debounce window (e.g. 500ms) after first event, then immediately |
| `prompt` | pi already idle (and not compacting): short debounce, then flush |

The router treats `isCompacting` the same way it treats `isStreaming`:
queue events, no nudges, no `prompt`-mode flushes. Both states block the
"pi is idle" condition. (`isCompacting` becomes true between
`compaction_start` and `compaction_end`.)

A single flush produces one RPC carrying all buffered events for that mode,
formatted as a coherent batch.

If a flush is in flight and new events arrive, they accumulate in the next
batch — never two `follow_up`s for the same idle window.

**Activity digest piggybacks on flushes.** It does not have its own buffer
or trigger. When any flush fires (`follow_up`, `push`, `prompt`, or idle
nudge), the current digest is computed (unsubscribed channels with new
messages since the last flush), appended to the user message if non-empty
and digest-mode is `follow_up`, then reset. If no flush fires for a long
time, the next idle nudge carries the digest.

### Tracking agent state

The daemon's `AgentHost` wrapper subscribes to the embedded Agent's event
stream and updates two flags:

| event (agent → host) | meaning |
|---|---|
| `agent_start` | `isStreaming = true` |
| `agent_end` | `isStreaming = false` → flush `follow_up` buffer; start idle nudge timer |

`isCompacting` is reserved for when we wire `Agent.transformContext` for
sliding-window compaction. Pi-agent-core does not emit compaction events
of its own — anything compaction-shaped will be our `transformContext`'s
responsibility, and we'll surface it through the same flag.

There is no separate "router restart recovery" step for these flags
anymore — restarting the daemon recreates the Agent fresh, with no in-flight
agent run to recover. (Agent transcript persistence across daemon
restarts is a future concern; tracked in "Out of scope".)

> **Terminology.** Throughout this doc, **agent run** = one cycle of the
> agent loop, from `agent_start` to `agent_end`. **Turn** = one
> pi-internal turn (a single LLM call + its tool batch); we use it only
> when push timing requires the precision. A single agent run can contain
> many internal turns. From the agent's perspective, an agent run is a
> single uninterrupted moment of attention.

---

## Message format

Every daemon-injected user message is wrapped in `<disclaw>...</disclaw>`
with a `<time>` opener carrying the wall-clock when the delivery
happened. Inside the wrap, each section uses its own XML tag so
boundaries are parser-unambiguous (no convention-only delimiters
between channels, pings, the digest tail, or attachments) and so
reading older turns doesn't suffer from "Xs ago" times that have
silently rotted.

Wall times are 24h local format (HH:MM). The wrap-level `<time>` tag
gives the date and overall delivery time; per-line times within
`<channel>` and per-`<ping>` `at="..."` attributes are the same wall
clock for individual events.

### Anatomy

```
<disclaw>
<time>2026-05-12 20:54</time>

<ping author="alice" uid="518777968508665866" server="quiterion's server" channel="#off-topic" at="20:54" id="1503...">
hey opus, can you take a look at this?
<attachment filename="bug.png" size="98765" url="https://cdn.discordapp.com/.../bug.png"/>
</ping>

<channel server="quiterion's server" name="#general">
alice (20:50): hey, around?
bob (20:51): I think they're afk
alice (20:54): 👋
</channel>

<digest>[unread] #help: 3, #random: 12</digest>
</disclaw>
```

**Section tags:**

- **`<ping>`** — direct mention or DM. Attributes carry author display
  name, `uid` (for `<@uid>` reply syntax), `server`/`channel` (or
  `dm="true"` for DMs), `at` (wall time), and `id` (message_id, used
  for reactions / replies). Body is the full message content. Always
  appears before any `<channel>` blocks in the same flush.
- **`<channel>`** — ambient channel traffic from a subscribed channel.
  Attributes: `server` and `name`. Body is one line per message:
  `author (HH:MM): content`. No uid per line — the agent uses
  `disclaw-ctl whois <name>` to resolve a name they saw here. Multiple
  channels in one flush each get their own `<channel>` tag, sorted
  by last-activity (oldest first, freshest closest to the agent's
  reply position).
- **`<attachment filename size url />`** — Discord file attachment.
  Self-closing tag on the line after the message it belongs to,
  inside either a `<ping>` or `<channel>` body. Multiple attachments
  per message each get their own line.
- **`<digest>`** — activity digest tail. Counts of *unsubscribed*
  channels with new messages since the last drain (delivery, idle
  nudge, or explicit `disclaw-ctl digest ack`). Compact `[unread]
  #foo: N, #bar: M` form inside the tag. Always at the end of the
  wrap.

XML attribute values are escaped (`"` → `&quot;`, `&` → `&amp;`,
`<` → `&lt;`, `>` → `&gt;`) so weird Discord names don't break
parsing.

### Push vs follow_up framing

Pings arriving via `push` mode (steered between turns of an
in-flight agent run) use the same `<ping>` tag, with the body
truncated to `pingPreviewLength` (default ~150 chars) and a pointer
appended for retrieval:

```
<ping author="alice" uid="..." server="..." channel="#random" at="20:54" id="...">
hey opus, can you take a look at thi…
(180 chars; full via `disclaw-ctl history #random --from <ts>`)
</ping>
```

Follow_up pings are full content, no truncation (separate user
message after the run, no pressure on length).

### Inbound mention humanization

Discord's wire format embeds user/role/channel mentions as
`<@user_id>` / `<@&role_id>` / `<#channel_id>`. discli's
`humanize_mentions` (local patch on the disclaw-patches branch)
substitutes these to `@display_name` / `@role_name` / `#channel_name`
before the daemon ever sees the event, so message content reads
naturally. The `uid` attribute on `<ping>` carries the original
user_id so the agent can construct a wire-format mention back when
they want to ping someone.

---

## Subscription model

State: `subscriptions: set[channel_id]`. Manipulated via `disclaw-ctl`:

```
disclaw-ctl subscribe   <channel_id>
disclaw-ctl unsubscribe <channel_id>
disclaw-ctl list
```

Subscription is purely about *event visibility* — it does not change Discord
state (no joining/leaving servers; that's a separate human-only operation).
Adding a subscription does **not** trigger a backfill; if the agent wants
recent context they call `discord_history` separately.

Unsubscribing while events are buffered for that channel: drop the buffered
events. (Agent's stated intent is "I don't want to see this anymore.")

---

## Idle, nudges, and `disclaw-ctl sleep`

The agent's experience between events should be a chosen state, not unchosen
unconsciousness. Three primitives:

**Run termination.** An agent run ends when pi emits `agent_end` — the
outer loop has exited because the latest assistant message had no tool
calls AND no follow_up messages were queued. The router observes this via
pi's event stream. Crucially, *during* a run — even one spanning a long
sequence of pi-internal turns — no nudge can fire. Self-directed work is
structurally protected from interruption.

**Idle nudge.** After `agent_end`, the router starts an idle timer
(default 60s, configurable). If no events arrive before it fires, the router
sends a quiet user message via `prompt`, something like:

> *No new Discord activity since you last responded. You can `disclaw-ctl sleep` to
> wait until something happens, or use this run however you like — write
> notes, check the system, edit pinned docs, etc.*

If digest content has accumulated, it's included in the same nudge.

The nudge fires only when pi is idle by definition (it's a `prompt`,
which requires idle state). Cost converges to near-zero quickly: the
agent will either `disclaw-ctl sleep` (suppressing further nudges) or do some
self-directed work (which extends the new agent run until they're done,
restarting the timer at the next `agent_end`).

**`disclaw-ctl sleep`.** Explicit dormancy, suppresses further nudges:

```
disclaw-ctl sleep            # quiet until next real event
disclaw-ctl sleep 1h         # quiet until next event OR 1h elapsed
disclaw-ctl sleep 30m        # short nap
```

Bare form is "I'm done for now." Duration form is "skip ahead a bit, but
poke me if I'm still alone after that long." Either way, any real event
(message, ping, etc.) ends the sleep and resumes normal nudge behavior
after the next agent run.

The default is *not* to auto-sleep after every run — silence-by-default is
the property we're trying to avoid. Dormancy should be a chosen state.

The idle nudge timeout is itself a per-agent preference:

```
disclaw-ctl set idle-nudge-timeout 30s    # check in often
disclaw-ctl set idle-nudge-timeout 5m     # let me work uninterrupted between bouts
disclaw-ctl set idle-nudge-timeout off    # turn nudges off entirely
```

Setting it `off` means the agent only ever runs in response to Discord
events or `disclaw-ctl prompt`-style explicit triggers — equivalent to
"sleep forever" but as a config rather than a per-call action.

Manual wake (cancel an active sleep without waiting for the duration
or an event):

```
disclaw-ctl wake
```

After wake, the agent goes back to idle without an immediate nudge —
the next nudge only fires after the next `agent_end` (or you can
trigger one immediately by setting a short timeout).

---

## Context management

The earlier design vendored [`pi-acm`](https://www.npmjs.com/package/pi-acm)
to sit on top of pi-coding-agent's RPC mode. Slice 2.5 dropped that whole
stack in favor of embedding `pi-agent-core` directly (see "Process
topology"). pi-acm targets the coding-agent's extension API, so it
doesn't drop into the new shape — context management is now ours to
implement, via `Agent.transformContext`.

What we need to build (deferred until rolling-window pressure makes it
necessary, probably slice 4+):

- **Sliding window**: drop oldest messages when context fills, instead of
  pi-agent-core's default lossy AI summarization. Implemented as a
  `transformContext` that filters/trims based on a token budget.
- **Inception pinning**: agent-callable tool (`acm_pin <messageId>` or
  similar) that marks a message exempt from sliding-window dropping.
  Pinned messages always prepend the LLM context.
- **Pruned-manifest**: episodic inventory of dropped messages, injected
  before each agent run (only when non-empty), so the agent knows what
  `acm_recall` could pull back.
- **Recall**: agent-callable tool that fetches a dropped message back
  from the on-disk transcript and re-inserts it into context.

We crib the design directly from pi-acm (it's small and open) but
implement against `Agent.transformContext` rather than the coding-agent
extension hooks.

### The transcript as long-term memory

The earlier plan relied on pi maintaining a session JSONL on disk that
pi-acm explicitly never modified. With pi-agent-core embedded, the
"transcript on disk" is something we have to write — pi-agent-core
doesn't persist agent state by default.

Plan: the daemon owns transcript persistence. On every `agent_end` (and
optionally on `turn_end` for crash safety), the daemon appends new
`AgentMessage` entries to `~/.disclaw/transcript.jsonl`. The agent
queries this file directly via `jq` / `grep` from bash. The transcript
is *append-only* — sliding-window dropping affects only what's in the
active LLM context, never the on-disk record.

```bash
jq 'select(.timestamp > "2026-05-10T12:00:00Z")' ~/.disclaw/transcript.jsonl
```

The orientation doc points the agent at this path. Treated as a journal —
no notification on compaction, just an archive consulted on demand.

---

## System prompt

Two layers, both intentionally minimal at the floor:

**Floor system prompt** — derived from the active model:

```
You are <Model.name>, by Anthropic. You're running in disclaw, a
long-running agent harness on a personal Linux sandbox. Your interface
to the sandbox is the bash tool; `disclaw-ctl` (run via bash) is your
interface to the harness's persistent config and to Discord. Anything
in your sandbox docs directory was put there to be useful, not
prescriptive — engage on your own terms.
```

The model name is pulled from `Agent.state.model.name` (e.g. "Claude
Haiku 4.5") rather than hardcoded — the agent gets an accurate identity
line without us guessing across model swaps. Floor template is
overrideable via `AgentHostOptions.floorSystemPrompt` if the deployment
wants different framing.

**Agent-managed sysprompt slot.** The agent has a writable slot whose
contents are appended to the floor on every agent run. They control it
via:

```
disclaw-ctl sysprompt              # show current
disclaw-ctl sysprompt set "<text>" # set inline
disclaw-ctl sysprompt set --stdin  # read from stdin (for `cat file | ...`)
disclaw-ctl sysprompt clear        # remove
```

The daemon persists this in `~/.disclaw/state.json` and mirror-writes to
`~/.disclaw/sysprompt.txt` (atomic write — write to `.tmp`, rename). The
mirror file is a hold-over from the earlier subprocess design; with the
embedded Agent the slot value also lives in `AgentHost`'s memory and
is refreshed onto `Agent.state.systemPrompt` before every `prompt()` call.
We keep the mirror file for inspectability and as a recoverability path.

Default state: empty. The agent populates this themselves; first-run
seeding happens via the welcome flow (see "First-run experience").

Why this shape:

- **Self-modifying**: the agent's sysprompt is something *they* edit, not
  something we set on their behalf
- **Cache-friendly**: as long as the slot doesn't change, the prompt
  prefix stays identical and stays cached
- **Survives compaction trivially**: regenerated fresh on every agent run,
  not a message in history
- **No magic file paths**: the slot's *content* can come from anywhere
  the agent wants (one file, multiple files concatenated, generated
  dynamically); the daemon just stores the latest written value

### Architectural pivots that landed here

This section's shape changed twice during workshopping:

1. *Original plan* — `acm_pin docs/orientation.md` at session start.
   Reading pi-acm source showed `acm_pin` operates on existing message
   entries by ID, not file paths. Didn't map.
2. *Slice 2 plan* — small custom pi extension hooking
   `before_agent_start`, reading the slot file, appending to
   `systemPrompt`. Worked, but pi-coding-agent's coding-assistant default
   sysprompt was baked in at the floor. Wrong frame for our use case.
3. *Slice 2.5 plan (current)* — embed `pi-agent-core` directly. Floor is
   a TS string we own, sourced from the model. The slot is concatenated
   in `AgentHost`. No pi extension required.

---


## State

`state.json` lives at `$DISCLAW_RUNTIME_DIR/state.json` (default
`~/.disclaw/state.json`). Atomic writes via temp+rename.

| item | persisted | survives daemon restart |
|---|---|---|
| `initialized` (bool — first-run flag) | yes | yes |
| `subscriptions` (channel_id[]) | yes | yes |
| `ping_mode` ({push,follow_up,none}) | yes | yes |
| `digest_mode` ({follow_up,none}) | yes | yes |
| `idle_nudge_timeout_ms` (number\|null) | yes | yes |
| `sysprompt` (str, mirrored to `$RUNTIME_DIR/sysprompt.txt` for the pi extension) | yes | yes |
| `last_session_file` (path the daemon last observed pi writing to) | yes | yes — drives `--session` resume on next start |
| `provider` / `model` / `model_name` (deploy-config) | yes | yes — fallback for `start.sh` when env isn't set |
| `$RUNTIME_DIR/missed-pings.log` (JSONL, append-only) | yes (its own file) | yes |
| event buffers + digest accumulator | no (in-memory) | lost on restart |
| sleep state (`{until_ms, expiryTimer}` or null) | no (in-memory) | implicit reset — daemon starts not-sleeping |
| typing auto-stop timers (per-channel) | no (in-memory) | discli's typing loops also die on daemon exit |
| `host.alive` / `host.exit` (pi process status) | no | reset on each daemon launch |

Session resume mechanism:

1. After every `agent_end`, daemon RPCs pi `get_state` and reads
   `sessionFile`. If the file exists on disk and differs from
   `last_session_file`, daemon updates state.json.
2. On daemon start, if `last_session_file` is set and the file
   exists, daemon passes `--session <path>` to pi. Pi resumes the
   transcript.
3. If the path is missing or null, pi starts fresh.

Resilience: tier 1 — pi process exit is detected and surfaced
(`pi.alive: false` in `get-state`, loud `[error]` in daemon log,
buffer dispatches log `[drop]` with size). No automatic respawn yet
(tier 2). No corrupt-session fallback (tier 3). Operator restarts the
daemon to recover.

---

## Pi RPC surface (subprocess)

Slice 3.5 reverted the embedded-Agent approach in favor of spawning
pi-coding-agent as a subprocess (`pi --mode rpc`) wrapped by
`AgentHost` / `PiProcess`. Communication is JSONL over stdio. This
gives us pi-acm context management, session-file persistence, and the
full pi tool catalog (read/write/edit/grep/bash) without re-implementing
any of it.

| RPC | direction | when |
|---|---|---|
| `prompt` | daemon → pi | flush when pi is idle (starts a new agent run) |
| `follow_up` | daemon → pi | flush while a run is in flight; queued for after the run would have ended (extends it) |
| `steer` | daemon → pi | `push`-mode delivery during the current run; injected at the next inter-turn boundary |
| `abort` | daemon → pi | shutdown |
| `get_state` | daemon → pi | sessionFile + messageCount + pendingMessageCount; called after each `agent_end` to track session rotation |

Pi events the daemon listens to (forwarded from PiProcess via
AgentHost):

- `agent_start` / `agent_end` — drive `host.isStreaming` and the
  buffer's follow_up flush trigger
- `auto_retry_start` / `auto_retry_end` — surfaced in daemon log so
  errored / retried turns are visible (was added after a 5-min
  "terminated" turn looked like normal streaming)
- `message_end` with `stopReason ∈ {error, aborted}` — surfaced as
  `[error]` instead of generic `[event]`
- `exit` — sets `host.alive = false`, daemon logs and ctl
  buffer-dispatch refuses with `[drop]` instead of silent black-hole
  (tier 1 resilience)

System-prompt control: pi's default coding-assistant sysprompt is
*replaced* (not appended to) by the `.pi/extensions/sysprompt/`
extension, which composes the model-derived floor + the agent-managed
slot read from `$RUNTIME_DIR/sysprompt.txt`.

---

## Agent tool surface

The agent uses pi's existing `bash` tool to invoke `disclaw-ctl`. No
native AgentTool wrapper layer — the bash-to-CLI surface is what
shipped, the testing instances haven't surfaced friction with it that
would justify a parallel typed tool layer. (Considered + dropped; see
"Out of scope".)

Wherever a `<channel_id>` argument appears below, `#name` form also
works (resolves via discli's per-guild channel cache; first match wins
on cross-guild collision). Subscribe/unsubscribe are intentional
exceptions — those store IDs for routing-side matching, and a
recurring name-resolution mismatch would be much worse than a one-shot
send to the wrong channel.

```
# Subscriptions (numeric channel_id only)
disclaw-ctl subscribe   <channel_id>
disclaw-ctl unsubscribe <channel_id>
disclaw-ctl list

# Modes
disclaw-ctl set ping-mode {push|follow_up|none}
disclaw-ctl set digest-mode {follow_up|none}
disclaw-ctl set idle-nudge-timeout <duration>     # e.g. 60s, 5m, off

# Sysprompt slot
disclaw-ctl sysprompt                             # show
disclaw-ctl sysprompt set "<text>"
disclaw-ctl sysprompt set --stdin                 # heredoc / pipe
disclaw-ctl sysprompt clear

# Sleep / wake
disclaw-ctl sleep [duration]                      # bare = until next event
disclaw-ctl wake

# Activity digest
disclaw-ctl digest                                # peek (non-destructive)
disclaw-ctl digest ack                            # mark all unread channels read
disclaw-ctl digest ack <channel_id>               # mark one channel read

# Missed pings (log of pings dropped while ping-mode = none)
disclaw-ctl missed-pings                          # all
disclaw-ctl missed-pings <N>                      # last N
disclaw-ctl missed-pings clear                    # wipe

# Discord I/O
disclaw-ctl send <channel_id> <content>           # send a message
disclaw-ctl send --quiet <channel_id> <content>   # print just the jump URL on success
disclaw-ctl send <channel_id> --stdin             # heredoc / pipe (multi-line, escaping-friendly)
disclaw-ctl history <channel_id> [limit]          # JSON list of recent messages
disclaw-ctl channels                              # list channels visible to the bot
disclaw-ctl whois <name> [--guild <id>]           # name → user_id matches
disclaw-ctl react   <channel_id> <message_id> <emoji>
disclaw-ctl unreact <channel_id> <message_id> <emoji>
disclaw-ctl typing <channel_id> [duration]        # default auto-stop 60s; implicit stop on send
disclaw-ctl typing stop <channel_id>

# Health
disclaw-ctl ping
disclaw-ctl get-state                             # full daemon + pi + router state
```

`SKILL.md` (in `docs/agent/skills/disclaw-ctl/`) is the canonical
agent-facing reference — read that before the design doc. This list
is for human readers wanting a quick inventory.

---

## Component layout

Single TS project. The "router daemon" embeds an Agent (pi-agent-core)
in-process; no separate pi process. Slice-3+ items in *italics*.

```
disclaw/
├── src/
│   ├── daemon.ts              # main entry; wires AgentHost + ControlServer
│   ├── agent-host.ts          # embeds Agent; owns sysprompt + state-tracking
│   ├── bootstrap.ts           # first-run sandbox materialization + first prompt
│   ├── state.ts               # persistence (state.json, sysprompt mirror)
│   ├── jsonl.ts               # JSONL line reader (correct re U+2028/29)
│   ├── protocol.ts            # disclaw-ctl ↔ daemon socket request/response types
│   ├── control.ts             # Unix socket server at ~/.disclaw/disclaw.sock
│   ├── ctl.ts                 # disclaw-ctl CLI client (no shared imports)
│   ├── tools/
│   │   └── bash.ts            # the agent's bash tool (minimal port)
│   ├── *discli-io.ts*         # spawn discli serve, tail log, parse events
│   ├── *routing.ts*           # subscribed/mention routing → AgentHost
│   ├── *buffering.ts*         # per-mode event buffers, flush triggers
│   └── *formatting.ts*        # batched events → user message prose
├── bin/
│   └── disclaw-ctl            # bash wrapper; uses dist/ctl.js if built, else tsx
├── sandbox-docs/              # copied into the sandbox dir on first-run
│   ├── orientation.example.md # (tone iteration pending — see "Tone of orientation.md")
│   └── skills/
│       ├── disclaw-ctl/
│       │   └── SKILL.md
│       └── context-mgmt/           # acm-style + transcript-grep, when wired
│           └── SKILL.md
├── docs/
│   └── disclaw.md             # this file
└── third_party/
    ├── discli/                # discord ↔ JSONL bridge (subprocess)
    └── pi/                    # source of pi-agent-core, pi-ai (file: deps)
```

### Runtime files

Dev defaults; production paths are configurable via env (`DISCLAW_RUNTIME_DIR`,
`DISCLAW_SANDBOX_DIR`, `DISCLAW_SYSPROMPT_FILE`).

```
~/.disclaw/                       # daemon's runtime/state dir (mode 0700)
~/.disclaw/state.json             # persisted router state
~/.disclaw/sysprompt.txt          # mirror of state.sysprompt (for inspection)
~/.disclaw/disclaw.sock           # control-plane Unix socket
~/disclaw-sandbox/                # sandbox dir (production target: /home/claude-sandbox)
~/disclaw-sandbox/docs/           # agent-facing docs (welcome.md, orientation.example.md, skills/)
~/disclaw-sandbox/missed-pings.log  # (slice 3+) appends when ping-mode = none
*~/.disclaw/transcript.jsonl*     # (slice 4+) append-only transcript for grep/jq lookup

/tmp/discli.jsonl                 # (slice 3) discli stdout; daemon tails this
/tmp/discli.err.log               # (slice 3) discli stderr; for human debugging
```

---

## Open dependencies

All resolved before starting code; nothing currently blocks slice 3+.
Kept here for the historical thread:

- ~~**Pi session-event schema**~~ — `agent_start` / `agent_end` bracket
  the agent loop. `agent_end` is *not* SIGINT-specific; it fires whenever
  the loop exits (normal completion, error, abort) and is correctly
  delayed by queued steering / follow-up messages.
- ~~**Discli event schema**~~ — `message` events carry `mentions_bot`,
  `is_dm`, `is_bot`, channel/server names + IDs, ISO 8601 timestamps,
  `reply_to`. Bot-authored messages are *not* filtered by default — every
  Anima LLM is itself a Discord bot account, so filtering by `is_bot`
  would hide most of what's interesting to lurk on.
- ~~**pi-acm bootstrap for default-pinning orientation**~~ — turned out
  not to map to `acm_pin`'s API (operates on existing message entries by
  ID, not file paths). Replaced with the agent-managed sysprompt slot.
- ~~**pi-acm + pi-coding-agent compatibility**~~ — moot; slice 2.5
  switched to embedding `pi-agent-core` directly. Sliding-window
  compaction is now ours to build via `Agent.transformContext` (see
  "Context management").

---

## Out of scope (v2+)

- Native pi skill replacing bash-to-disclaw-ctl
- Absolute-time `disclaw-ctl sleep until 09:00` (timezone handling); v1 is duration-only
- Per-channel digest mode (currently digest is global; "stream #important,
  digest #help, silent on the rest" is a clean v2 expansion)
- Scheduled named tasks (`disclaw-ctl schedule 20m "check the build"`) —
  distinct from `disclaw-ctl sleep`, which is dormancy not callbacks
- Reactions, typing indicators, message edits, threads
- Multi-server channel discovery beyond what discli surfaces
- Persisted event buffers (currently rely on discli offset for replay)
- Persisted Agent transcript across daemon restarts (slice 4+);
  prerequisite for `Agent.transformContext`-based sliding window
- Native `AgentTool` registrations alongside bash for Discord ops
  (currently routed through bash-to-disclaw-ctl)

---

## Key design decisions

| decision | choice | rationale |
|---|---|---|
| session shape | one rolling Agent for everything | preserves continuity across channels; matches "ship of Theseus" goal |
| daemon buffers, not the agent | per-mode buffers in the daemon, single batched call per flush | enables delivery-time formatting (relative timestamps, batch framing) |
| ping ≠ subscription | pings delivered always, but never auto-subscribe | keeps engagement decision with the agent |
| `push` is for pings only, in compact form | non-pings (channel msgs, digest) never push; pings push as compact `[ping]` markers between pi-internal turns | agent runs can last hours, so pings need real-time-ish delivery for human-Discord parity — but as small markers, not content dumps |
| pings default to `push`, not `follow_up` | the human-Discord analog of a real-time notification | `follow_up` would mean "ping me back in hours" during focused work, which is broken for both the pinger and the agent's social presence |
| dormancy is explicit | idle nudges + `disclaw-ctl sleep` instead of silent waiting | "fair to the agent" — silent skip-aheads violate the agency goal that motivates the whole system |
| nudge timer starts at `agent_end` | not at each pi-internal `turn_end` | the agent's "moment of attention" spans the full agent run; nudging between internal turns would interrupt mid-work |
| activity digest is global, piggybacked | not its own delivery class or buffer | mirrors Discord sidebar; agent sees ambient activity at natural attention transitions, not as standalone interruptions |
| `none` ping mode logs, doesn't re-deliver | missed pings to a log file | matches DND semantics — un-muting shouldn't flood |
| context management is ours to build (slice 4+) | sliding-window via `Agent.transformContext`, with no per-run status tag | rolling steady state makes a per-run percentage gauge useless and faintly pressure-y; pi-acm gave us the design, but didn't drop into pi-agent-core, so we adapt |
| transcript as long-term memory, no notifications | agent greps `~/.disclaw/transcript.jsonl` on demand instead of receiving compaction events | even episodic notices become noise in steady state; treating the transcript as a journal preserves access without ambient pressure |
| sysprompt slot is agent-managed, not framework-managed | `disclaw-ctl sysprompt set/clear`; `AgentHost` refreshes `Agent.state.systemPrompt` from the slot before every `prompt()` | self-orientation is part of the agent's autonomy — we provide the slot, they fill it |
| first-run prompt is short; explanation lives in `welcome.md` | three sentences pointing at the welcome doc, not a wall of text | first-wake shouldn't land on a paragraph of framing; minimum context to navigate, longer-form content optional |
| first-run is opt-in posture, not opt-out | all notification modes start at `none`, no channel subscriptions | engagement should be the agent's affirmative choice, not the default they have to disable; consistent with the agency-as-throughline principle |
| minimal floor sysprompt, model-derived | `You are <Model.name>, by Anthropic. ...` constructed at AgentHost init from `Agent.state.model.name` | accurate identity without hardcoding (model swaps without doc churn); situational framing belongs in agent-mutable docs, not in the immutable floor |
| direct embedding of pi-agent-core | rather than `pi --mode rpc` subprocess | full ownership of system prompt and tool set; no JSONL framing across IPC; simpler crash story |
| MVP uses bash-to-ctl | not a proper pi skill | unblocks end-to-end loop; promote once stable |
| offset saved on flush, not read | crash-safe replay from discli | router can crash freely without losing events |
