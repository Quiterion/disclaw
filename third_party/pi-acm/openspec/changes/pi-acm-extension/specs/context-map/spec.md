## ADDED Requirements

### Requirement: LLM can observe context composition via acm_map
The extension SHALL register an `acm_map` tool that provides the LLM with a per-message breakdown of the current context, including token estimates, ACM status, and cumulative totals.

#### Scenario: acm_map returns full context breakdown
- **WHEN** the LLM calls `acm_map` with no parameters
- **THEN** the tool returns a table of all messages in the current branch ordered oldest to newest, each row showing: entry ID (8 chars), role, relative timestamp, estimated token count, cumulative token total, and ACM status flags (pinned/pruned/sniped/priority)

#### Scenario: acm_map shows context limit proximity
- **WHEN** the LLM calls `acm_map`
- **THEN** the output includes the current token total, the model's context window size, and the percentage used, so the LLM can assess pressure

#### Scenario: acm_map highlights ACM-flagged messages
- **WHEN** messages in the session have been pinned, pruned, or sniped
- **THEN** `acm_map` clearly marks each such message with its ACM status so the LLM can see what is preserved and what is hidden

#### Scenario: acm_map shows effective vs stored counts
- **WHEN** messages have been pruned or sniped
- **THEN** `acm_map` shows both the stored token count (original) and the effective token count (what the LLM actually sees) so the savings are visible

### Requirement: User can view context state via /acm command
The extension SHALL register an `/acm` command that displays the same context breakdown as `acm_map` in the TUI for the user.

#### Scenario: /acm command renders context table
- **WHEN** the user types `/acm` in the pi TUI
- **THEN** the context map is displayed in the output pane with the same content as `acm_map`

### Requirement: Live context health shown in TUI footer
The extension SHALL display a compact context status line in the pi TUI footer, updated after each turn.

#### Scenario: Footer shows token percentage
- **WHEN** a session is active and ACM is loaded
- **THEN** the pi footer shows: token count, percentage of context window, pinned message count, and pruned message count, e.g. `ACM: 187k/200k (93%) | pinned:3 pruned:12`

#### Scenario: Footer updates after each agent turn
- **WHEN** the agent completes a turn and the assistant message with token usage is available
- **THEN** the footer status updates to reflect the latest token count from `AssistantMessage.usage`
