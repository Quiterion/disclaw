# pi-acm

Active Context Management for [pi](https://github.com/badlogic/pi-mono) — sliding window context management as a distributable pi extension.

Keeps long-running sessions coherent by sliding the context window forward instead of chopping history and generating lossy AI summaries. Critical messages survive via inception pinning. Expensive tool outputs get surgically trimmed. The LLM always knows its token position.

## Install

```bash
pi install npm:pi-acm
```

Or add to `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-acm"]
}
```

## Quick Start

Once installed, ACM runs automatically. Every turn you'll see a footer status line:

```
ACM: 187k/200k (93%) | ↑3 ✂12
```

And the LLM receives a hidden `<context-status>` tag before each turn.

### Common commands

```
/acm              — show full context map
/pin <id>         — pin a message as inception
/unpin <id>       — remove pin
/prune <id>       — hide a message from context
/mark <id> <0-10> — set priority
/hunt             — find the biggest token consumers
/diagnose         — check session health
```

### Common tool calls (LLM-initiated)

```
acm_map                                    — context breakdown
acm_hunt                                   — find bloat
acm_pin({ id: "a1b2c3d4" })               — pin a message
acm_prune({ id: ["a1b2c3d4", "e5f6..."] }) — prune multiple
acm_snipe({ id: "a1b2", strategy: "truncate", max_chars: 200 })
acm_compact({ dry_run: true })             — preview sliding window
acm_compact({ keep_active_minutes: 30 })   — commit
acm_diagnose()                             — health check
```

## How It Works

ACM is a pure pi extension — no pi-mono core modifications. It uses:

- **`context` event** — filters messages before each LLM call (prune, snipe, pin prepend, window boundary)
- **`session_before_compact`** — intercepts compaction and applies sliding window instead of AI summary
- **`before_agent_start`** — injects the `<context-status>` whisper and ACM system prompt reminder
- **`turn_start/end`** — tracks active working time for chess-clock compaction
- **`pi.appendEntry()`** — persists all ACM metadata as sidecar JSONL entries (session file untouched)

## Architecture

```
extensions/index.ts          Entry point
src/
  state.ts                   AcmState type, loadState, saveState
  entry-map.ts               entry ID ↔ context message mapping
  context-filter.ts          context event handler (pipeline)
  snipe-apply.ts             snipe strategy implementations
  token-counter.ts           gpt-tokenizer estimates
  chess-clock.ts             active time tracking
  compaction.ts              session_before_compact handler
  whisper.ts                 before_agent_start handler
  id-resolver.ts             partial ID prefix matching
  tools/
    observe.ts               acm_map, acm_hunt, acm_diagnose
    control.ts               acm_pin, acm_unpin, acm_prune, acm_mark
    snipe.ts                 acm_snipe
    compact.ts               acm_compact
  ui/
    commands.ts              user-facing slash commands
    status.ts                footer status widget
skills/acm/SKILL.md          LLM instructions
tests/                       vitest unit tests
```

## Configuration

Default config in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "acm": {
    "autoCompactOnPercent": 85,
    "keepActiveMinutes": 30
  }
}
```

(Config is stored in ACM sidecar entries — see `src/state.ts` for the full `AcmConfig` shape.)

## What Gets Preserved

- **Session JSONL is never modified** — all changes are in-memory (applied at `context` event time)
- **Pinned messages survive everything** — they prepend context regardless of window boundary
- **Pruned/sniped content is always accessible** via pi's session viewer or the raw `.jsonl` file

## License

MIT
