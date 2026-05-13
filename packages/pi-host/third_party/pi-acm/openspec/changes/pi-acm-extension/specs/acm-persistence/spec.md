## ADDED Requirements

### Requirement: ACM state persists in session JSONL as custom entries
The extension SHALL store all ACM metadata (pinned, pruned, sniped, priority, chess-clock, summaryMarker, config) as `customType: "acm"` entries appended to the session JSONL via `pi.appendEntry()`. Each mutation produces a new entry; state is rebuilt by replaying entries on load.

#### Scenario: ACM state is written after each mutation
- **WHEN** any ACM tool modifies state (pin, unpin, prune, snipe, mark, compact)
- **THEN** `pi.appendEntry("acm", fullAcmState)` is called immediately after the mutation, persisting the updated state to the session JSONL

#### Scenario: ACM state is restored on session start
- **WHEN** a session containing `customType: "acm"` entries is opened
- **THEN** the `session_start` handler replays all ACM entries in order, with later entries overwriting earlier ones for each key, reconstructing the full ACM state in memory

#### Scenario: Sessions without ACM entries load cleanly
- **WHEN** a session with no `customType: "acm"` entries is opened
- **THEN** the extension initializes with a default empty ACM state (no pins, no prunes, no snipes) and operates normally

#### Scenario: ACM custom entries are not sent to the LLM
- **WHEN** the session context is built for an LLM call
- **THEN** `customType: "acm"` entries are excluded from `event.messages` by pi's session manager (as all `custom` entries are), and the LLM never sees raw ACM metadata

### Requirement: ACM state uses last-write-wins per key during replay
The extension SHALL reconstruct state by replaying all ACM entries from oldest to newest, so the most recent value for each field wins.

#### Scenario: State replay produces consistent result
- **WHEN** a session has 50 ACM entries accumulated over many mutations
- **THEN** replaying them in order produces the same final state as if only the last entry existed for each key, with no partial or conflicting values

#### Scenario: ACM entry replay is order-dependent
- **WHEN** an entry pins message A, then a later entry unpins message A
- **THEN** after replay, message A is not pinned (the unpin wins as it was written later)
