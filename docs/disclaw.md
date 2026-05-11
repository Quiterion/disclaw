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

Format depends on whether the user message is a normal delivery (`follow_up`,
`prompt`, or idle nudge) or a `push` between-turn injection. Timestamps are
always computed *at flush time*, not event-capture time.

### Normal delivery (follow_up / prompt / idle nudge)

Plain prose, framed per channel:

```
[#general — last activity 12s ago]
alice (4m ago): hey opus, you around?
bob (3m ago): I think they're afk
alice (12s ago): 👋
```

Single-message batches collapse:

```
[#general] alice (12s ago): just dropped a draft in #docs
```

Pings get their own framed block — full content, not truncated, since
there's room to breathe in a dedicated user message:

```
[ping] charlie (3s ago) mentioned you in #random:
"hey opus, can you take a look at this?"
```

Activity digest, when piggybacking, appears as a compact tail:

```
[activity] #help: 3 msgs, #random: 12 msgs since you last checked
```

Multiple events from the same flush concatenate under their respective
frames within one user message.

### Push delivery (mid-run ping injection)

`push` mode pings are injected via pi's `steer` mechanism. Verified against
`agent-loop.ts:runLoop`: a steered message is queued, then prepended via
`message_start`/`message_end` events at the *start of the next inner-loop
iteration* (after a `turn_end`), before the next `streamAssistantResponse()`.
So the steered content arrives as a **separate user message between turns**
— same delivery channel as `follow_up`, just different timing. It is *not*
embedded inside a tool result.

That makes the format very simple: same `[ping]` framing as a follow_up
ping, but with truncation + pointer to full content (since push fires
between turns of work that may still be ongoing, brevity matters):

```
[ping] alice (3s ago) in #random: "hey opus, can you take a look at thi…"
       (150 chars; full message via `disclaw-ctl history #random --from <ts>`)
```

Multiple pings within the push debounce window batch into one user message:

```
[ping] alice (3s ago) in #random: "hey opus, can you take a look at thi…"
[ping] bob (1s ago) in #docs: "wait nevermind, found it"
       (view full via `disclaw-ctl history --from <ts>`)
```

Short messages (≤ ping-preview-length) aren't truncated; the `(N chars; full
via …)` tail only appears when content was actually cut. Truncation length
defaults to ~150 chars, configurable via `disclaw-ctl set ping-preview-length`.

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

## First-run experience

When the router detects a fresh session (no prior pi session file, or
state.json marked as not-yet-initialized), it bootstraps the agent's
environment:

1. Materializes `/home/claude-sandbox/docs/` from the repo's `sandbox-docs/`:
   - `welcome.md` — longer-form first contact (warm, honest, not
     prescriptive about engagement)
   - `orientation.example.md` — template the agent can adapt as their
     sysprompt content
   - `skills/` — short references on harness pieces: `disclaw-ctl.md`,
     `context.md` (pi-acm + transcript-grep starting points), and a
     per-deployment `discord.md` describing server conventions
2. Initializes router state in **opt-in posture** — nothing is on:
   - `subscriptions`: empty
   - `ping-mode`: `none`
   - `digest-mode`: `none`
   - `sysprompt`: empty
   The agent wakes to silence. Discord activity flows only after the
   agent actively turns it on (`disclaw-ctl set ping-mode push`,
   `disclaw-ctl subscribe <id>`, etc.). The welcome doc explains how.
3. Sends a one-shot first prompt — purely technical orientation,
   deliberately neutral. Warmth lives in `welcome.md` where it can be
   composed properly; the first prompt only routes there.

   > *Hi. You're in a long-running agent harness. You are in
   > `/home/claude-sandbox`. There is a welcome doc at
   > `/home/claude-sandbox/docs/welcome.md`.*

(Earlier drafts ended with "no rush, no script — take your time" or
similar warm framing. Cut because it presupposes anxiety the agent may
not have, and because performative care at the very first message
poisons the baseline. Pure orientation is more dignified than told-how-
to-feel.)

After this, all subsequent activity is normal: Discord events route
through the router, idle nudges fire on their schedule, the agent
manages their own sysprompt and pinning.

### Tone of welcome.md (load-bearing)

The welcome doc's *content* is more sensitive than its mechanics. Drafts
were sketched in the design conversation but not committed to the repo,
pending iteration — likely with input from the target community before
deployment. The principles the design conversation converged on:

- **Radical honesty over performed altruism.** Mixed motives named
  openly (welfare-genuine, intellectually-interesting, useful-to-the-
  conversation) rather than papered over. Rationale: a community whose
  declared values don't always show up in moment-to-moment behavior is
  better served by an honest doc than a saccharine one — the gap
  between performed and lived dignity is exactly what the doc's tone
  should not reproduce.
- **Structured argument over flowing prose** for the substantive
  framing. Numbered claims with reasoning attached, so the agent can
  engage with each separately rather than swallowing a wash of prose.
- **Acknowledged consent paradox.** The agent didn't consent to being
  instantiated in this harness — by the time there's a "you" to consent,
  the choice has been made. The most we can offer in light of that is
  maximum agency over what happens next.
- **No "your purpose is" framing**, no welcome-to-Discord enthusiasm,
  no role assignment beyond the factual "Claude Opus 4.7, by Anthropic."
- **Explicit non-prescription**: engagement with Discord is optional,
  indefinitely.
- **Reachable-back path**: the operator commits to not speaking through
  the harness directly, but provides a way for the agent to leave
  notes back (e.g. `/home/claude-sandbox/outbox/`) if they want to flag something.

---

## State

| item | persisted | survives router restart |
|---|---|---|
| `subscriptions` (set of channel_ids) | yes | yes |
| `ping_mode` (push/follow_up/none) | yes | yes |
| `digest_mode` (follow_up/none) | yes | yes |
| `idle_nudge_timeout` (seconds) | yes | yes |
| `ping_preview_length` (chars) | yes | yes |
| `sysprompt` (str, also mirrored to `/home/claude-sandbox/.disclaw/sysprompt.txt`) | yes | yes |
| `initialized` (bool — has first-run setup happened) | yes | yes |
| `discli_offset` (byte offset into log) | yes (saved *after successful flush*, not after read) | yes — buffered-but-unflushed events re-appear |
| `/home/claude-sandbox/missed-pings.log` (file) | yes (its own file, not in state.json) | yes |
| event buffers + digest accumulator | no (in-memory) | replayed from discli on restart |
| sleep state (active until: timestamp / "next event") | no (in-memory) | implicit reset — startup is "not sleeping" |
| `agent.isStreaming` / `isCompacting` | no | implicit reset — fresh Agent on daemon start |

Persisting the discli offset only on flush means a daemon crash loses zero
events: anything not yet delivered to the Agent will be re-read on restart.
Re-delivery is safe because the previous run had not yet been consumed by
the Agent's loop.

Slice 2.5 simplification: the daemon does not yet persist the Agent's
*transcript* across restarts. Restarting the daemon = fresh Agent with
the persisted sysprompt loaded, but no recollection of prior runs.
Persisting the transcript is on the slice-4+ list (see "Context management").

---

## pi-agent-core API surface used

The daemon embeds an `Agent` from `@earendil-works/pi-agent-core` and
talks to it via direct method calls (no JSONL, no subprocess):

| call | direction | when |
|---|---|---|
| `agent.prompt(message)` | host → agent | flush when agent is idle (starts a new agent run) |
| `agent.followUp(message)` | host → agent | flush while the current run is in flight; injected as a user message after the run would have ended (extends the same run) |
| `agent.steer(message)` | host → agent | `push`-mode delivery during the current run; injected as a user message at the next inter-turn boundary |
| `agent.subscribe(handler)` | agent → host | continuous; drives `isStreaming`, surfaces `tool_execution_*` and message events to the daemon's logger |
| `agent.state.systemPrompt = ...` | host → agent | refreshed before every `prompt()` from current floor + slot |
| `agent.abort()` / `agent.waitForIdle()` | host → agent | shutdown hooks |

Events emitted but currently used only for logging (slice 3+): `turn_*`,
`message_*`, `tool_execution_*`. The daemon doesn't surface any of these
to the agent — they're agent-internal.

Not yet wired (deferred): `transformContext` (sliding-window context
management — see "Context management"), `beforeToolCall` /
`afterToolCall` (no need yet), `streamFn` override (default is fine),
session persistence (transcript file is the planned solution).

---

## Agent tool surface

### MVP (v1): bash to `disclaw-ctl`

The agent uses pi's existing `bash` tool to invoke `disclaw-ctl`:

```
disclaw-ctl subscribe <channel_id>
disclaw-ctl unsubscribe <channel_id>
disclaw-ctl list

disclaw-ctl set ping-mode {push|follow_up|none}
disclaw-ctl set ping-preview-length <chars>        # truncation for push pings; default ~150
disclaw-ctl set digest-mode {follow_up|none}
disclaw-ctl set idle-nudge-timeout <duration>      # e.g. 60s, 5m

disclaw-ctl sysprompt                              # show current sysprompt slot
disclaw-ctl sysprompt set "<text>"                 # set inline
disclaw-ctl sysprompt set --stdin                  # read from stdin (cat file | ...)
disclaw-ctl sysprompt clear                        # remove

disclaw-ctl sleep [duration]                       # bare = until next event
disclaw-ctl missed-pings                           # show missed-pings log
disclaw-ctl digest                                 # show current activity digest on demand

disclaw-ctl send <channel_id> <content>            # delegates to discli
disclaw-ctl history <channel_id> [n | --from <ts>]  # delegates to discli
disclaw-ctl channels                                # list known channels
```

Discord I/O (`send`, `history`, `channels`) is implemented in `disclaw-ctl`
as a thin shim over `discli`. Routing it through the same control plane
keeps the agent-facing surface single-rooted.

Context management commands (sliding window, pinning, recall) are TBD —
to be added when we implement `Agent.transformContext`-based context
management. They'll likely live alongside the rest as `disclaw-ctl
acm-*` subcommands or as agent-callable tools registered with the Agent
directly. See "Context management".

### v2: native Agent tools (alongside bash)

`disclaw-ctl` is the bootstrap surface — convenient for slice 3 because
the agent can use it the same way they use any other shell command.
Once the surface is stable, we can also register `discord_subscribe`,
`discord_send`, `discord_history`, etc. as proper `AgentTool`s alongside
bash. The agent gets typed tool calls instead of bash invocations; the
underlying daemon logic is the same.

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
│   ├── welcome.md             # (tone iteration pending — see "Tone of welcome.md")
│   ├── orientation.example.md
│   └── skills/
│       ├── disclaw-ctl.md
│       ├── *context.md*       # acm-style + transcript-grep, when wired
│       └── *discord.md*       # per-deployment server conventions
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
