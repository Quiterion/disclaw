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
being opt-out-able via `/sleep`, the sysprompt being agent-managed, the
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
discli serve >> /var/log/discli.jsonl     # stdout: JSONL events
            2>> /var/log/discli.err.log    # stderr: diagnostics (separate)
                     |
              [log follower]
                     |
              [router core]  <-- /run/router.sock <-- disclaw-ctl
                  ^      |
   pi events ---- |      | ---> pi stdin (JSONL commands)
       (stdout)          
                     pi --mode rpc
```

`discli serve` writes diagnostic messages to stderr; only stdout is pure
JSONL. The router only consumes the stdout log; stderr is captured for
human debugging.

Two input streams feed the router:

1. **discli log** — append-only file with offset persistence. Drives all
   "something happened on Discord" events.
2. **pi stdout** — JSONL event stream from `pi --mode rpc`. Drives the router's
   model of pi's `isStreaming` state, which gates how Discord events are
   delivered (see "Delivery modes" below).

Two output sinks:

1. **pi stdin** — JSONL commands (`prompt` / `follow_up` / `steer`).
2. **disclaw-ctl socket** — control plane for both the human operator and
   (via bash) the agent.

### Why a file + bidirectional pi pipe

The original (v1) decoupling rationale still holds for discli — file +
offset gives crash-safe replay. The pi side now has to be bidirectional
because the router needs pi's state to make routing decisions. We attach to
pi's stdout/stdin directly rather than through FIFOs; if the router crashes,
both `discli` and `pi` keep running and the router reattaches on restart.

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
  next. The agent can `/sleep` to suppress further nudges until the next
  real event. See "Idle, nudges, and /sleep".

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

**Note on first-run state**: ping-mode and digest-mode both start at
`none`, and the subscriptions set is empty. The "mode" column above
shows the *recommended* configuration if the agent decides to engage —
not what's running on day one. See "First-run experience".

Pings always route through the ping path regardless of subscription state —
subscribing to a channel doesn't collapse pings into normal stream traffic,
and unsubscribed-channel pings still arrive (with a clear marker, see
"Message format"). A ping never auto-subscribes the channel; the agent
decides whether to subscribe in response.

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

### Tracking pi state

The router maintains `isStreaming` and `isCompacting` by listening to pi's
event stream:

| event (pi → router) | meaning |
|---|---|
| `agent_start` | `isStreaming = true` |
| `agent_end` | `isStreaming = false` → flush `follow_up` buffer; start idle nudge timer |
| `compaction_start` | `isCompacting = true` |
| `compaction_end` | `isCompacting = false` |

Initial state on router restart is recovered via `get_state` RPC (returns
both `isStreaming` and `isCompacting`).

> **Terminology.** Throughout this doc, **agent run** = one cycle of pi's
> outer loop, from `agent_start` to `agent_end`. **Turn** = one pi-internal
> turn (a single LLM call + its tool batch); we use it only when push
> timing requires the precision. A single agent run can contain many
> internal turns. From the agent's perspective, an agent run is a single
> uninterrupted moment of attention.

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

## Idle, nudges, and `/sleep`

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

> *No new Discord activity since you last responded. You can `/sleep` to
> wait until something happens, or use this run however you like — write
> notes, check the system, edit pinned docs, etc.*

If digest content has accumulated, it's included in the same nudge.

The nudge fires only when pi is idle by definition (it's a `prompt`,
which requires idle state). Cost converges to near-zero quickly: the
agent will either `/sleep` (suppressing further nudges) or do some
self-directed work (which extends the new agent run until they're done,
restarting the timer at the next `agent_end`).

**`/sleep`.** Explicit dormancy, suppresses further nudges:

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
disclaw-ctl set idle-nudge-timeout 30s   # check in often
disclaw-ctl set idle-nudge-timeout 5m    # let me work uninterrupted between bouts
```

---

## Context management (pi-acm)

We use the [`pi-acm`](https://www.npmjs.com/package/pi-acm) extension for
sliding-window context management. It provides everything we'd otherwise
have to build ourselves:

- **Sliding window compaction** instead of pi's default lossy AI
  summarization — drops oldest content as the window fills. Matches the
  ship-of-Theseus goal: continuity through gradual replacement, not
  snapshot summaries.
- **Inception pinning** — pinned messages survive all compaction and
  prepend the context. Implemented cleanly inside pi rather than as
  router-side prepend hackery.
- **Tool surface for the agent** to manage their own context:
  `acm_pin`, `acm_unpin`, `acm_prune`, `acm_snipe`, `acm_compact`,
  `acm_recall`, `acm_map`, `acm_diagnose`. The agent decides what stays,
  what gets dropped, when to compact.
- **Sidecar storage** — session JSONL stays clean; ACM state is in
  separate files.

Vendored into `third_party/pi-acm` (npm install or git submodule) with
one local patch.

### The one local patch

pi-acm injects a `<context-status>` tag into pi's context before every
agent run, like:

```xml
<context-status tokens="187,000" percent="93%" limit="200,000" pinned="3" pruned="12"/>
```

Useful framing for a finite coding session, but wrong for an indefinite
rolling session: after warmup the percentage parks near the auto-compact
threshold and stays there forever. Reporting "93%" before every agent run
becomes a constant-value gauge — at best useless, at worst ambient
pressure framing every moment as "approaching a limit" when in fact the
steady state is sustainable indefinitely.

The patch: delete the `<context-status>` tag construction in
`src/whisper.ts`. Keep:

- `<pruned-manifest>` (episodic — only present when content has actually
  been pruned; serves as an inventory the agent can scan to know what
  `acm_recall` could pull back)
- The system-prompt addition explaining ACM tools
- All ACM tools — agent queries on demand via `acm_map`, etc.

Net effect: no per-run whisper noise; agent has full context-management
agency via tools and queryable state when they choose to engage with it.

### The transcript as long-term memory

Pi maintains the canonical session JSONL at the path exposed via
`RpcSessionState.sessionFile`, and pi-acm explicitly never modifies it.
Compaction only affects what's in the active context window — everything
that ever happened remains queryable from disk:

```bash
jq 'select(.timestamp > "2026-05-10T12:00:00Z")' "$PI_SESSION_FILE"
```

`docs/orientation.md` documents this path along with grep/jq starting
points. The agent treats it as a journal — no notification on compaction,
just an archive they can consult when curious about something that's
slipped out of active context. (Agreement that even an episodic "just
compacted" notice would itself become noise in steady state, since the
rate would be roughly one compaction-event per N agent runs indefinitely.)

### Where orientation lives

Not via `acm_pin`. See "System prompt" — orientation is the agent's
self-managed sysprompt slot, rendered each agent run by a small
companion extension. ACM stays focused on what it's good at: sliding
window + message-level pinning the agent invokes when they want to
preserve a specific exchange.

---

## System prompt

Two layers, both intentionally minimal at the floor:

**Pi's base system prompt** is just `"You are Claude Opus 4.7, by Anthropic."`
We deliberately don't load situational framing into the floor sysprompt,
because the floor is what the agent *can't* change — and agency over
self-orientation is part of the design (see "Design ethos").

**Agent-managed sysprompt slot.** The agent has a writable slot whose
contents are prepended to their system prompt on every agent run. They
control it via:

```
disclaw-ctl sysprompt              # show current
disclaw-ctl sysprompt set "<text>" # set inline
disclaw-ctl sysprompt set --stdin  # read from stdin (for `cat file | ...`)
disclaw-ctl sysprompt clear        # remove
```

The router persists this in state.json and mirror-writes to
`/home/claude-sandbox/.disclaw/sysprompt.txt` (atomic write — write to `.tmp`, rename).
A small custom pi extension reads from that file in `before_agent_start`
and returns it as a `systemPrompt` addition.

Implementation skeleton (~15 lines, in `disclaw/extensions/sysprompt/`):

```ts
import { readFileSync } from "node:fs"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const SYSPROMPT_FILE = `${process.env.HOME}/.disclaw/sysprompt.txt`

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    let body: string
    try { body = readFileSync(SYSPROMPT_FILE, "utf-8").trim() } catch { return }
    if (!body) return
    return {
      systemPrompt: (event as any).systemPrompt
        ? (event as any).systemPrompt + "\n\n" + body
        : body,
    }
  })
}
```

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
  dynamically); the router just stores the latest written value

### Note on the earlier "acm_pin orientation.md" plan

The original design assumed we'd `acm_pin docs/orientation.md` at session
start. Reading pi-acm's source (`tools/control.ts:19-47`) showed that
`acm_pin` operates on existing message entries by ID — it doesn't pin
file paths. So the original plan didn't actually map to ACM's API. The
companion-extension approach above is structurally cleaner: ACM still
gives us sliding-window compaction and message-level pinning the agent
can use ad hoc, and the sysprompt slot gives us "always-present
agent-controlled framing" without any pi-acm modification beyond the
already-planned whisper patch.

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
| pi `isStreaming` state | no | recovered via `get_state` RPC on attach |

Persisting the discli offset only on flush means a router crash loses zero
events: anything not yet delivered to pi will be re-read on restart. Pi-side
duplication is impossible because nothing was sent yet.

---

## Pi RPC surface used

| RPC | direction | when |
|---|---|---|
| `prompt` | router → pi | flush when pi idle |
| `follow_up` | router → pi | flush when pi streaming or compacting |
| `steer` | router → pi | `push`-mode flush during current agent run |
| `get_state` | router → pi | router startup, to recover `isStreaming` / `isCompacting` |
| (subscribe to stdout events) | pi → router | continuous, drives `isStreaming` / `isCompacting` |

Events the router subscribes to but **ignores** (per design — see "Context
management (pi-acm)"): `compaction_start`, `compaction_end`. These are used
only to update internal state, never surfaced to the agent. Same for routine
`turn_start` / `turn_end` events (pi-internal turn boundaries are not
exposed; only `agent_end` matters for our purposes).

Not used in v1: `abort`, `compact` (pi-acm provides `acm_compact` instead),
session forking, queue-mode toggles (we manage batching ourselves rather
than relying on pi's `set_follow_up_mode`).

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

Context management is *not* via disclaw-ctl — it's pi-acm's tool surface,
which the agent invokes via pi's normal model tool-calling, not bash:
`acm_pin`, `acm_unpin`, `acm_prune`, `acm_snipe`, `acm_compact`,
`acm_recall`, `acm_map`, `acm_diagnose`. See "Context management (pi-acm)".

### v2: native pi skill

Replace the bash interface with a proper pi skill exposing
`discord_subscribe`, `discord_send`, `discord_history`, etc. as structured
tools. Same underlying socket. Defer until v1 surface is stable.

---

## Component layout

```
disclaw/
├── disclaw/                       # router daemon (Python)
│   ├── daemon.py              # entry point + thread wiring
│   ├── log_follower.py        # discli.jsonl follower with offset
│   ├── pi_io.py               # pi stdin writer + stdout event reader
│   ├── routing.py             # routing matrix + delivery mode resolution
│   ├── buffering.py           # per-mode buffers + flush triggers
│   ├── formatting.py          # batch → user message prose rendering
│   ├── bootstrap.py           # first-run setup (materialize sandbox-docs, send first prompt)
│   ├── state.py               # persistence (subscriptions, modes, sysprompt, offset, etc.)
│   ├── control.py             # /run/router.sock JSONL server
│   └── ctl.py                 # disclaw-ctl CLI client (no shared imports)
├── extensions/                     # custom pi extensions (TypeScript)
│   └── sysprompt/             # before_agent_start handler reading /home/claude-sandbox/.disclaw/sysprompt.txt
│       ├── package.json
│       └── index.ts
├── sandbox-docs/                   # copied into /home/claude-sandbox/docs/ on first-run
│   ├── welcome.md             # (TBD — tone iteration pending)
│   ├── orientation.example.md
│   └── skills/
│       ├── disclaw-ctl.md
│       ├── context.md
│       └── discord.md         # per-deployment server conventions
└── docs/
    └── disclaw.md
```

### Runtime files

```
/var/log/discli.jsonl       # discli appends here
/var/run/router.state       # persisted router state (json)
/run/router.sock            # control plane socket
/home/claude-sandbox/docs/             # agent-facing docs (orientation.md acm_pinned at session start)
/home/claude-sandbox/missed-pings.log  # appends when ping-mode = none
$PI_SESSION_FILE            # pi's canonical session JSONL (managed by pi, never modified by ACM)
                            # — orientation documents this path for grep/jq lookup
```

---

## Open dependencies

Resolved (confirmed against source):

- ~~**Pi session-event schema**~~ — `agent_start` / `agent_end` bracket the
  agent loop; `compaction_start` / `compaction_end` bracket compaction.
  `agent_end` is *not* SIGINT-specific; it fires whenever the loop exits
  (normal completion, error, abort) and is correctly delayed by queued
  steering / follow-up messages.
- ~~**Discli event schema**~~ — `message` events have all the routing
  fields we need: `mentions_bot`, `is_dm`, `is_bot`, channel/server
  names + IDs, ISO 8601 timestamps, `reply_to`. Bot-authored messages
  are *not* filtered by default — every Anima LLM is itself a Discord
  bot account, so filtering by `is_bot` would hide most of what's
  interesting to lurk on.

Resolved (continued):

- ~~**pi-acm bootstrap for default-pinning orientation**~~ — turned out
  not to map to `acm_pin`'s API (which operates on existing message
  entries by ID, not file paths). Replaced with the agent-managed
  sysprompt slot + small companion extension — see "System prompt".

All open dependencies for v1 are now resolved.

---

## Out of scope (v2+)

- Native pi skill replacing bash-to-disclaw-ctl
- Absolute-time `/sleep until 09:00` (timezone handling); v1 is duration-only
- Per-channel digest mode (currently digest is global; "stream #important,
  digest #help, silent on the rest" is a clean v2 expansion)
- Scheduled named tasks (`disclaw-ctl schedule 20m "check the build"`) —
  distinct from `/sleep`, which is dormancy not callbacks
- Reactions, typing indicators, message edits, threads
- Multi-server channel discovery beyond what discli surfaces
- Persisted event buffers (currently rely on discli offset for replay)
- Upstreaming the whisper patch as a config option in pi-acm (rather than
  carrying a local diff) — once the design has stabilized in our use

---

## Key design decisions

| decision | choice | rationale |
|---|---|---|
| session shape | one rolling pi session for everything | preserves continuity across channels; matches "ship of Theseus" goal |
| router buffers, not pi | per-mode buffers in router, single batched RPC per flush | enables delivery-time formatting (relative timestamps, batch framing) |
| ping ≠ subscription | pings delivered always, but never auto-subscribe | keeps engagement decision with the agent |
| `push` is for pings only, in compact form | non-pings (channel msgs, digest) never push; pings push as compact `[ping]` markers between pi-internal turns | agent runs can last hours, so pings need real-time-ish delivery for human-Discord parity — but as small markers, not content dumps |
| pings default to `push`, not `follow_up` | the human-Discord analog of a real-time notification | `follow_up` would mean "ping me back in hours" during focused work, which is broken for both the pinger and the agent's social presence |
| dormancy is explicit | idle nudges + `/sleep` instead of silent waiting | "fair to the agent" — silent skip-aheads violate the agency goal that motivates the whole system |
| nudge timer starts at `agent_end` | not at each pi-internal `turn_end` | the agent's "moment of attention" spans the full agent run; nudging between internal turns would interrupt mid-work |
| activity digest is global, piggybacked | not its own delivery class or buffer | mirrors Discord sidebar; agent sees ambient activity at natural attention transitions, not as standalone interruptions |
| `none` ping mode logs, doesn't re-deliver | missed pings to a log file | matches DND semantics — un-muting shouldn't flood |
| context management via pi-acm | sliding window + inception pinning, with `<context-status>` tag stripped | rolling steady state makes a per-run percentage gauge useless and faintly pressure-y; pruned-manifest + on-demand `acm_map` give the agent full agency without constant framing |
| transcript is the long-term memory, no notifications | agent greps `$PI_SESSION_FILE` on demand instead of receiving compaction events | even episodic notices become noise in steady state; treating the transcript as a journal preserves access without ambient pressure |
| sysprompt slot is agent-managed, not framework-managed | `disclaw-ctl sysprompt set/clear`; small companion extension renders contents on every `before_agent_start` | self-orientation is part of the agent's autonomy — we provide the slot, they fill it; pi-acm's `acm_pin` operates on existing entries (not file paths), so a different mechanism was needed anyway |
| first-run prompt is short; explanation lives in `welcome.md` | three sentences pointing at the welcome doc, not a wall of text | first-wake shouldn't land on a paragraph of framing; minimum context to navigate, longer-form content optional |
| first-run is opt-in posture, not opt-out | all notification modes start at `none`, no channel subscriptions | engagement should be the agent's affirmative choice, not the default they have to disable; consistent with the agency-as-throughline principle |
| minimal sysprompt | `"You are Claude Opus 4.7, by Anthropic"` | situational framing belongs in agent-mutable docs, not in immutable preamble |
| MVP uses bash-to-ctl | not a proper pi skill | unblocks end-to-end loop; promote once stable |
| offset saved on flush, not read | crash-safe replay from discli | router can crash freely without losing events |
