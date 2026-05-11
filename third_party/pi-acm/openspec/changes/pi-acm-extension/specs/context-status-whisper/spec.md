## ADDED Requirements

### Requirement: Context status whisper injected before each LLM turn
The extension SHALL inject a `display: false` custom message containing a `<context-status>` tag before each LLM turn via the `before_agent_start` event, so the LLM always knows its current token position without requiring a tool call.

#### Scenario: Whisper contains token count and percentage
- **WHEN** a user prompt triggers an agent turn
- **THEN** a custom message with `customType: "acm-status"` and `display: false` is injected containing: current token count, percentage of context window used, pinned message count, pruned message count, and active minutes from chess-clock

#### Scenario: Whisper is hidden from the TUI
- **WHEN** the context status whisper message is injected
- **THEN** it does not appear in the pi TUI conversation view (due to `display: false`) but is visible to the LLM as part of the message sequence

#### Scenario: Whisper uses actual token counts when available
- **WHEN** the most recent assistant message in the session has `usage.input` data from the API
- **THEN** the whisper uses that actual token count rather than a `gpt-tokenizer` estimate for the percentage calculation

#### Scenario: Whisper falls back to estimated tokens when no usage data
- **WHEN** no prior assistant message with token usage exists in the session (e.g., first turn)
- **THEN** the whisper uses `gpt-tokenizer` estimates for the token count

#### Scenario: Whisper is included in system prompt ACM instructions
- **WHEN** the `before_agent_start` handler fires
- **THEN** in addition to the whisper message, the system prompt is appended with a brief line reminding the LLM that ACM is active and the whisper tag is present, so the LLM understands the signal

### Requirement: acm_diagnose detects session health issues
The extension SHALL register an `acm_diagnose` tool that scans the session for structural issues that could cause API errors or context corruption.

#### Scenario: Diagnose detects incomplete tool calls
- **WHEN** the session contains a tool part stuck in `pending` or `running` state in a prior turn
- **THEN** `acm_diagnose` reports it as an error with the entry ID, tool name, and stuck status

#### Scenario: Diagnose detects aborted tool executions
- **WHEN** the session contains a tool part with `status: "error"` and `error: "Tool execution aborted"`
- **THEN** `acm_diagnose` reports it as a warning (aborts are expected interruptions, not corruption)

#### Scenario: Diagnose reports clean session
- **WHEN** no issues are found
- **THEN** `acm_diagnose` returns a single-line confirmation: "Session is healthy. N messages scanned, no issues."

#### Scenario: Diagnose skips the current turn's message
- **WHEN** `acm_diagnose` is called as a tool during an agent turn
- **THEN** the message containing the current `acm_diagnose` call is excluded from scanning (the current tool call is always incomplete by definition)
