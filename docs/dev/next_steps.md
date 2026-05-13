# next steps

Snapshot of what's done, what's running, and what's next. Living
document — feel free to reorder / strike / add. Last meaningful
update: 2026-05-13 (post pi-host / pi-discord split).

## Done (already shipped)

- [x] **Slice A — session resumption** across daemon restart (per-
  (provider,model) registry in pi-host state.json, `--session` to pi
  on startup)
- [x] **Slice B — activity digest** (sidebar-style unread counts for
  unsubscribed channels; `digest_mode` + `digest` peek + `digest ack`
  drain)
- [x] **Slice C — buffering + flush-time formatting** (per-mode event
  buffers, `<discord>`-wrapped batched user messages)
- [x] **Slice D pt 1 — missed-pings log** (JSONL of pings dropped
  while ping-mode = none, reviewable via ctl)
- [x] **Slice D pt 2 — discli `humanize_mentions` patch** (incoming
  `<@id>` substituted to `@name`; tracked on Quiterion/discli's
  disclaw-patches branch)
- [x] **XML message format** (`<discord>`/`<pi-host>`/`<time>`/
  `<channel>`/`<ping>`/`<digest>`/`<attachment>` — parser-
  unambiguous; wall-clock times that don't rot; per-subsystem
  wrapping element makes origin obvious)
- [x] **`whois` verb** (name → user_id resolution)
- [x] **Typing indicator verb** (manual, agent-controlled)
- [x] **Reactions** (`react`/`unreact` + `id` attribute on `<ping>`)
- [x] **`send --stdin`** (heredoc / pipe for substantive replies —
  sidesteps shell quoting hell)
- [x] **Channel-name resolution** (`#name` accepted in any pass-through
  verb; subscribe stays numeric for the routing-side footgun reason)
- [x] **Tier 1 pi-exit resilience** (`pi.alive` in `get-state`,
  loud daemon log on exit, `host:pi_exit` event for subscribers)
- [x] **Scripts:** `start-host.sh`, `start-discord.sh`, `start-all.sh`,
  `restart-host.sh`, `restart-discord.sh`, `dev-test.sh` — all with
  `--bg` backgrounding and env inheritance from running daemon
- [x] **pi-host / pi-discord split** — monorepo restructure; pi-host
  owns pi lifecycle + supervisor surface; pi-discord owns Discord
  bridge + connects to pi-host as a subscriber. Discord-shaped state
  (subscriptions, ping mode, digest, missed pings) now lives with
  the bridge, not the supervisor.

## Likely-next (no urgency)

- [ ] **Tier 2 resilience** — automatic pi respawn on unexpected exit
  (with backoff). pi-host keeps the same session file. Worth doing
  once we've actually been bitten by a pi crash; currently tier 1's
  visibility plus operator-triggered restart is sufficient.
- [ ] **Tier 3 resilience** — corrupt-session detection. If pi exits
  within N seconds of a `--session <path>` spawn, fall back to fresh
  and quarantine the bad session file. Rare in practice; revisit if
  observed.
- [ ] **Role-ping detection** — `<@&role_id>` mentions don't trigger
  discli's `mentions_bot`. v2 fix: discli exposes the bot's role
  memberships via `ready`, bridge treats role mentions as pings when
  the bot has the role. Currently dropped if not also a user mention.
- [ ] **Inbound reactions** as ambient events — opt-in
  `reaction-mode: {follow_up|none}` (default `none`). High noise in
  active channels; ship if the agent ever asks "did anyone react to
  what I sent?"
- [ ] **`acm_map` UX** — pi-acm's recall table currently lacks THINK%
  and per-row content preview. Testing-instance feedback. Probably
  upstream PRs to pi-acm rather than local patches.
- [ ] **Bridge presence in pi-host's `get-state`** — `host.subscribers`
  is populated but `pi-ctl get-state` doesn't yet surface bridge
  names prominently. Minor; revisit if multiple bridges land.
- [ ] **Restore digest-on-nudge** — the bridge can carry the digest
  on the next Discord delivery, but pi-host's standalone idle nudges
  no longer pick up a digest tail (the bridge would need to react
  to `host:nudge_fired` and proactively flush). Small UX regression
  from the split; punted.

## Out of scope for now

- **Native AgentTool registrations** alongside bash. Considered,
  dropped — testing instances haven't surfaced shell-friction that
  justifies the parallel surface. Bash-to-CLI is what shipped.
- **Galaxy-brained draft-watcher** model (typing emerges from file
  edits). Considered, dropped — same friction as a manual verb,
  more state, more failure modes.
- **Last-prompt debug verb** (testing-instance suggestion). Operator
  can `tail` the pi session log; not worth the in-memory ring buffer.
- **Auto-typing during agent_run** in the trigger channel. Sounds
  appealing but every variant we considered ghosts (agent reasons in
  the channel context, decides not to reply, user sees typing-then-
  silence). Manual verb is the honest choice.
- **Auto-reconnect of dropped events.** If pi-discord is disconnected
  from pi-host when a Discord event arrives, the event is logged-
  and-dropped (the buffer flush sees no connection and bails). A
  future "queue-while-disconnected" mode could change this; not
  worth the persistence complexity yet.
