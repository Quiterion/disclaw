/**
 * tools/compact.ts — acm_compact
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { getState, saveState, appendManifestEntries } from "../state.js"
import { calculateWindowBoundary } from "../compaction.js"
import { estimateTokens } from "../token-counter.js"
import { generateManifestEntries } from "../manifest.js"

type BranchEntry = {
  type: string; id: string; parentId: string | null; timestamp: string
  message?: { role: string; [k: string]: unknown }
  firstKeptEntryId?: string
}

export function registerCompactTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "acm_compact",
    label: "ACM Compact",
    description: `Apply the sliding window — move the context boundary forward, dropping old messages.
Pinned (inception) messages always survive. Non-pinned messages before the boundary are hidden from context.

Parameters:
  keep_active_minutes — keep messages from the last N active minutes (overrides default config)
  keep_messages       — alternatively, keep the last N messages (count-based)
  gap_threshold       — seconds before an idle gap is excluded from active time (default 60)
  dry_run             — preview without committing (default false)

Use dry_run:true first to see what would be dropped before committing.`,

    parameters: Type.Object({
      keep_active_minutes: Type.Optional(Type.Number({
        description: "Keep messages from last N active minutes",
        minimum: 1,
      })),
      keep_messages: Type.Optional(Type.Number({
        description: "Keep the last N messages (count-based, alternative to time-based)",
        minimum: 1,
      })),
      gap_threshold: Type.Optional(Type.Number({
        description: "Seconds before an idle gap is not counted (default 60)",
        minimum: 0,
      })),
      dry_run: Type.Optional(Type.Boolean({
        description: "Preview without committing (default false)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const isDryRun = params.dry_run ?? false

      // Temporarily override config for this call if params provided
      const effectiveState = {
        ...state,
        chessClock: params.gap_threshold !== undefined
          ? { ...state.chessClock, gapThresholdSeconds: params.gap_threshold }
          : state.chessClock,
        config: params.keep_active_minutes !== undefined
          ? { ...state.config, keepActiveMinutes: params.keep_active_minutes }
          : state.config,
      }

      let result: { newMarker: string; droppedCount: number; droppedEntries: ReadonlyArray<BranchEntry>; tokensSaved: number } | null = null

      if (params.keep_messages !== undefined) {
        // Count-based: keep last N message entries
        result = calculateCountBoundary(branch, effectiveState, params.keep_messages)
      } else {
        result = calculateWindowBoundary(branch, effectiveState)
      }

      if (!result) {
        const msgCount = branch.filter(e => e.type === "message").length
        return {
          content: [{ type: "text", text: `ACM Compact: No action needed. Session has ${msgCount} messages, all within the configured window.` }],
          details: {},
        }
      }

      const { newMarker, droppedCount, droppedEntries, tokensSaved } = result

      if (isDryRun) {
        return {
          content: [{
            type: "text",
            text: [
              `ACM Compact: Dry Run`,
              ``,
              `Would drop ${droppedCount} messages before marker ${newMarker}`,
              `Estimated token savings: ~${tokensSaved.toLocaleString()}`,
              `Pinned messages are preserved regardless.`,
              ``,
              `Run again without dry_run:true to commit.`,
            ].join("\n"),
          }],
          details: { dry_run: true, wouldDrop: droppedCount, tokensSaved, newMarker },
        }
      }

      // Commit: set summaryMarker, clean up redundant explicit prunes behind marker
      const msgEntries = branch.filter(e => e.type === "message")
      const markerIdx = msgEntries.findIndex(e => e.id === newMarker)
      const entriesBehindMarker = new Set(msgEntries.slice(0, markerIdx).map(e => e.id))

      // Remove explicit prune flags for entries now behind the marker (redundant)
      const pruned = { ...effectiveState.pruned }
      for (const id of entriesBehindMarker) {
        delete pruned[id]
      }

      // Generate manifest entries for dropped messages
      const manifestEntries = generateManifestEntries(droppedEntries, "slide", effectiveState)
      const withManifest = appendManifestEntries(
        { ...effectiveState, summaryMarker: newMarker, pruned },
        manifestEntries
      )
      saveState(pi, withManifest)

      return {
        content: [{
          type: "text",
          text: [
            `ACM Compact: Complete`,
            ``,
            `Slid window forward to marker ${newMarker}`,
            `Dropped ${droppedCount} messages from context (~${tokensSaved.toLocaleString()} tokens saved)`,
            `Pinned messages are preserved and will prepend context on each turn.`,
          ].join("\n"),
        }],
        details: { committed: true, droppedCount, tokensSaved, newMarker },
      }
    },
  })
}

// ── Count-based boundary ─────────────────────────────────────────────────────

function calculateCountBoundary(
  branch: ReadonlyArray<BranchEntry>,
  state: ReturnType<typeof getState>,
  keepMessages: number
): { newMarker: string; droppedCount: number; droppedEntries: ReadonlyArray<BranchEntry>; tokensSaved: number } | null {
  const pinnedIds = new Set(Object.keys(state.pinned).filter(id => state.pinned[id]))
  const msgEntries = branch.filter(e => e.type === "message" && e.message)

  if (msgEntries.length <= keepMessages) return null

  const markerIdx = msgEntries.length - keepMessages
  const targetEntry = msgEntries[markerIdx]
  if (!targetEntry) return null

  const toBeDrop = msgEntries.slice(0, markerIdx).filter(e => !pinnedIds.has(e.id))
  if (toBeDrop.length === 0) return null

  const tokensSaved = toBeDrop.reduce((sum, e) => {
    return sum + estimateTokens(e.message as { role: string })
  }, 0)

  return {
    newMarker: targetEntry.id,
    droppedCount: toBeDrop.length,
    droppedEntries: toBeDrop,
    tokensSaved,
  }
}
