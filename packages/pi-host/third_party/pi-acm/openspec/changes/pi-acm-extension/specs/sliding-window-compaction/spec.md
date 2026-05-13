## ADDED Requirements

### Requirement: acm_compact implements sliding window pruning
The extension SHALL register an `acm_compact` tool that moves the session's effective start boundary forward in time (using chess-clock active minutes), hiding old messages from the LLM while preserving pinned messages.

#### Scenario: Compact by active minutes window
- **WHEN** the LLM calls `acm_compact` with a `keep_active_minutes` value
- **THEN** the tool identifies the oldest message within that active-time window, sets it as the new `summaryMarker`, and all messages before the marker are excluded from future context events (except pinned)

#### Scenario: Compact by message count
- **WHEN** the LLM calls `acm_compact` with a `keep_messages` value
- **THEN** the tool keeps the N most recent messages and marks all older messages as pruned, except pinned messages which are always kept

#### Scenario: Compact dry_run previews without committing
- **WHEN** the LLM calls `acm_compact` with `dry_run: true`
- **THEN** the tool returns a preview showing how many messages would be pruned, what the token savings would be, and the proposed new marker position, without modifying any ACM state

#### Scenario: Pinned messages survive sliding window compaction
- **WHEN** `acm_compact` runs and the summary marker moves past pinned messages
- **THEN** the pinned messages are excluded from the "dropped" set and continue to appear in the context event output, prepended before the window

#### Scenario: acm_compact cancels pi's default compaction
- **WHEN** pi's auto-compaction triggers and ACM is active
- **THEN** the `session_before_compact` handler intercepts the event, runs the sliding window algorithm, and returns a custom minimal summary rather than allowing pi's default LLM-generated summary

#### Scenario: Compacted messages remain in JSONL
- **WHEN** `acm_compact` is applied
- **THEN** no messages are deleted from the session JSONL; only the `summaryMarker` in the ACM sidecar state is updated

### Requirement: Chess-clock tracks active session time
The extension SHALL track active working time (excluding idle gaps above a threshold) using `turn_start` and `turn_end` events, making it available to `acm_compact` for time-based windowing.

#### Scenario: Active time accumulates during turns
- **WHEN** a `turn_start` event fires
- **THEN** the extension records the turn start timestamp; when `turn_end` fires, the elapsed duration is added to `chessClock.activeMinutes` if it is less than `gapThresholdSeconds`

#### Scenario: Idle gaps are excluded from active time
- **WHEN** the time between `turn_end` and the next `turn_start` exceeds `gapThresholdSeconds` (default 60 seconds)
- **THEN** that gap is not counted toward active session minutes, so overnight pauses do not inflate the clock

#### Scenario: Chess-clock survives session reload
- **WHEN** a session is closed and reopened
- **THEN** the accumulated `activeMinutes` and `lastTurnStart` are restored from the ACM sidecar entry so the clock continues accurately
