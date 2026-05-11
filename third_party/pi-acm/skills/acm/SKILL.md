---
name: acm
description: Active Context Management — manage context window for long-running sessions
---

# Active Context Management (ACM)

ACM gives you surgical control over the context window for long-running sessions. Instead of losing work to lossy AI summaries, you can slide the window forward, preserve critical messages, and trim expensive content — all without losing the session file.

## The Context Status Whisper

Every turn, a hidden `<context-status>` tag and `<pruned-manifest>` are injected into your context:

```xml
<context-status tokens="187,000" percent="93%" limit="200,000" pinned="3" pruned="12" sniped="2" active_minutes="32"/>
<pruned-manifest count="12">
  [a1b2c3d4] toolResult read "src/state.ts" — "export interface AcmConfig {" (38m, 847tok)
  [c3d4e5f6] assistant — "I'll configure JWT with RS256 because..." (42m, 1203tok)
  [e5f6g7h8] user — "use RS256 not HS256" (43m, 52tok)
</pruned-manifest>
```

Read `<context-status>` at the start of each turn. At >80%, consider using ACM tools.

Scan `<pruned-manifest>` for topics relevant to the current task — it lists everything ACM has hidden from your context with entry IDs, roles, previews, and token counts.

## Tools Reference

| Tool | What it does |
|------|-------------|
| `acm_map` | Context htop — per-message token breakdown with ACM status |
| `acm_hunt` | Find the biggest token consumers |
| `acm_pin` | Mark a message as inception (survives everything) |
| `acm_unpin` | Remove inception mark |
| `acm_prune` | Hide a message from context (never deleted) |
| `acm_snipe` | Replace expensive content with a compact version |
| `acm_mark` | Set priority 0-10 (controls pruning order) |
| `acm_compact` | Slide the window forward (drop old, keep recent + pinned) |
| `acm_recall` | Recover pruned/windowed content from the session branch |
| `acm_diagnose` | Check session health |

## Recommended Workflow

### When context reaches 70-80%

1. Call `acm_map` — get the full picture
2. Call `acm_hunt` — find the big token consumers
3. For each large tool result: call `acm_snipe` with `strategy:"truncate"` or write a summary and use `strategy:"replace"`
4. For entire messages that are no longer needed: call `acm_prune`

### When context reaches 90%+

5. Call `acm_compact` with `dry_run:true` to preview the sliding window
6. If the preview looks correct, call `acm_compact` without `dry_run` to commit

### What to pin (inception)

Pin messages that contain decisions, constraints, or context you **cannot afford to lose**:
- The initial problem statement or goal
- Key architectural decisions made during the session
- Important error messages that constrain the solution space
- Critical "do not do X" instructions
- Agreed-upon interfaces or contracts

### Priority guidelines

| Priority | When to use |
|----------|-------------|
| 10 | Same as pinned — never prune |
| 7-9 | Important context, prune only under severe pressure |
| 4-6 | Useful but not critical (default) |
| 1-3 | Low value — prune early |
| 0 | Prune immediately on next compact |

## When to act proactively vs. wait

**Act proactively** (without being asked) when:
- `<context-status percent>` reaches 85% or higher
- The session has been running for >30 active minutes
- You see large tool results (file reads, npm output, build logs) that are no longer needed

**Wait for user instruction** when:
- Context is below 70%
- You're uncertain what context is safe to drop
- The session is short and content is still actively referenced

## Snipe strategies

- **`truncate`**: Keep the first N chars. Good for file reads where the start has useful structure.
- **`head_tail`**: Keep first + last N/2 chars. Good for build logs where errors are at the end.
- **`remove`**: Replace entirely with a marker. Good for completely obsolete content.
- **`replace`**: LLM-written replacement. Most powerful — read the content first, write a brief summary, then snipe with that summary.

## Recall — Recover pruned context

Content removed by prune, slide, or pressure is never lost — it stays in the session file. Use `acm_recall` to get it back.

### Using acm_recall

1. **Browse**: `acm_recall({})` — overview of all hidden entries
2. **Search**: `acm_recall({ grep: "pattern" })` — regex search across hidden content
3. **Fetch**: `acm_recall({ id: "a1b2" })` — full content of a specific entry
4. **Filter**: combine `role`, `tool`, `grep` to narrow results

Examples:
```
acm_recall({ grep: "JWT|RS256" })                     — find auth-related content
acm_recall({ role: "toolResult", tool: "read" })       — list all hidden file reads
acm_recall({ id: ["a1b2", "c3d4"] })                   — fetch two specific entries
acm_recall({ grep: "config", role: "toolResult" })     — search tool results for config
```

### When to recall proactively

- **Before modifying a file** listed in `<pruned-manifest>` — check if decisions were made about it
- **When the user references something** you can't find in visible context
- **When you're uncertain** why a specific implementation choice was made
- **When you see a relevant keyword** in `<pruned-manifest>` that relates to the current task

Recall results are token-budgeted (default 4000 tokens) to prevent undoing ACM's context savings.

## Important constraints

- `acm_snipe` never touches `toolCall` blocks — that would break API pairing
- Pruned and sniped content is hidden from the LLM but always intact in the session file
- Pinned messages cannot be pruned (unpin first)
- `acm_compact` with `dry_run:true` is safe — no changes until you remove `dry_run`
- `acm_recall` results count toward context — don't recall everything at once
