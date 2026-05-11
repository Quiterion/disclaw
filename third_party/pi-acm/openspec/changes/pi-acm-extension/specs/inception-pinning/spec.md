## ADDED Requirements

### Requirement: LLM can pin messages as inception via acm_pin
The extension SHALL register an `acm_pin` tool that marks a message as inception -- permanently preserved and always prepended to the LLM's context regardless of compaction or sliding window position.

#### Scenario: Pinning a message by full entry ID
- **WHEN** the LLM calls `acm_pin` with a valid 8-character entry ID
- **THEN** the message is added to the pinned set in ACM state, and `acm_map` shows it as `[PIN]`

#### Scenario: Pinning a message by partial ID prefix
- **WHEN** the LLM calls `acm_pin` with a prefix shorter than 8 characters that uniquely matches one entry
- **THEN** the matching entry is pinned and the tool confirms the full ID that was matched

#### Scenario: Partial ID matches multiple entries
- **WHEN** the LLM calls `acm_pin` with a prefix that matches more than one entry
- **THEN** the tool returns an error listing all ambiguous matches, and no entry is pinned

#### Scenario: Pinned messages appear first in context
- **WHEN** the `context` event fires and one or more messages are pinned
- **THEN** the pinned messages are prepended to the front of the message list (after any compaction summary), regardless of their chronological position

#### Scenario: Pinned messages survive sliding window compaction
- **WHEN** `acm_compact` slides the window forward past a pinned message
- **THEN** the pinned message is excluded from the "dropped" set and continues to appear in context

### Requirement: LLM can remove inception mark via acm_unpin
The extension SHALL register an `acm_unpin` tool that removes a message's pinned status.

#### Scenario: Unpinning a pinned message
- **WHEN** the LLM calls `acm_unpin` with the entry ID of a pinned message
- **THEN** the message is removed from the pinned set and no longer prepended to context on future turns

#### Scenario: Unpinning a non-pinned message
- **WHEN** the LLM calls `acm_unpin` with an entry ID that is not currently pinned
- **THEN** the tool returns an informational message indicating the entry was not pinned, with no error

### Requirement: User can pin and unpin messages via commands
The extension SHALL register `/pin <id>` and `/unpin <id>` commands for user-initiated pinning.

#### Scenario: /pin command pins a message
- **WHEN** the user types `/pin <entry-id>` in the pi TUI
- **THEN** the specified message is pinned and the TUI confirms with the message's role and timestamp
