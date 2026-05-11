## ADDED Requirements

### Requirement: LLM can surgically reduce message content via acm_snipe
The extension SHALL register an `acm_snipe` tool that replaces the expensive content of a message with a compact version in the context event, without removing the message or breaking any tool call/result pairings.

#### Scenario: Snipe truncates a tool result by character limit
- **WHEN** the LLM calls `acm_snipe` with `strategy: "truncate"` and a `max_chars` value on a `ToolResultMessage` entry
- **THEN** on the next and all subsequent `context` events, that message's content text is replaced with the first `max_chars` characters followed by a truncation marker: `[ACM: truncated from Xk chars]`

#### Scenario: Snipe removes content and replaces with marker
- **WHEN** the LLM calls `acm_snipe` with `strategy: "remove"` on any message
- **THEN** the content is replaced with `[ACM: Xk tokens removed from <role>/<toolName>]`, preserving the message shell

#### Scenario: Snipe applies an LLM-written replacement
- **WHEN** the LLM calls `acm_snipe` with `strategy: "replace"` and a non-empty `replacement` string
- **THEN** the entire content is replaced with the provided replacement text verbatim

#### Scenario: Snipe removes thinking blocks from assistant messages
- **WHEN** the LLM calls `acm_snipe` with `target: "thinking"` on an `AssistantMessage`
- **THEN** all `ThinkingContent` blocks are removed from that message's content in the context event; text and tool call blocks are preserved

#### Scenario: Snipe truncates bash execution output
- **WHEN** the LLM calls `acm_snipe` with `strategy: "truncate"` on a `BashExecutionMessage`
- **THEN** the `output` field is truncated to `max_chars` with a truncation marker appended

#### Scenario: Snipe head+tail strategy keeps beginning and end
- **WHEN** the LLM calls `acm_snipe` with `strategy: "head_tail"` and a `max_chars` value
- **THEN** the content is replaced with the first `max_chars/2` characters, a gap marker `[... X chars removed ...]`, and the last `max_chars/2` characters

#### Scenario: Snipe does not modify tool call blocks
- **WHEN** the LLM attempts to call `acm_snipe` with a `target` value that would affect `toolCall` content blocks in an `AssistantMessage`
- **THEN** the tool returns an error explaining that tool call blocks cannot be sniped as they would orphan the corresponding tool results

#### Scenario: Snipe does not modify the session JSONL
- **WHEN** `acm_snipe` is applied to a message
- **THEN** the original message entry in the session JSONL file is unchanged; only the sidecar ACM state records the snipe config, which is applied at context-event time

#### Scenario: Sniped message shows reduced token count in acm_map
- **WHEN** a message has been sniped
- **THEN** `acm_map` shows both the original token estimate (stored) and the effective token count (after snipe), with a `[SNP]` status flag
