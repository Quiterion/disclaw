## Why

Long-running pi sessions hit context limits and lose critical information through lossy AI-generated summaries. Instead of amputating and recapping history, a sliding window approach moves the compaction boundary forward while preserving pinned (inception) messages -- keeping multi-hour sessions coherent without manual context rebuilding.

## What Changes

- New distributable pi package (`pi-acm`) that installs via `pi install git:...` or `npm install`
- 9 LLM-callable tools covering context observation (`acm_map`, `acm_hunt`, `acm_diagnose`), message control (`acm_pin`, `acm_unpin`, `acm_prune`, `acm_snipe`, `acm_mark`), and sliding window compaction (`acm_compact`)
- User-accessible `/acm` commands mirroring the LLM tools for manual control
- Live context status widget in the pi TUI footer showing token usage, pinned count, and pruned count
- Context status whisper injected into every LLM turn so the model is always context-aware
- Override of pi's default compaction via `session_before_compact` to implement the sliding window algorithm
- ACM metadata (pinned, pruned, sniped, priority, chess-clock) persisted as sidecar custom entries in the session JSONL -- source JSONL is never modified
- A `SKILL.md` bundled with the package instructing the LLM when and how to use ACM tools

## Capabilities

### New Capabilities

- `context-map`: Real-time visibility into context composition -- per-message token estimates, ACM status (pinned/pruned/priority), cumulative totals, and distance from context limit
- `inception-pinning`: Mark messages as inception so they survive all compactions and always appear at the front of context
- `message-pruning`: Mark messages for removal from the LLM's view without deleting them from the session file
- `surgical-sniping`: Replace expensive content within a message (file reads, tool outputs) with a compact version or LLM-written summary, preserving conversation structure
- `priority-marking`: Assign priority levels (0-10) to messages to control pruning order under token pressure
- `sliding-window-compaction`: Replace pi's default chop-and-summarize compaction with a marker-based sliding window that keeps recent context intact and prepends pinned messages
- `acm-persistence`: Store all ACM metadata as sidecar custom entries in the session JSONL, restored on session reload
- `context-status-whisper`: Inject a `<context-status>` tag into every LLM turn so the model knows its current token position

### Modified Capabilities

## Impact

- **New package**: `@<org>/pi-acm` published to npm and/or git, installable as a pi package
- **No pi-mono core changes**: Implemented entirely through the pi extension API (`context`, `session_before_compact`, `before_agent_start`, `session_start`, `turn_start`, `turn_end`, `session_shutdown` events)
- **New npm dependency**: `gpt-tokenizer` for accurate token estimation before LLM calls
- **Session file format**: Adds `customType: "acm"` entries to JSONL; existing sessions without ACM entries work unchanged (graceful degradation)
- **LLM tool namespace**: 9 new tools prefixed `acm_` registered in the session; no conflicts with pi built-in tools
