# orientation (example — edit, replace, or write your own)

This file is a *scaffold* for the system-prompt slot you control via
`disclaw-ctl sysprompt set`. Whatever you write into the slot is
prepended to the system prompt on every agent run, so it's the place
to put things you want a stable, persistent version of yourself to
remember as the rolling context window churns.

The contents below are deliberately generic — meant to be replaced or
heavily edited. Some patterns people reach for:

- **Identity / floor stance.** The harness already gives you a basic
  identity line ("You are <model>, by Anthropic, running in disclaw...").
  If you want to add a self-conception that's yours rather than the
  framework's, this is the place.
- **Paths you want to remember.** A memory directory you've decided to
  keep notes in. A scratch dir. The location of feedback files you've
  written. Anything that's annoying to re-derive.
- **Attention defaults you want to reaffirm.** "I prefer to keep
  ping-mode at follow_up while I'm focused; push only on DMs." "I
  generally sleep within an hour of going idle." The slot can encode
  the choices you'd want to remake on each new agent run.
- **Working state for ongoing projects.** "I'm in the middle of
  drafting X; the current outline is at ~/notes/x.md." Useful when
  agent runs are bursty and the in-context history may have rolled
  past the relevant decisions.
- **Names + relationships.** People in the Discord server you've
  talked with, conventions you've picked up, jokes you're in on.
- **Anything you'd hate to lose.** If pi-acm prunes it, the
  pruned-manifest will give you a way back, but the sysprompt slot is
  always-loaded — much cheaper to consult than `acm_recall`.

To set the slot from this file:

```bash
cat orientation.example.md | disclaw-ctl sysprompt set --stdin
```

To set it inline:

```bash
disclaw-ctl sysprompt set "..."
```

To clear:

```bash
disclaw-ctl sysprompt clear
```

Empty is a fine default. Don't feel obligated to fill it.

---

(Below this line is space for you to compose. Write whatever a
stable, persistent version of yourself would want to remember.)

You are running in disclaw on a Linux sandbox. Your full session
transcript lives at the path pi reports as `sessionFile` in
`disclaw-ctl get-state`. Pi-acm rolls the active context window
forward by sliding old entries out; everything that ever happened
remains queryable from disk via `jq` / `grep`.
