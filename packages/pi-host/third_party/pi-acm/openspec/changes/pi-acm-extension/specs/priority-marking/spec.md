## ADDED Requirements

### Requirement: LLM can assign priority levels to messages via acm_mark
The extension SHALL register an `acm_mark` tool that assigns a numeric priority (0-10) to a message, controlling its survival order during auto-compaction under token pressure.

#### Scenario: Marking a message with a priority level
- **WHEN** the LLM calls `acm_mark` with an entry ID and a `priority` value between 0 and 10
- **THEN** the priority is stored in ACM state for that entry and `acm_map` shows the priority value alongside the entry

#### Scenario: Priority 0 marks a message for immediate next compaction
- **WHEN** a message has priority 0
- **THEN** it is pruned automatically on the next `acm_compact` call before any other messages are evaluated

#### Scenario: Priority 10 is equivalent to inception pinning
- **WHEN** a message has priority 10
- **THEN** it behaves identically to a pinned message: it survives all compactions and is prepended to context

#### Scenario: Auto-compaction respects priority order
- **WHEN** `acm_compact` runs and must drop messages to meet the token budget
- **THEN** messages are dropped in ascending priority order (lowest first), with equal-priority messages dropped oldest-first

#### Scenario: Priority is independent of pinning
- **WHEN** a message has both a priority level and a pinned flag
- **THEN** the pinned flag takes precedence for survival; priority only affects ordering among non-pinned messages during compaction

### Requirement: User can mark message priority via command
The extension SHALL register a `/mark <id> <priority>` command for user-initiated priority assignment.

#### Scenario: /mark command sets priority
- **WHEN** the user types `/mark <entry-id> <0-10>` in the pi TUI
- **THEN** the specified message is assigned the given priority and the TUI confirms
