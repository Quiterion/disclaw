# next steps

Snapshot of what's done, what's running, and what's next. Living
document — feel free to reorder / strike / add. Last meaningful update:
2026-05-12.

## Done (already shipped)

- [x] **Slice A — session resumption** across daemon restart
  (`last_session_file` in state.json, `--session` to pi on startup)
- [x] **Slice B — activity digest** (sidebar-style unread counts for
  unsubscribed channels; `digest_mode` + `digest` peek + `digest ack`
  drain)
- [x] **Slice C — buffering + flush-time formatting** (per-mode event
  buffers, `<disclaw>`-wrapped batched user messages)
- [x] **Slice D pt 1 — missed-pings log** (JSONL of pings dropped
  while ping-mode = none, reviewable via ctl)
- [x] **Slice D pt 2 — discli `humanize_mentions` patch** (incoming
  `<@id>` substituted to `@name`; tracked on Quiterion/discli's
  disclaw-patches branch)
- [x] **XML message format** (`<disclaw>`/`<time>`/`<channel>`/`<ping>`/
  `<digest>`/`<attachment>` — parser-unambiguous; wall-clock times
  that don't rot)
- [x] **`whois` verb** (name → user_id resolution)
- [x] **Typing indicator verb** (manual, agent-controlled)
- [x] **Reactions** (`react`/`unreact` + `id` attribute on `<ping>`)
- [x] **`send --stdin`** (heredoc / pipe for substantive replies —
  sidesteps shell quoting hell)
- [x] **Channel-name resolution** (`#name` accepted in any pass-through
  verb; subscribe stays numeric for the routing-side footgun reason)
- [x] **Tier 1 pi-exit resilience** (`host.alive` getter, loud daemon
  log on exit, `[drop]` on dead-pi dispatches, `pi.alive` in
  `get-state`)
- [x] **`scripts/start.sh` + `scripts/restart.sh`** (with `--bg`
  backgrounding, env inheritance from running daemon, and state.json
  fallback for cold restart)
- [x] **Bug fixes:** socket-unlink race on shutdown, control.ts
  RUNTIME_DIR not respecting env, sysprompt-leak across isolated
  test runs

## Likely-next (no urgency)

- [ ] **Tier 2 resilience** — automatic pi respawn on unexpected exit
  (with backoff). Daemon keeps the same session file. Worth doing
  once we've actually been bitten by a pi crash; currently tier 1's
  visibility plus operator-triggered restart is sufficient.
- [ ] **Tier 3 resilience** — corrupt-session detection. If pi exits
  within N seconds of a `--session <path>` spawn, fall back to fresh
  and quarantine the bad session file. Rare in practice; revisit if
  observed.
- [ ] **Role-ping detection** — `<@&role_id>` mentions don't trigger
  discli's `mentions_bot`. v2 fix: discli exposes the bot's role
  memberships via `ready`, daemon treats role mentions as pings when
  the bot has the role. Currently dropped if not also a user mention.
- [ ] **Inbound reactions** as ambient events — opt-in
  `reaction-mode: {follow_up|none}` (default `none`). High noise in
  active channels; ship if the agent ever asks "did anyone react to
  what I sent?"
- [ ] **`acm_map` UX** — pi-acm's recall table currently lacks THINK%
  and per-row content preview. Testing-instance feedback. Probably
  upstream PRs to pi-acm rather than local patches.

## Out of scope for now

- **Native AgentTool registrations** alongside bash. Considered, dropped
  — testing instances haven't surfaced shell-friction that justifies
  the parallel surface. Bash-to-CLI is what shipped.
- **Galaxy-brained draft-watcher** model (typing emerges from file
  edits). Considered, dropped — same friction as a manual verb,
  more state, more failure modes.
- **`disclaw-ctl last-prompt` debug verb** (testing-instance
  suggestion). Operator can `tail` the pi session log; not worth the
  in-memory ring buffer.
- **Auto-typing during agent_run** in the trigger channel. Sounds
  appealing but every variant we considered ghosts (agent reasons in
  the channel context, decides not to reply, user sees typing-then-
  silence). Manual verb is the honest choice.
