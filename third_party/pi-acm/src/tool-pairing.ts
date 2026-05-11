/**
 * tool-pairing.ts
 *
 * Maintains tool_use / tool_result pairing invariants for the Anthropic API.
 *
 * Provides:
 *  - buildPairIndex()       — single-pass index of all tool call/result pairs
 *  - getPartnerIndices()    — given a message index, return its pair partners
 *  - repairToolPairing()    — safety-net removal of orphaned calls/results
 *  - Ephemeral per-turn stats for UI visibility
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type ContentBlock = { type: string; id?: string; [key: string]: unknown }
type AgentMessage = { role: string; content?: ContentBlock[] | string; toolCallId?: string; [key: string]: unknown }

export interface ToolPair {
  callId: string
  callMsgIdx: number
  resultMsgIdx: number | null  // null if result not yet present (mid-execution)
}

export interface PairIndex {
  /** toolCallId → pair info */
  byCallId: Map<string, ToolPair>
  /** message index → list of toolCallIds contained in that message */
  callIdsByMsgIdx: Map<number, string[]>
  /** message index → toolCallId it references (for result messages) */
  resultIdByMsgIdx: Map<number, string>
}

/** Ephemeral per-turn stats (not persisted) */
export interface PairingStats {
  pairsDroppedByPrevention: number
  orphansRepairedByNet: number
}

// ─── Module-level ephemeral stats ────────────────────────────────────────────

let _turnStats: PairingStats = { pairsDroppedByPrevention: 0, orphansRepairedByNet: 0 }

export function getTurnStats(): PairingStats { return _turnStats }
export function resetTurnStats(): void { _turnStats = { pairsDroppedByPrevention: 0, orphansRepairedByNet: 0 } }
export function addPreventionDrop(count: number): void { _turnStats.pairsDroppedByPrevention += count }

// ─── Build pair index ────────────────────────────────────────────────────────

/**
 * Single pass over messages to build a bidirectional index of tool call/result pairs.
 */
export function buildPairIndex(messages: ReadonlyArray<AgentMessage>): PairIndex {
  const byCallId = new Map<string, ToolPair>()
  const callIdsByMsgIdx = new Map<number, string[]>()
  const resultIdByMsgIdx = new Map<number, string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    // Collect toolCall IDs from assistant messages
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const callIds: string[] = []
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          callIds.push(block.id)
          byCallId.set(block.id, { callId: block.id, callMsgIdx: i, resultMsgIdx: null })
        }
      }
      if (callIds.length > 0) {
        callIdsByMsgIdx.set(i, callIds)
      }
    }

    // Collect toolCallId from result messages
    const toolCallId = msg.toolCallId ?? (msg as any).toolCallId
    if (typeof toolCallId === "string" &&
      (msg.role === "toolResult" || msg.role === "bashExecution")) {
      resultIdByMsgIdx.set(i, toolCallId)
      const pair = byCallId.get(toolCallId)
      if (pair) {
        pair.resultMsgIdx = i
      }
    }
  }

  return { byCallId, callIdsByMsgIdx, resultIdByMsgIdx }
}

// ─── Partner lookup ──────────────────────────────────────────────────────────

/**
 * Given a message index being dropped, return all partner indices that must
 * also be dropped to maintain pairing.
 *
 * - If idx is an assistant msg with toolCalls → return indices of all its toolResult partners
 * - If idx is a toolResult/bashExecution → return index of the assistant msg containing its toolCall
 */
export function getPartnerIndices(idx: number, pairIndex: PairIndex): number[] {
  const partners: number[] = []

  // Check if this message contains toolCalls (assistant message)
  const callIds = pairIndex.callIdsByMsgIdx.get(idx)
  if (callIds) {
    for (const callId of callIds) {
      const pair = pairIndex.byCallId.get(callId)
      if (pair && pair.resultMsgIdx !== null) {
        partners.push(pair.resultMsgIdx)
      }
    }
  }

  // Check if this message is a tool result
  const resultCallId = pairIndex.resultIdByMsgIdx.get(idx)
  if (resultCallId) {
    const pair = pairIndex.byCallId.get(resultCallId)
    if (pair) {
      partners.push(pair.callMsgIdx)
    }
  }

  return partners
}

/**
 * Expand a set of indices to include all pair partners.
 * Iterates until stable (handles chains).
 */
export function expandWithPartners(
  indices: Set<number>,
  pairIndex: PairIndex,
  pinnedIndices?: Set<number>
): Set<number> {
  const expanded = new Set(indices)
  let changed = true
  while (changed) {
    changed = false
    for (const idx of [...expanded]) {
      const partners = getPartnerIndices(idx, pairIndex)
      for (const p of partners) {
        // Never force-drop a pinned message
        if (pinnedIndices && pinnedIndices.has(p)) continue
        if (!expanded.has(p)) {
          expanded.add(p)
          changed = true
        }
      }
    }
  }
  return expanded
}

// ─── Repair (safety net) ────────────────────────────────────────────────────

export interface RepairResult {
  messages: AgentMessage[]
  repairedCount: number
}

/**
 * Safety-net repair: remove orphaned tool_results and orphaned toolCall blocks.
 * Runs after all prevention stages.
 *
 * Direction 1: toolResult/bashExecution with no matching toolCall → remove message
 * Direction 2: toolCall block in assistant with no matching result → remove the block
 *
 * Note: Direction 2 (orphaned toolCall with no result) is only repaired when
 * ACM is actively filtering. During normal mid-execution, a toolCall without
 * a result is expected (the tool is still running).
 */
export function repairToolPairing(
  messages: AgentMessage[],
  isActivelyFiltering: boolean
): RepairResult {
  let repairedCount = 0

  // Collect all valid toolCall IDs from assistant messages
  const validCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          validCallIds.add(block.id)
        }
      }
    }
  }

  // Collect all result IDs
  const resultCallIds = new Set<string>()
  for (const msg of messages) {
    const toolCallId = msg.toolCallId ?? (msg as any).toolCallId
    if (typeof toolCallId === "string" &&
      (msg.role === "toolResult" || msg.role === "bashExecution")) {
      resultCallIds.add(toolCallId)
    }
  }

  // Direction 1: remove result messages with no matching call
  let filtered = messages.filter(msg => {
    const toolCallId = msg.toolCallId ?? (msg as any).toolCallId
    if (typeof toolCallId === "string" &&
      (msg.role === "toolResult" || msg.role === "bashExecution")) {
      if (!validCallIds.has(toolCallId)) {
        repairedCount++
        // Tracked in _turnStats, visible via /acm-diagnose
        return false
      }
    }
    return true
  })

  // Direction 2: remove toolCall blocks from assistant messages with no matching result
  // Only when actively filtering — during normal execution, missing results are expected
  if (isActivelyFiltering) {
    for (const msg of filtered) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const before = (msg.content as ContentBlock[]).length
        msg.content = (msg.content as ContentBlock[]).filter(block => {
          if (block.type === "toolCall" && typeof block.id === "string") {
            if (!resultCallIds.has(block.id)) {
              repairedCount++
              // Tracked in _turnStats, visible via /acm-diagnose
              return false
            }
          }
          return true
        })
      }
    }
  }

  _turnStats.orphansRepairedByNet = repairedCount

  return { messages: filtered, repairedCount }
}
