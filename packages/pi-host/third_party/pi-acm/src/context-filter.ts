/**
 * context-filter.ts
 *
 * Registers the `context` event handler that applies all ACM filters to the
 * message list before each LLM call.
 *
 * Filter pipeline (in order):
 *  1. Summary-marker filter   — drop messages before the sliding window boundary (pair-aware)
 *  2. Pruned-message filter   — drop explicitly pruned messages (pair-aware)
 *  3. Snipe transform         — replace expensive content with compact versions
 *  4. Priority pressure filter — auto-prune low-priority messages when near limit (pair-aware)
 *  5. Pinned prepend          — insert pinned messages at the front
 *  6. Tool pairing repair     — safety-net removal of any remaining orphans
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState, saveState, appendManifestEntries } from "./state.js"
import { buildEntryMap } from "./entry-map.js"
import { applySnipe } from "./snipe-apply.js"
import { estimateTokens } from "./token-counter.js"
import {
  buildPairIndex,
  expandWithPartners,
  repairToolPairing,
  resetTurnStats,
  addPreventionDrop,
} from "./tool-pairing.js"
import { generateManifestEntry } from "./manifest.js"

// ─── Types (subset of pi AgentMessage we care about) ─────────────────────────

type ContentBlock = { type: string; [key: string]: unknown }
type AgentMessage = { role: string; content?: ContentBlock[] | string; [key: string]: unknown }

// ─── Register ────────────────────────────────────────────────────────────────

export function registerContextHandler(pi: ExtensionAPI): void {
  // "context" is a valid runtime event but not in the typed overloads yet
  ;(pi as any).on("context", async (event: any, ctx: any) => {
    const state = getState()
    const messages = (event.messages as unknown) as AgentMessage[]

    // Reset per-turn pairing stats
    resetTurnStats()

    // Build entry↔message mapping for this turn
    const branch = (ctx.sessionManager.getBranch() as unknown) as Array<{
      type: string; id: string; parentId: string | null;
      firstKeptEntryId?: string; message?: { role: string }
    }>
    const { indexToId } = buildEntryMap(branch, messages)

    // Helper: get entry ID for a message by its position
    const idOf = (idx: number): string | undefined => indexToId.get(idx)

    // Build a set of entry IDs that are in the pinned set so we can skip
    // the summary-marker and prune filters for them
    const pinnedIds = new Set(Object.keys(state.pinned).filter(id => state.pinned[id]))

    // Build pair index for prevention — used by stages ①, ②, and ④
    const pairIndex = buildPairIndex(messages)

    // Build pinned indices set for expandWithPartners
    const pinnedMsgIndices = new Set<number>()
    for (const [idx, id] of indexToId) {
      if (id && pinnedIds.has(id)) pinnedMsgIndices.add(idx)
    }

    // ── 1. Summary-marker filter (pair-aware) ────────────────────────────────
    // Find the index of the marker message; drop everything before it (except pinned)
    let markerIdx = -1
    if (state.summaryMarker) {
      for (const [idx, id] of indexToId) {
        if (id === state.summaryMarker) {
          markerIdx = idx
          break
        }
      }
    }

    // Collect indices dropped by marker — then expand to include pair partners
    const markerDrops = new Set<number>()
    if (markerIdx >= 0) {
      for (let i = 0; i < markerIdx; i++) {
        const id = idOf(i)
        if (id && pinnedIds.has(id)) continue  // keep pinned
        markerDrops.add(i)
      }
      // Expand: if a tool result is behind the marker but its call is past it,
      // pull the result forward (don't drop it). Vice versa: if a call is behind
      // the marker, also drop its result even if past the marker.
      const expandedMarkerDrops = expandWithPartners(markerDrops, pairIndex, pinnedMsgIndices)
      const newPairDrops = expandedMarkerDrops.size - markerDrops.size
      if (newPairDrops > 0) {
        addPreventionDrop(newPairDrops)
      }
      // Use expanded set
      for (const idx of expandedMarkerDrops) markerDrops.add(idx)
    }

    // ── 2. Pruned-message filter (pair-aware) ────────────────────────────────
    // Collect pruned indices, then expand with pair partners
    const pruneDrops = new Set<number>()
    for (let i = 0; i < messages.length; i++) {
      const id = idOf(i)
      if (id && state.pruned[id] && !pinnedIds.has(id)) {
        pruneDrops.add(i)
      }
    }
    if (pruneDrops.size > 0) {
      const expandedPruneDrops = expandWithPartners(pruneDrops, pairIndex, pinnedMsgIndices)
      const newPairDrops = expandedPruneDrops.size - pruneDrops.size
      if (newPairDrops > 0) {
        addPreventionDrop(newPairDrops)
      }
      for (const idx of expandedPruneDrops) pruneDrops.add(idx)
    }

    // Combine all drops and build working set
    const allDrops = new Set([...markerDrops, ...pruneDrops])

    type IndexedMsg = { idx: number; msg: AgentMessage; id: string | undefined }
    let working: IndexedMsg[] = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      const id = idOf(i)

      // Always keep pinned
      if (id && pinnedIds.has(id)) {
        working.push({ idx: i, msg, id })
        continue
      }

      // Drop if in the combined drop set
      if (allDrops.has(i)) continue

      working.push({ idx: i, msg, id })
    }

    // ── 3. Snipe transform ───────────────────────────────────────────────────
    // Operate on the deep copy (event.messages is already a deep copy per pi docs)
    for (const { msg, id } of working) {
      if (id && state.sniped[id]) {
        applySnipe(msg, state.sniped[id]!)
      }
    }

    // ── 4. Priority-based pressure filter (pair-aware) ───────────────────────
    // Count current estimated tokens; if over threshold drop lowest-priority first
    let totalEstimate = working.reduce((sum, { msg }) => sum + estimateTokens(msg), 0)

    const contextUsage = ctx.getContextUsage()
    const contextWindow = contextUsage?.contextWindow ?? Infinity
    const autoThresholdTokens = Math.floor(contextWindow * (state.config.autoCompactOnPercent / 100))

    if (totalEstimate > autoThresholdTokens) {
      // Build a pair index over surviving messages for pair-aware pressure drops
      const survivingMsgs = working.map(w => w.msg)
      const survivingPairIndex = buildPairIndex(survivingMsgs)
      // Map from surviving index → working array index
      const survivingPinnedIndices = new Set<number>()
      working.forEach((w, si) => { if (w.id && pinnedIds.has(w.id)) survivingPinnedIndices.add(si) })

      // Sort non-pinned by priority ascending (lowest first = prune first),
      // then by position descending (oldest first within same priority)
      const nonPinned = working
        .map((w, si) => ({ ...w, si }))
        .filter(({ id }) => !id || !pinnedIds.has(id))
        .sort((a, b) => {
          const pa = (a.id ? (state.priority[a.id] ?? 5) : 5)
          const pb = (b.id ? (state.priority[b.id] ?? 5) : 5)
          if (pa !== pb) return pa - pb
          return a.idx - b.idx
        })

      const pressureDropIndices = new Set<number>() // indices into working[]

      for (const item of nonPinned) {
        if (totalEstimate <= autoThresholdTokens) break
        if (pressureDropIndices.has(item.si)) continue // already scheduled for drop

        // Drop this message and its pair partners atomically
        const toDrop = new Set([item.si])
        const expanded = expandWithPartners(toDrop, survivingPairIndex, survivingPinnedIndices)
        const newPairDrops = expanded.size - 1
        if (newPairDrops > 0) {
          addPreventionDrop(newPairDrops)
        }

        for (const si of expanded) {
          if (!pressureDropIndices.has(si)) {
            pressureDropIndices.add(si)
            totalEstimate -= estimateTokens(working[si]!.msg)
          }
        }
      }

      // Generate manifest entries for pressure-dropped messages
      const pressureDroppedEntries = Array.from(pressureDropIndices)
        .map(si => working[si]!)
        .filter(w => w.id)
      if (pressureDroppedEntries.length > 0) {
        const branchEntries = pressureDroppedEntries
          .map(w => {
            const entry = branch.find(e => e.id === w.id)
            return entry
          })
          .filter((e): e is NonNullable<typeof e> => e !== undefined && e.type === "message")
        const manifestEntries = branchEntries.map(e =>
          generateManifestEntry(e as any, "pressure", state)
        )
        if (manifestEntries.length > 0) {
          const updated = appendManifestEntries(state, manifestEntries)
          saveState(pi, updated)
        }
      }

      working = working.filter((_, si) => !pressureDropIndices.has(si))
    }

    // ── 5. Pinned prepend ────────────────────────────────────────────────────
    // Separate pinned messages that are NOT already in the working window
    // (they're before the marker). Keep track of their original positions.
    const workingIndices = new Set(working.map(w => w.idx))
    const pinnedExtras: IndexedMsg[] = []
    for (let i = 0; i < messages.length; i++) {
      const id = idOf(i)
      if (id && pinnedIds.has(id) && !workingIndices.has(i)) {
        pinnedExtras.push({ idx: i, msg: messages[i]!, id })
      }
    }
    // Sort pinned extras chronologically (by original position)
    pinnedExtras.sort((a, b) => a.idx - b.idx)

    // Final message list: pinned extras + rest sorted by original order
    const rest = working
      .filter(w => !w.id || !pinnedIds.has(w.id) || workingIndices.has(w.idx))
      .sort((a, b) => a.idx - b.idx)

    // Pinned messages that were already in the working window stay in-place;
    // pinned messages from before the window are prepended
    let finalMessages = [
      ...pinnedExtras.map(w => w.msg),
      ...rest.map(w => w.msg),
    ]

    // ── 6. Tool pairing repair (safety net) ──────────────────────────────────
    // Runs after all filtering. Catches anything prevention missed (edge cases,
    // race conditions, aborted tool calls). Only active when ACM has modified
    // the message list — avoids false positives during mid-execution.
    const isActivelyFiltering =
      Object.values(state.pruned).some(Boolean) ||
      Object.keys(state.sniped).length > 0 ||
      state.summaryMarker !== null

    if (isActivelyFiltering) {
      const repairResult = repairToolPairing(finalMessages, isActivelyFiltering)
      finalMessages = repairResult.messages
    }

    return { messages: finalMessages }
  })
}
