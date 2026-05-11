/**
 * ui/commands.ts
 *
 * User-facing slash commands mirroring the LLM tools.
 * All commands use the /acm- prefix for consistent namespacing.
 * /acm-map, /acm-pin, /acm-unpin, /acm-prune, /acm-mark, /acm-hunt, /acm-diagnose
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState, saveState } from "../state.js"
import { resolveId } from "../id-resolver.js"
import { estimateTokens } from "../token-counter.js"
import { buildPairIndex, getTurnStats } from "../tool-pairing.js"

type BranchEntry = {
  type: string; id: string; parentId: string | null; timestamp: string
  message?: { role: string; [k: string]: unknown }
}

export function registerCommands(pi: ExtensionAPI): void {

  // /acm-map — show context map
  pi.registerCommand("acm-map", {
    description: "Show ACM context map (token usage per message)",
    handler: async (_args, ctx) => {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const usage = ctx.getContextUsage()
      const windowSize = usage?.contextWindow ?? 0
      const lines: string[] = []

      lines.push("ACM Context Map")
      lines.push("═".repeat(60))
      lines.push("ID       ROLE            TOKENS  STATUS")
      lines.push("─".repeat(60))

      let total = 0
      for (const entry of branch) {
        if (!["message", "compaction", "branch_summary"].includes(entry.type)) continue
        const msg = entry.message ?? { role: entry.type }
        const tokens = estimateTokens(msg)
        total += tokens
        const status = buildStatus(entry.id, state)
        const role = (msg.role === "toolResult" ? `tool:${(msg as any).toolName ?? "?"}` : msg.role).slice(0, 14).padEnd(14)
        lines.push(`${entry.id.slice(0, 8)}  ${role}  ${String(tokens).padStart(6)}  ${status}`)
      }

      lines.push("─".repeat(60))
      const pct = windowSize > 0 ? ` (${Math.round((total / windowSize) * 100)}%)` : ""
      lines.push(`TOTAL: ${total.toLocaleString()} tokens${pct}${windowSize > 0 ? ` / ${windowSize.toLocaleString()}` : ""}`)

      const pinnedCount = Object.values(state.pinned).filter(Boolean).length
      const prunedCount = Object.values(state.pruned).filter(Boolean).length
      lines.push(`Pinned: ${pinnedCount}  Pruned: ${prunedCount}  Sniped: ${Object.keys(state.sniped).length}`)

      ctx.ui.notify(lines.join("\n"), "info")
    },
  })

  // /acm-pin <id>
  pi.registerCommand("acm-pin", {
    description: "Pin a message as inception (survives all compactions): /acm-pin <entry-id>",
    handler: async (args, ctx) => {
      const id = args?.trim()
      if (!id) { ctx.ui.notify("Usage: /acm-pin <entry-id>", "error"); return }

      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(id, branch)
      if (!resolved.ok) { ctx.ui.notify(`Error: ${resolved.error}`, "error"); return }

      const state = getState()
      saveState(pi, { ...state, pinned: { ...state.pinned, [resolved.id]: true } })
      ctx.ui.notify(`Pinned ${resolved.id}`)
    },
  })

  // /acm-unpin <id>
  pi.registerCommand("acm-unpin", {
    description: "Remove inception mark from a message: /acm-unpin <entry-id>",
    handler: async (args, ctx) => {
      const id = args?.trim()
      if (!id) { ctx.ui.notify("Usage: /acm-unpin <entry-id>", "error"); return }

      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(id, branch)
      if (!resolved.ok) { ctx.ui.notify(`Error: ${resolved.error}`, "error"); return }

      const state = getState()
      if (!state.pinned[resolved.id]) {
        ctx.ui.notify(`${resolved.id} was not pinned`, "info")
        return
      }
      const pinned = { ...state.pinned }
      delete pinned[resolved.id]
      saveState(pi, { ...state, pinned })
      ctx.ui.notify(`Unpinned ${resolved.id}`)
    },
  })

  // /acm-prune <id>
  pi.registerCommand("acm-prune", {
    description: "Mark a message for removal from LLM context: /acm-prune <entry-id>",
    handler: async (args, ctx) => {
      const id = args?.trim()
      if (!id) { ctx.ui.notify("Usage: /acm-prune <entry-id>", "error"); return }

      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(id, branch)
      if (!resolved.ok) { ctx.ui.notify(`Error: ${resolved.error}`, "error"); return }

      const state = getState()
      if (state.pinned[resolved.id]) {
        ctx.ui.notify(`Cannot prune ${resolved.id}: it is pinned. Use /acm-unpin first.`, "error")
        return
      }
      saveState(pi, { ...state, pruned: { ...state.pruned, [resolved.id]: true } })
      ctx.ui.notify(`Pruned ${resolved.id}`)
    },
  })

  // /acm-mark <id> <priority>
  pi.registerCommand("acm-mark", {
    description: "Set message priority (0-10): /acm-mark <entry-id> <priority>",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? []
      if (parts.length < 2) { ctx.ui.notify("Usage: /acm-mark <entry-id> <0-10>", "error"); return }

      const [rawId, rawP] = parts
      const p = parseInt(rawP!, 10)
      if (isNaN(p) || p < 0 || p > 10) { ctx.ui.notify("Priority must be 0-10", "error"); return }

      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const resolved = resolveId(rawId!, branch)
      if (!resolved.ok) { ctx.ui.notify(`Error: ${resolved.error}`, "error"); return }

      const state = getState()
      const pinned = p === 10 ? { ...state.pinned, [resolved.id]: true } : state.pinned
      saveState(pi, { ...state, priority: { ...state.priority, [resolved.id]: p }, pinned })
      ctx.ui.notify(`Marked ${resolved.id} with priority ${p}${p === 10 ? " (also pinned)" : ""}`)
    },
  })

  // /acm-hunt
  pi.registerCommand("acm-hunt", {
    description: "Show top token consumers: /acm-hunt [limit]",
    handler: async (args, ctx) => {
      const limit = parseInt(args?.trim() ?? "10", 10) || 10
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]

      const rows = branch
        .filter(e => e.type === "message" && e.message && !state.pruned[e.id])
        .map(e => ({ id: e.id, tokens: estimateTokens(e.message!), role: e.message!.role }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, limit)

      if (rows.length === 0) { ctx.ui.notify("No messages found.", "info"); return }

      const lines = [`Top ${rows.length} token consumers:`, ""]
      for (const r of rows) {
        lines.push(`${r.id.slice(0, 8)}  ${String(r.tokens).padStart(6)} tokens  ${r.role}`)
      }
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })

  // /acm-diagnose — full health check with pairing stats
  pi.registerCommand("acm-diagnose", {
    description: "Check session health: structural issues + tool pairing stats",
    handler: async (_args, ctx) => {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const msgEntries = branch.filter(e => e.type === "message" && e.message)
      const lines: string[] = []

      lines.push("ACM Session Health")
      lines.push("═".repeat(50))

      // Basic stats
      lines.push(`Messages: ${msgEntries.length}`)
      lines.push(`Pinned: ${Object.values(state.pinned).filter(Boolean).length}`)
      lines.push(`Pruned: ${Object.values(state.pruned).filter(Boolean).length}`)
      lines.push(`Sniped: ${Object.keys(state.sniped).length}`)
      lines.push(`Summary marker: ${state.summaryMarker ?? "none"}`)
      lines.push("")

      // Tool pairing health
      lines.push("Tool Pairing Health")
      lines.push("─".repeat(50))

      const msgList = msgEntries.map(e => e.message as { role: string; toolCallId?: string; content?: any; [k: string]: unknown })
      const pairIndex = buildPairIndex(msgList)

      let totalPairs = 0
      let completePairs = 0
      let pendingCalls = 0
      let orphanedResults = 0

      // Count pair status
      const validCallIds = new Set<string>()
      for (const [, pair] of pairIndex.byCallId) {
        totalPairs++
        validCallIds.add(pair.callId)
        if (pair.resultMsgIdx !== null) {
          completePairs++
        } else {
          pendingCalls++
        }
      }

      // Check for results with no call (shouldn't happen but check)
      for (const [, callId] of pairIndex.resultIdByMsgIdx) {
        if (!validCallIds.has(callId)) {
          orphanedResults++
        }
      }

      lines.push(`Total tool pairs: ${totalPairs}`)
      lines.push(`Complete (call + result): ${completePairs}`)
      lines.push(`Pending (call, no result yet): ${pendingCalls}`)
      lines.push(`Orphaned results (no matching call): ${orphanedResults}`)
      lines.push("")

      // Per-turn stats
      const turnStats = getTurnStats()
      lines.push("Last Turn Stats")
      lines.push("─".repeat(50))
      lines.push(`Pairs dropped by prevention: ${turnStats.pairsDroppedByPrevention}`)
      lines.push(`Orphans repaired by safety net: ${turnStats.orphansRepairedByNet}`)

      // Health verdict
      lines.push("")
      if (orphanedResults === 0 && turnStats.orphansRepairedByNet === 0) {
        lines.push("✅ Pairing health: GOOD")
      } else if (orphanedResults > 0) {
        lines.push("❌ Pairing health: ORPHANS DETECTED — repairs needed")
      } else {
        lines.push("⚠️ Pairing health: OK (safety net repaired orphans last turn)")
      }

      ctx.ui.notify(lines.join("\n"), "info")
    },
  })
}

function buildStatus(id: string, state: ReturnType<typeof getState>): string {
  const parts: string[] = []
  if (state.pinned[id]) parts.push("PIN")
  if (state.pruned[id]) parts.push("PRN")
  if (state.sniped[id]) parts.push("SNP")
  const p = state.priority[id]
  if (p !== undefined) parts.push(`P:${p}`)
  return parts.join(" ") || "—"
}
