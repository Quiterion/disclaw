/**
 * compaction.ts
 *
 * Intercepts pi's session_before_compact event to implement ACM sliding window.
 * Instead of pi's default LLM-generated summary, ACM moves the summaryMarker
 * forward and produces a minimal synthetic summary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState, saveState, appendManifestEntries } from "./state.js"
import type { AcmState } from "./state.js"
import { estimateTokens } from "./token-counter.js"
import { getActiveMinutesSince } from "./chess-clock.js"
import { generateManifestEntries } from "./manifest.js"

type BranchEntry = {
  type: string; id: string; parentId: string | null; timestamp: string
  message?: { role: string; [k: string]: unknown }
  firstKeptEntryId?: string
}

export function registerCompactionHandler(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, _ctx) => {
    const state = getState()
    const { preparation } = event as any

    // Run the sliding window algorithm
    const result = calculateWindowBoundary(
      (event as any).branchEntries ?? [],
      state
    )

    if (!result) {
      // Nothing to compact — let pi do its default thing
      return undefined
    }

    const { newMarker, droppedCount, droppedEntries, tokensSaved } = result

    // Generate manifest entries for everything being dropped
    const manifestEntries = generateManifestEntries(droppedEntries, "slide", state)

    // Persist the new marker + manifest
    const withMarker: AcmState = { ...state, summaryMarker: newMarker }
    const updatedState = appendManifestEntries(withMarker, manifestEntries)
    saveState(pi, updatedState)

    // Build a minimal synthetic summary for pi to store
    const summary = [
      "## ACM Sliding Window Compaction",
      ``,
      `Context window slid forward. ${droppedCount} messages moved behind the window boundary.`,
      `Pinned (inception) messages are preserved and will continue to appear in context.`,
      ``,
      `Window marker: ${newMarker}`,
      `Estimated tokens freed: ~${tokensSaved}`,
    ].join("\n")

    return {
      compaction: {
        summary,
        firstKeptEntryId: preparation?.firstKeptEntryId ?? newMarker,
        tokensBefore: preparation?.tokensBefore ?? 0,
        details: { acmMarker: newMarker, droppedCount, tokensSaved },
      },
    }
  })
}

// ── Window boundary calculation ───────────────────────────────────────────────

interface WindowResult {
  newMarker: string
  droppedCount: number
  droppedEntries: ReadonlyArray<BranchEntry>
  tokensSaved: number
}

/**
 * Find the oldest message entry within the keepActiveMinutes window.
 * Returns null if there's nothing to compact.
 */
export function calculateWindowBoundary(
  branch: ReadonlyArray<BranchEntry>,
  state: AcmState
): WindowResult | null {
  const keepMinutes = state.config.keepActiveMinutes
  const clock = state.chessClock
  const pinnedIds = new Set(Object.keys(state.pinned).filter(id => state.pinned[id]))

  // Collect message entries with their active-time age
  const msgEntries = branch.filter(e => e.type === "message" && e.message)

  if (msgEntries.length < 2) return null  // Nothing to compact

  // Find the boundary: oldest entry within keepActiveMinutes of active time
  // We use the LAST entry as "now" and walk backwards
  const targetEntry = msgEntries.find(e => {
    const activeMinutes = getActiveMinutesSince(e.timestamp, clock)
    return activeMinutes <= keepMinutes
  })

  if (!targetEntry) return null

  let markerIdx = msgEntries.indexOf(targetEntry)
  if (markerIdx <= 0) return null  // All messages are within window

  // ── Pair-aware boundary snap ───────────────────────────────────────────
  // Build tool call/result pairing at the branch entry level.
  // If the boundary would split a pair (call before, result after or vice versa),
  // snap the boundary forward to include the orphaned partner in the kept set.
  markerIdx = snapToPairBoundary(msgEntries, markerIdx, pinnedIds)
  if (markerIdx <= 0) return null  // Snap consumed everything

  // Calculate what would be dropped (non-pinned entries before the marker)
  const toBeDrop = msgEntries.slice(0, markerIdx).filter(e => !pinnedIds.has(e.id))
  if (toBeDrop.length === 0) return null

  const tokensSaved = toBeDrop.reduce((sum, e) => {
    const msg = e.message as { role: string; [k: string]: unknown }
    return sum + estimateTokens(msg)
  }, 0)

  return {
    newMarker: msgEntries[markerIdx]!.id,
    droppedCount: toBeDrop.length,
    droppedEntries: toBeDrop,
    tokensSaved,
  }
}

/**
 * Snap the compaction boundary forward if it would split a tool call/result pair.
 *
 * Strategy: collect all toolCallIds from entries BEFORE the boundary.
 * If any entry AFTER the boundary is a result referencing one of those calls,
 * the pair is split. Snap boundary forward past the result.
 * Repeat until stable (handles chains of parallel calls).
 */
function snapToPairBoundary(
  msgEntries: ReadonlyArray<BranchEntry>,
  markerIdx: number,
  pinnedIds: Set<string>
): number {
  let snapped = markerIdx

  // Iterate until stable — snapping forward may expose new splits
  let changed = true
  while (changed) {
    changed = false

    // Collect toolCallIds from entries that would be dropped (before boundary, non-pinned)
    const droppedCallIds = new Set<string>()
    for (let i = 0; i < snapped; i++) {
      const entry = msgEntries[i]!
      if (pinnedIds.has(entry.id)) continue
      const msg = entry.message
      if (msg?.role === "assistant" && Array.isArray((msg as any).content)) {
        for (const block of (msg as any).content) {
          if (block.type === "toolCall" && typeof block.id === "string") {
            droppedCallIds.add(block.id)
          }
        }
      }
    }

    if (droppedCallIds.size === 0) break

    // Check entries at/after boundary for orphaned results
    for (let i = snapped; i < msgEntries.length; i++) {
      const entry = msgEntries[i]!
      const msg = entry.message as any
      const toolCallId = msg?.toolCallId
      if (typeof toolCallId === "string" &&
        (msg?.role === "toolResult" || msg?.role === "bashExecution")) {
        if (droppedCallIds.has(toolCallId)) {
          // This result's call would be dropped — snap boundary past it
          snapped = i + 1
          changed = true
          // Silently snap — stats tracked via addPreventionDrop in context-filter
        }
      }
    }
  }

  return snapped
}
