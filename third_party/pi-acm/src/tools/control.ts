/**
 * tools/control.ts — acm_pin, acm_unpin, acm_prune, acm_mark
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { StringEnum } from "@mariozechner/pi-ai"
import { getState, saveState, appendManifestEntries } from "../state.js"
import { resolveId } from "../id-resolver.js"
import { buildPairIndex, getPartnerIndices } from "../tool-pairing.js"
import { generateManifestEntry } from "../manifest.js"

type BranchEntry = { type: string; id: string; timestamp: string; message?: { role: string; [k: string]: unknown } }

export function registerControlTools(pi: ExtensionAPI): void {

  // ── acm_pin ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_pin",
    label: "ACM Pin",
    description: `Mark a message as inception — it will survive all compactions and always appear at the front of the context window.
Supports partial ID prefix (first 4+ chars). Errors if the prefix is ambiguous.`,
    parameters: Type.Object({
      id: Type.String({ description: "Entry ID or unique prefix" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(params.id, branch)
      if (!resolved.ok) return errorResult(resolved.error)

      const state = getState()
      const entry = branch.find(e => e.id === resolved.id)!
      const updated = {
        ...state,
        pinned: { ...state.pinned, [resolved.id]: true },
      }
      saveState(pi, updated)

      const role = entry.message?.role ?? "unknown"
      return {
        content: [t(`Pinned ${resolved.id} (${role}). This message will survive all compactions and prepend context.`)],
        details: { id: resolved.id },
      }
    },
  })

  // ── acm_unpin ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_unpin",
    label: "ACM Unpin",
    description: `Remove inception mark from a message. The message will no longer be preserved across compactions.`,
    parameters: Type.Object({
      id: Type.String({ description: "Entry ID or unique prefix" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(params.id, branch)
      if (!resolved.ok) return errorResult(resolved.error)

      const state = getState()
      if (!state.pinned[resolved.id]) {
        return {
          content: [t(`Entry ${resolved.id} was not pinned. No change.`)],
          details: {},
        }
      }

      const pinned = { ...state.pinned }
      delete pinned[resolved.id]
      saveState(pi, { ...state, pinned })

      return {
        content: [t(`Unpinned ${resolved.id}. It will no longer be preserved across compactions.`)],
        details: { id: resolved.id },
      }
    },
  })

  // ── acm_prune ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_prune",
    label: "ACM Prune",
    description: `Mark one or more messages to be excluded from all future LLM context. Messages are never deleted from the session file.
Pinned messages cannot be pruned (unpin first). Accepts a single ID or an array.`,
    parameters: Type.Object({
      id: Type.Union([
        Type.String({ description: "Single entry ID or prefix" }),
        Type.Array(Type.String(), { description: "Array of entry IDs or prefixes" }),
      ]),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const ids = Array.isArray(params.id) ? params.id : [params.id]

      const state = getState()
      const pruned = { ...state.pruned }
      const results: string[] = []
      const pairedResults: string[] = []
      const errors: string[] = []

      // Build message list from branch for pair index
      const msgEntries = branch.filter(e => e.type === "message" && e.message)
      const msgList = msgEntries.map(e => e.message as { role: string; toolCallId?: string; content?: any; [k: string]: unknown })
      const pairIndex = buildPairIndex(msgList)
      const pinnedIds = new Set(Object.keys(state.pinned).filter(id => state.pinned[id]))

      for (const rawId of ids) {
        const resolved = resolveId(rawId, branch)
        if (!resolved.ok) {
          errors.push(resolved.error)
          continue
        }
        if (state.pinned[resolved.id]) {
          errors.push(`Cannot prune ${resolved.id}: it is pinned. Use acm_unpin first.`)
          continue
        }
        pruned[resolved.id] = true
        results.push(resolved.id)

        // Auto-prune tool pair partners
        const entryIdx = msgEntries.findIndex(e => e.id === resolved.id)
        if (entryIdx >= 0) {
          const partnerMsgIndices = getPartnerIndices(entryIdx, pairIndex)
          for (const pi of partnerMsgIndices) {
            const partnerEntry = msgEntries[pi]
            if (partnerEntry && !pinnedIds.has(partnerEntry.id) && !pruned[partnerEntry.id]) {
              pruned[partnerEntry.id] = true
              pairedResults.push(partnerEntry.id)
            }
          }
        }
      }

      if (results.length > 0 || pairedResults.length > 0) {
        // Generate manifest entries for all pruned messages
        const allPrunedIds = [...results, ...pairedResults]
        const manifestEntries = allPrunedIds
          .map(id => branch.find(e => e.id === id))
          .filter((e): e is BranchEntry => e !== undefined && e.type === "message")
          .map(e => generateManifestEntry(e as any, "prune", state))

        const updated = appendManifestEntries({ ...state, pruned }, manifestEntries)
        saveState(pi, updated)
      }

      const lines: string[] = []
      if (results.length > 0) lines.push(`Pruned ${results.length} message(s): ${results.join(", ")}`)
      if (pairedResults.length > 0) lines.push(`+ ${pairedResults.length} paired tool message(s) auto-pruned: ${pairedResults.join(", ")}`)
      if (errors.length > 0) lines.push(`Errors:\n${errors.map(e => `  • ${e}`).join("\n")}`)

      return {
        content: [t(lines.join("\n") || "No changes made.")],
        details: { pruned: results, pairedPruned: pairedResults, errors },
      }
    },
  })

  // ── acm_mark ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_mark",
    label: "ACM Mark",
    description: `Set a priority level (0-10) on a message. Controls pruning order during auto-compaction.
0 = prune immediately on next compact, 5 = normal (default), 10 = treat as pinned inception.
Priority 10 also adds the message to the pinned set.`,
    parameters: Type.Object({
      id: Type.String({ description: "Entry ID or unique prefix" }),
      priority: Type.Number({ description: "Priority level 0-10", minimum: 0, maximum: 10 }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(params.id, branch)
      if (!resolved.ok) return errorResult(resolved.error)

      const p = Math.round(Math.max(0, Math.min(10, params.priority)))
      const state = getState()

      const priority = { ...state.priority, [resolved.id]: p }
      const pinned = p === 10
        ? { ...state.pinned, [resolved.id]: true }
        : state.pinned

      saveState(pi, { ...state, priority, pinned })

      const note = p === 10 ? " (also added to pinned set)" : p === 0 ? " (will be pruned on next compact)" : ""
      return {
        content: [t(`Set priority ${p} on ${resolved.id}${note}`)],
        details: { id: resolved.id, priority: p },
      }
    },
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

function t(text: string) { return { type: "text" as const, text } }
function errorResult(message: string) {
  return { content: [t(`Error: ${message}`)], details: {} }
}
