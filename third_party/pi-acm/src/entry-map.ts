/**
 * entry-map.ts
 *
 * Maps context event AgentMessage[] ↔ session entry IDs via parallel walk.
 *
 * pi's buildSessionContext() produces messages from branch entries in a
 * deterministic order. We walk both sequences in parallel to establish a
 * reliable entryId ↔ AgentMessage mapping without hashing or timestamps.
 *
 * Compaction handling: a CompactionEntry in the branch corresponds to a
 * CompactionSummaryMessage (role: "compactionSummary") in context messages.
 * Messages before the CompactionEntry's firstKeptEntryId are not in context.
 */

export interface EntryMapResult {
  /** entry ID → message index in the context messages array */
  idToIndex: Map<string, number>
  /** message index → entry ID */
  indexToId: Map<number, string>
}

type BranchEntry = {
  type: string
  id: string
  parentId: string | null
  // Message entries have a message field
  message?: { role: string; [key: string]: unknown }
  // Compaction entries have firstKeptEntryId
  firstKeptEntryId?: string
  // Custom message entries
  customType?: string
  content?: unknown
  display?: boolean
}

type AgentMessage = {
  role: string
  [key: string]: unknown
}

/**
 * Build a bidirectional map between session entry IDs and context message indices.
 *
 * Uses a two-pass approach:
 *   Pass 1: Find the LAST compaction entry on the branch (if any) and its
 *           firstKeptEntryId. Only entries at-or-after that boundary appear
 *           in the context event messages.
 *   Pass 2: Walk the branch. Skip entries before the boundary (including any
 *           earlier compaction entries). Map the last compaction → the
 *           compactionSummary message, then map subsequent message entries
 *           normally.
 *
 * @param branch    Entries from ctx.sessionManager.getBranch(), root→leaf order
 * @param messages  Messages from the context event, in the order pi provides them
 */
export function buildEntryMap(
  branch: ReadonlyArray<BranchEntry>,
  messages: ReadonlyArray<AgentMessage>
): EntryMapResult {
  const idToIndex = new Map<string, number>()
  const indexToId = new Map<number, string>()

  // ── Pass 1: find the last compaction entry ───────────────────────────────
  let lastCompaction: BranchEntry | null = null
  for (const entry of branch) {
    if (entry.type === "compaction") {
      lastCompaction = entry
    }
  }
  const boundary = lastCompaction?.firstKeptEntryId ?? null

  // ── Pass 2: walk and map ──────────────────────────────────────────────────
  let msgIdx = 0
  let pastBoundary = boundary === null  // true when no compaction (all entries in context)
  let compactionMapped = false

  for (const entry of branch) {
    if (msgIdx >= messages.length) break

    // Once we reach the firstKeptEntryId, entries are in context
    if (!pastBoundary && entry.id === boundary) {
      pastBoundary = true
    }

    // Before the boundary: only the last compaction entry itself gets mapped
    // (as the compactionSummary message, which is always first in context)
    if (!pastBoundary) {
      if (entry.type === "compaction" && entry === lastCompaction && !compactionMapped) {
        const msg = messages[msgIdx]
        if (msg && msg.role === "compactionSummary") {
          idToIndex.set(entry.id, msgIdx)
          indexToId.set(msgIdx, entry.id)
          msgIdx++
          compactionMapped = true
        }
      }
      // All other pre-boundary entries are not in context — skip
      continue
    }

    // Past the boundary: map entries that produce context messages
    switch (entry.type) {
      case "message": {
        const msg = messages[msgIdx]
        if (msg) {
          idToIndex.set(entry.id, msgIdx)
          indexToId.set(msgIdx, entry.id)
          msgIdx++
        }
        break
      }

      case "branch_summary": {
        const msg = messages[msgIdx]
        if (msg && msg.role === "branchSummary") {
          idToIndex.set(entry.id, msgIdx)
          indexToId.set(msgIdx, entry.id)
          msgIdx++
        }
        break
      }

      case "custom_message": {
        const msg = messages[msgIdx]
        if (msg && msg.role === "custom") {
          idToIndex.set(entry.id, msgIdx)
          indexToId.set(msgIdx, entry.id)
          msgIdx++
        }
        break
      }

      // compaction entries at/after boundary, label, model_change, etc:
      // do NOT produce context messages — skip
      default:
        break
    }
  }

  return { idToIndex, indexToId }
}

/**
 * Convenience: given a context messages array and a branch, return a Map
 * from message object reference → entry ID. Useful for looking up an ID
 * given a specific message object from event.messages.
 */
export function buildMessageToIdMap(
  branch: ReadonlyArray<BranchEntry>,
  messages: ReadonlyArray<AgentMessage>
): Map<AgentMessage, string> {
  const { indexToId } = buildEntryMap(branch, messages)
  const result = new Map<AgentMessage, string>()
  for (const [idx, id] of indexToId) {
    const msg = messages[idx]
    if (msg) result.set(msg, id)
  }
  return result
}
