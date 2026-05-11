## 1. Package Scaffold

- [x] 1.1 Create package directory structure: `extensions/`, `src/tools/`, `skills/acm/`
- [x] 1.2 Write `package.json` with `pi-package` keyword, `gpt-tokenizer` dependency, and `pi` manifest pointing to `extensions/` and `skills/`
- [x] 1.3 Write `extensions/index.ts` entry point that imports and registers all tools, commands, and event handlers
- [x] 1.4 Run `npm install` and verify `gpt-tokenizer` resolves

## 2. ACM State Layer

- [x] 2.1 Define `AcmState` TypeScript interface (pinned, pruned, sniped, priority, chessClock, summaryMarker, config)
- [x] 2.2 Implement `SnipeConfig` type with strategy, maxChars, replacement, and target fields
- [x] 2.3 Implement `loadState(entries)` that replays `customType: "acm"` session entries last-write-wins to produce current state
- [x] 2.4 Implement `saveState(pi, state)` that calls `pi.appendEntry("acm", state)` after each mutation
- [x] 2.5 Register `session_start` handler that calls `loadState` from `ctx.sessionManager.getEntries()` and stores in module-level state variable

## 3. Entry-to-Message Mapping

- [x] 3.1 Implement `buildEntryMap(branch, messages)` that walks `ctx.sessionManager.getBranch()` and `event.messages` in parallel to produce `Map<entryId, AgentMessage>` and inverse `Map<AgentMessage, entryId>`
- [x] 3.2 Handle the compaction case: when a `CompactionEntry` is encountered in the branch, map it to the `CompactionSummaryMessage` in the context messages
- [x] 3.3 Write unit tests for `buildEntryMap` covering: linear session, session with one compaction, session with multiple compactions

## 4. Context Event Filter

- [x] 4.1 Register `context` event handler that calls `buildEntryMap` then applies all active ACM filters
- [x] 4.2 Implement pruned-message filter: remove messages whose entryId is in `acmState.pruned`
- [x] 4.3 Implement snipe transform: for messages with a snipe config, apply the configured strategy (truncate/head_tail/remove/replace) to the appropriate content fields
- [x] 4.4 Implement pinned prepend: collect pinned messages not already in the window, sort chronologically, prepend to the filtered list
- [x] 4.5 Implement summary marker filter: exclude messages before `acmState.summaryMarker` (except pinned)
- [x] 4.6 Implement priority-based pressure filter: when context usage exceeds `config.autoCompactOnPercent`, prune messages in ascending priority order until under threshold
- [x] 4.7 Validate that tool call / result pairings are intact after all filters; log a warning if any orphan is detected but do not throw

## 5. Token Counting

- [x] 5.1 Implement `estimateTokens(message: AgentMessage): number` using `gpt-tokenizer` on JSON-serialized content
- [x] 5.2 Implement `getActualTokens(ctx): number | null` that reads the latest `AssistantMessage.usage.input` from session entries
- [x] 5.3 Implement `getEffectiveTokens(messages, acmState): number` that sums estimates on the post-filter message list (uses estimates for all, overrides total with actual if available)

## 6. Chess-Clock

- [x] 6.1 Register `turn_start` handler that records `Date.now()` into `chessClock.lastTurnStart`
- [x] 6.2 Register `turn_end` handler that computes elapsed ms, checks against `gapThresholdSeconds`, adds to `chessClock.activeMinutes` if under threshold, saves state
- [x] 6.3 Implement `getActiveTimeMessage(entryId, chessClock)` that returns the active minutes elapsed since a given entry's timestamp (used by `acm_compact` for time-based windowing)

## 7. Core Tools: Observe

- [x] 7.1 Implement `acm_map` tool: walk branch entries, compute per-entry token estimates and effective counts, format as aligned table with ID/role/time/tokens/effective/status columns
- [x] 7.2 Implement `acm_hunt` tool: sort branch entries by estimated token count descending, return top-N with content preview, excluding already-pruned entries
- [x] 7.3 Implement `acm_diagnose` tool: scan branch for pending/running tool parts (excluding current message), report errors and warnings grouped by type

## 8. Core Tools: Control

- [x] 8.1 Implement `acm_pin` tool: resolve partial entry ID, add to `acmState.pinned`, save state, confirm with entry summary
- [x] 8.2 Implement `acm_unpin` tool: remove from `acmState.pinned`, save state, return informational message if not pinned
- [x] 8.3 Implement `acm_prune` tool: accept single ID or array, check not pinned, add to `acmState.pruned`, save state
- [x] 8.4 Implement `acm_mark` tool: validate priority 0-10, store in `acmState.priority`, save state; priority 10 also adds to pinned set
- [x] 8.5 Implement partial ID resolution utility used by pin/unpin/prune/mark/snipe: match prefix against all entry IDs, error on ambiguity

## 9. Core Tool: Snipe

- [x] 9.1 Implement snipe config storage in `acmState.sniped[entryId]`
- [x] 9.2 Implement `truncate` strategy in context filter: slice content text to `maxChars`, append `[ACM: truncated from Xk chars]`
- [x] 9.3 Implement `head_tail` strategy in context filter: keep first and last `maxChars/2` chars with gap marker
- [x] 9.4 Implement `remove` strategy in context filter: replace content with `[ACM: Xk tokens removed from role/toolName]`
- [x] 9.5 Implement `replace` strategy in context filter: substitute content with provided `replacement` string verbatim
- [x] 9.6 Implement `thinking` target: filter out `ThinkingContent` blocks from `AssistantMessage`
- [x] 9.7 Guard against sniping `toolCall` blocks: return error if target would affect tool call content
- [x] 9.8 Register `acm_snipe` tool with all four strategies and three targets, calling the above implementations

## 10. Sliding Window Compaction

- [x] 10.1 Register `session_before_compact` handler that intercepts pi's auto-compaction, runs the sliding window algorithm, returns a custom `compaction` object with a minimal synthetic summary
- [x] 10.2 Implement `calculateWindowBoundary(branch, acmState)` that finds the oldest entry within `keepActiveMinutes` of active time
- [x] 10.3 Implement `acm_compact` tool with `keep_active_minutes`, `keep_messages`, `gap_threshold`, and `dry_run` parameters
- [x] 10.4 Implement dry_run mode: compute what would be pruned and token savings without mutating state, return preview report
- [x] 10.5 Implement commit mode: set `summaryMarker`, clear any explicitly-pruned entries that are now behind the marker (redundant), save state

## 11. Context Status Whisper

- [x] 11.1 Register `before_agent_start` handler that computes current token status (actual or estimated), constructs the `<context-status>` XML tag string
- [x] 11.2 Return the whisper as `{ message: { customType: "acm-status", content: "...", display: false } }` from the handler
- [x] 11.3 Append a one-line ACM instruction to `systemPrompt` from the handler: model should be aware of the whisper and can use ACM tools
- [x] 11.4 Ensure the whisper message is excluded from `acm_map` output (it is a custom message, not a session entry)

## 12. TUI Integration

- [x] 12.1 Register `turn_end` handler that calls `ctx.ui.setStatus("acm", ...)` with the updated token count, percentage, pinned count, and pruned count
- [x] 12.2 Register `/acm` command that renders the `acm_map` output via `ctx.ui.notify` or a custom widget
- [x] 12.3 Register `/pin <id>`, `/unpin <id>`, `/prune <id>`, `/mark <id> <priority>` user commands that call the same underlying state functions as their tool counterparts
- [x] 12.4 Register `/hunt` and `/diagnose` commands for user-initiated analysis

## 13. Skill File

- [x] 13.1 Write `skills/acm/SKILL.md` covering: what ACM is, when to call each tool, recommended workflow (map → hunt → snipe/prune → compact), and interpretation of the `<context-status>` whisper
- [x] 13.2 Include guidance on when to proactively compact vs. wait for user instruction (reference the design's open question on aggressiveness)

## 14. Testing and Validation

- [x] 14.1 Test `loadState` + `saveState` round-trip: mutate state, save, create new instance, load, assert equality
- [x] 14.2 Test context filter with a synthetic message list: prune, snipe, pin, and assert the filtered output matches expected structure
- [x] 14.3 Test tool call / result pairing validation: craft a filter scenario that would orphan a tool call and assert the warning fires without throwing
- [x] 14.4 Test `acm_compact` dry_run: run against a synthetic session, assert no state mutations occur
- [ ] 14.5 Install the extension locally via `pi -e ./extensions/index.ts` and run a live session to verify footer widget, whisper injection, and at least one tool call

## 15. Package Publication Prep

- [x] 15.1 Decide on npm org/package name (see design open question)
- [x] 15.2 Add `README.md` with install instructions, quick-start, and tool reference
- [ ] 15.3 Verify `pi install git:...` works end-to-end from a clean pi installation
- [ ] 15.4 Tag v0.1.0 and publish
