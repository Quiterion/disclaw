## Context

pi-mono's coding agent has a clean extension API that exposes lifecycle hooks, custom tool registration, session persistence via sidecar entries, and a `context` event fired before every LLM call. The reference implementation (rickross/openfork) implements ACM by mutating message-level fields directly in opencode's internals. The goal here is to achieve equivalent behavior entirely through pi's public extension surface -- no fork, no core modification, distributable as a pi package.

The key pi extension hooks this design depends on:
- `context` event -- deep copy of messages before each LLM call, return modified messages
- `session_before_compact` -- intercept compaction, provide custom summary or cancel
- `before_agent_start` -- inject messages and modify system prompt before each user turn
- `session_start` -- restore ACM state from custom entries on load
- `turn_start` / `turn_end` -- track active time for chess-clock compaction
- `pi.appendEntry()` -- persist ACM metadata as sidecar JSONL entries
- `pi.registerTool()` -- expose 9 ACM tools to the LLM
- `pi.registerCommand()` -- expose user-facing `/acm` commands

## Goals / Non-Goals

**Goals:**
- Full sliding window ACM as a zero-modification pi extension package
- 9 LLM-callable tools covering observe, control, and compact capabilities
- Persistent ACM metadata (pinned, pruned, sniped, priority, chess-clock) in session JSONL sidecar entries
- Override pi's default compaction with ACM-aware sliding window
- Live TUI widget showing context health
- Context status whisper on every turn
- Installable via `pi install git:...` or `npm:@<org>/pi-acm`

**Non-Goals:**
- Modifying pi-mono core (AgentMessage types, compaction pipeline, session format)
- Part-level ID tracking (pi messages use anonymous content arrays -- sniping operates at message level)
- Paired pruning of tool call + result pairs (snipe handles the result content; structural removal is out of scope for v1)
- Web UI or RPC mode specific UI components

## Decisions

### 1. Sidecar state model over message mutation

**Decision**: ACM metadata lives in `customType: "acm"` JSONL entries, not in message content.

**Rationale**: pi's `AgentMessage` types don't have ACM fields (no `pinned`, `priority`, etc.). Mutating messages directly would require either forking pi or type augmentation with unknown compatibility. Sidecar entries are the idiomatic pi pattern for extension state -- they persist, survive restarts, and are explicitly excluded from LLM context by the session manager.

**Alternative considered**: TypeScript declaration merging to augment `AgentMessage`. Rejected -- fragile against pi-mono version updates, and the sidecar model is cleaner and more explicit.

**State shape**:
```typescript
interface AcmState {
  pinned:   Record<string, boolean>       // entryId → true
  pruned:   Record<string, boolean>       // entryId → true
  sniped:   Record<string, SnipeConfig>   // entryId → snipe config
  priority: Record<string, number>        // entryId → 0-10
  chessClock: {
    activeMinutes: number
    lastTurnStart: number | null
    gapThresholdSeconds: number           // idle gaps don't count
  }
  summaryMarker: string | null            // entry ID of sliding window boundary
  config: {
    autoCompactOnPercent: number          // trigger at % of context window (default 85)
    keepActiveMinutes: number             // default window size
  }
}
```

Each mutation writes a new `acm` custom entry. On `session_start`, the extension replays all `acm` entries (last-write-wins per key) to reconstruct state. No extra storage format needed.

### 2. Parallel walk for entry-to-message mapping

**Decision**: Map context event messages to session entry IDs by walking `ctx.sessionManager.getBranch()` in parallel with `event.messages`.

**Rationale**: The `context` event provides `AgentMessage[]` with no entry IDs attached. Session entries contain the messages but as JSONL entries. `buildSessionContext()` in pi-mono produces messages from the branch in a deterministic order -- the same order that arrives in `event.messages`. Walking both sequences in parallel gives a reliable entryId↔message mapping.

**Alternative considered**: Content hashing. Rejected -- expensive, collides on identical content (retries), and unreliable for tool results which can be large.

**Alternative considered**: Timestamp matching. Rejected -- millisecond collisions possible in rapid parallel tool execution.

**Walk logic**:
```
branch entries (ordered root→leaf): [hdr, msg_a, msg_b, cmp, msg_c, msg_d]
                                           ↕      ↕          ↕      ↕
context event messages:            [summary, msg_b, msg_c, msg_d]
                                   (after compaction: summary replaces pre-cmp msgs)
```
The compaction entry transforms branch entries into a `CompactionSummaryMessage`. Walk must account for this: when a `CompactionEntry` is encountered in the branch, the corresponding context message is the `CompactionSummaryMessage`.

### 3. Content replacement sniping, not structural removal

**Decision**: `acm_snipe` replaces message content in the context event deep copy. It never removes messages or modifies tool call/result pairings.

**Rationale**: Anthropic's API is strict about tool call/result pairing. Removing a `ToolResultMessage` without removing its corresponding `toolCall` block orphans the call and causes API rejection. Content replacement (truncate, remove, replace) achieves 90%+ token reduction without touching structure.

**v1 snipe targets**:
- `ToolResultMessage.content` → truncate or replace text
- `AssistantMessage` thinking blocks → remove `ThinkingContent` entries
- `BashExecutionMessage.output` → truncate string
- `UserMessage` image blocks → remove `ImageContent` entries

**v1 does not snipe**: `ToolCall` blocks in `AssistantMessage` (structural integrity risk).

### 4. Compaction override intercepts `session_before_compact`

**Decision**: Register a `session_before_compact` handler that implements the sliding window and returns a custom `compaction` object (or cancels and manages context entirely via the `context` event).

**Rationale**: Pi's default compaction chops at a boundary and generates an AI summary. ACM's sliding window instead moves the `summaryMarker` forward in the sidecar state -- no LLM call needed for compaction. The `session_before_compact` event provides `preparation.firstKeptEntryId` and `preparation.tokensBefore`, which ACM uses to calculate where to place the new marker.

**Sliding window algorithm**:
1. Identify the `keepActiveMinutes` boundary using chess-clock active time
2. Set `summaryMarker` to the oldest message within that window
3. In the `context` event: messages before the marker are dropped (except pinned)
4. Pinned messages prepend the final message list regardless of age
5. Return a minimal synthetic compaction summary describing what was slid past

### 5. Context status whisper via `before_agent_start` custom message

**Decision**: Inject a `display: false` custom message with context status before each agent turn.

**Rationale**: The openfork reference injects status by appending to the last user message's text content. In pi, `before_agent_start` lets us inject a proper custom message -- cleaner, no mutation of user content, semantically distinct. The `display: false` flag hides it from the TUI but the LLM sees it.

**Alternative considered**: System prompt injection via `systemPrompt` return from `before_agent_start`. Used additionally -- the system prompt gets a one-line ACM capability reminder, while the whisper carries the per-turn token status.

### 6. Tool tier strategy: 9 tools at launch

**Decision**: Ship 9 tools in Tier 1+2. Drop `acm_snapshot`, `acm_search`, `acm_fetch`, `acm_repair`, `acm_load`, `acm_unload` for v1.

| Tool | Tier | Rationale |
|------|------|-----------|
| `acm_map` | 1 | Core observe -- without this the LLM can't navigate |
| `acm_pin` | 1 | Core inception |
| `acm_unpin` | 1 | Core inception reversal |
| `acm_prune` | 1 | Core message removal |
| `acm_compact` | 1 | Core sliding window trigger |
| `acm_hunt` | 2 | Bloat detection -- very high value, low complexity |
| `acm_snipe` | 2 | Surgical reduction -- high value, moderate complexity |
| `acm_mark` | 2 | Priority -- needed for intelligent auto-compact |
| `acm_diagnose` | 2 | Health check -- low complexity, high user trust |

Dropped tools: `acm_snapshot` (debug-only, better as a command), `acm_search` (pi has `/tree`), `acm_fetch` (sessionManager accessible), `acm_repair` (pi's JSONL is simpler), `acm_load`/`acm_unload` (subsumed by sliding window).

## Risks / Trade-offs

**[Parallel walk fragility under branching]** → The entry-to-message mapping assumes linear branch walk. When users navigate the session tree mid-session, the branch changes. Mitigation: rebuild the mapping fresh on each `context` event (it's cheap), never cache it across turns.

**[Sniped content is lost to the LLM forever (within the session)]** → Once sniped, the LLM can't see the original content unless the snipe is reversed. There is no `acm_unsnipe` in v1. Mitigation: the JSONL source is always intact; the user can access original content via pi's session viewer or `/tree`. Add `acm_unsnipe` in v2 if demand exists.

**[Chess-clock accuracy depends on turn events]** → If pi is used in non-interactive mode (print mode, RPC), `turn_start`/`turn_end` may behave differently. Mitigation: fall back to wall-clock time when chess-clock data is insufficient. Document the limitation.

**[Token estimation accuracy]** → `gpt-tokenizer` estimates tokens for Anthropic models via tiktoken (cl100k). These are approximations. Real token counts from the API may differ by 5-15%. Mitigation: use actual API token counts from `AssistantMessage.usage` for the status whisper where available, estimates only for planning.

**[Context event fires on every turn]** → The parallel walk + filter runs synchronously before each LLM call. For very long sessions (1000+ entries), this could add latency. Mitigation: maintain an incremental index; only re-walk new entries since last call.

**[Priority-based auto-pruning is opinionated]** → Auto-compaction with priority levels makes judgments about what's important. Users may be surprised when high-priority messages survive a compact while expected ones disappear. Mitigation: `acm_compact` supports `dry_run: true` for preview before committing.

## Open Questions

- **npm org name**: What npm org publishes this? `@pi-tools/acm`, `@<yourname>/pi-acm`, or unscoped `pi-acm`?
- **Default auto-compact threshold**: 85% of context window feels right from openfork's experience, but needs validation against pi's `reserveTokens` setting (16k by default). Should the threshold be relative to `contextWindow - reserveTokens`?
- **Skill file aggressiveness**: Should the bundled SKILL.md instruct the LLM to call `acm_compact` proactively at >80% context, or only when explicitly asked? The openfork approach is proactive. Pi's philosophy is minimal intervention.
