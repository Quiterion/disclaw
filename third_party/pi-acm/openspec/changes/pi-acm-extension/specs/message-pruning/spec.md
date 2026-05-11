## ADDED Requirements

### Requirement: LLM can mark messages for removal via acm_prune
The extension SHALL register an `acm_prune` tool that marks one or more messages to be excluded from the LLM's context on all future turns. Pruned messages are never deleted from the session JSONL.

#### Scenario: Pruning a single message by entry ID
- **WHEN** the LLM calls `acm_prune` with a single entry ID
- **THEN** the message is added to the pruned set in ACM state and excluded from the context event messages on all future turns

#### Scenario: Pruning multiple messages in one call
- **WHEN** the LLM calls `acm_prune` with an array of entry IDs
- **THEN** all specified messages are marked pruned atomically

#### Scenario: Pruned messages do not appear in LLM context
- **WHEN** the `context` event fires and messages are in the pruned set
- **THEN** those messages are filtered out of `event.messages` before the return value, and the LLM does not see them on that turn or any future turn

#### Scenario: Pruned messages are preserved in session file
- **WHEN** a message has been pruned
- **THEN** the original message entry remains in the session JSONL file unchanged; only the ACM sidecar state marks it as pruned

#### Scenario: Pinned messages cannot be pruned
- **WHEN** the LLM calls `acm_prune` on an entry that is currently pinned
- **THEN** the tool returns an error requiring the message to be unpinned first

### Requirement: User can prune messages via command
The extension SHALL register a `/prune <id>` command for user-initiated pruning.

#### Scenario: /prune command marks a message pruned
- **WHEN** the user types `/prune <entry-id>` in the pi TUI
- **THEN** the specified message is marked pruned and the TUI confirms with the message's summary info

### Requirement: acm_hunt identifies high-token messages for pruning candidates
The extension SHALL register an `acm_hunt` tool that returns the top-N messages sorted by token count, helping the LLM identify pruning candidates.

#### Scenario: acm_hunt returns top token consumers
- **WHEN** the LLM calls `acm_hunt` with an optional `limit` parameter (default 10)
- **THEN** the tool returns a ranked list of messages from largest to smallest token count, each with entry ID, role, tool name (if tool result), token estimate, and a content preview

#### Scenario: acm_hunt excludes already-pruned messages
- **WHEN** messages in the session have already been pruned
- **THEN** `acm_hunt` excludes them from the results since they are no longer consuming effective context
