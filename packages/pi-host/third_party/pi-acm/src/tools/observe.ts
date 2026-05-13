/**
 * tools/observe.ts — acm_map, acm_hunt, acm_diagnose
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { getState } from "../state.js"
import { estimateTokens, estimateSnipedTokens } from "../token-counter.js"

type BranchEntry = {
  type: string; id: string; parentId: string | null; timestamp: string
  message?: { role: string; content?: unknown; toolCallId?: string; toolName?: string; [k: string]: unknown }
  customType?: string; firstKeptEntryId?: string
}

// ── acm_map ──────────────────────────────────────────────────────────────────

export function registerObserveTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "acm_map",
    label: "ACM Map",
    description: `Show a per-message breakdown of the current context.
Returns a table with entry ID, role, age, token estimates (stored vs effective),
and ACM status flags (PIN/PRN/SNP/P:N). Also shows total tokens and % of context window.
Use this before deciding what to pin, prune, or snipe.`,
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const contextUsage = ctx.getContextUsage()
      const windowSize = contextUsage?.contextWindow ?? 0

      const rows: string[] = []
      let cumulative = 0
      let effectiveCumulative = 0

      const header = "ID       ROLE            AGE      TOKENS  EFFECTIVE  STATUS"
      const divider = "─".repeat(header.length)
      rows.push(header, divider)

      const now = Date.now()

      for (const entry of branch) {
        if (!["message", "compaction", "branch_summary", "custom_message"].includes(entry.type)) continue

        const msg = buildMsgForEntry(entry)
        if (!msg) continue

        const stored = estimateTokens(msg)
        const snipe = entry.type === "message" ? state.sniped[entry.id] : undefined
        const effective = snipe ? estimateSnipedTokens(msg, snipe) : stored

        cumulative += stored
        effectiveCumulative += effective

        const ageMs = now - new Date(entry.timestamp).getTime()
        const age = formatAge(ageMs)

        const status = buildStatus(entry.id, state)
        const role = formatRole(entry, msg).padEnd(14)

        rows.push(
          `${entry.id.slice(0, 8)}  ${role}  ${age.padStart(7)}  ${String(stored).padStart(6)}  ${String(effective).padStart(9)}  ${status}`
        )
      }

      rows.push(divider)

      const actualTokens = contextUsage?.tokens
      const totalLine = `TOTAL${" ".repeat(33)}${String(cumulative).padStart(6)}  ${String(effectiveCumulative).padStart(9)}`
      rows.push(totalLine)

      if (windowSize > 0) {
        const pct = Math.round((effectiveCumulative / windowSize) * 100)
        const actualPct = actualTokens ? Math.round((actualTokens / windowSize) * 100) : null
        rows.push(``)
        rows.push(`Context window: ${windowSize.toLocaleString()} tokens`)
        rows.push(`Estimated usage: ${effectiveCumulative.toLocaleString()} (${pct}%)`)
        if (actualPct !== null) {
          rows.push(`Actual usage (from API): ${actualTokens!.toLocaleString()} (${actualPct}%)`)
        }
      }

      const pinnedCount = Object.values(state.pinned).filter(Boolean).length
      const prunedCount = Object.values(state.pruned).filter(Boolean).length
      const snipedCount = Object.keys(state.sniped).length
      rows.push(``)
      rows.push(`Pinned: ${pinnedCount}  Pruned: ${prunedCount}  Sniped: ${snipedCount}`)
      if (state.summaryMarker) {
        rows.push(`Sliding window boundary: ${state.summaryMarker}`)
      }

      return { content: [{ type: "text", text: rows.join("\n") }], details: {} }
    },
  })

  // ── acm_hunt ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_hunt",
    label: "ACM Hunt",
    description: `Find the largest token consumers in the current session.
Returns top-N messages by token count, descending. Excludes already-pruned entries.
Use this to identify targets for acm_prune or acm_snipe.`,
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const limit = params.limit ?? 10

      type Row = { id: string; role: string; toolName?: string; tokens: number; preview: string }
      const rows: Row[] = []

      for (const entry of branch) {
        if (!["message", "compaction", "branch_summary", "custom_message"].includes(entry.type)) continue
        if (state.pruned[entry.id]) continue  // already pruned

        const msg = buildMsgForEntry(entry)
        if (!msg) continue

        const tokens = estimateTokens(msg)
        const preview = buildPreview(entry, msg)
        const toolName = entry.message?.toolName as string | undefined

        rows.push({ id: entry.id, role: formatRole(entry, msg), toolName, tokens, preview })
      }

      rows.sort((a, b) => b.tokens - a.tokens)
      const top = rows.slice(0, limit)

      if (top.length === 0) {
        return { content: [{ type: "text", text: "No messages found (all may be pruned)." }], details: {} }
      }

      const lines: string[] = [`Top ${top.length} token consumers:\n`]
      for (const row of top) {
        const status = state.sniped[row.id] ? " [SNP]" : state.pinned[row.id] ? " [PIN]" : ""
        lines.push(`${row.id.slice(0, 8)}  ${row.tokens.toString().padStart(6)} tokens  ${row.role}${row.toolName ? `(${row.toolName})` : ""}${status}`)
        lines.push(`  ${row.preview}`)
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} }
    },
  })

  // ── acm_diagnose ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "acm_diagnose",
    label: "ACM Diagnose",
    description: `Check session health. Detects incomplete tool calls (pending/running), aborted executions, and other structural issues.
Pass verbose:true to see full details per issue.`,
    parameters: Type.Object({
      verbose: Type.Optional(Type.Boolean({ description: "Show full details for each issue" })),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]

      type Issue = { type: string; severity: "error" | "warning"; entryId: string; description: string }
      const issues: Issue[] = []

      for (const entry of branch) {
        // Skip the current turn's own message
        if (entry.type !== "message") continue
        const msg = entry.message
        if (!msg) continue

        // Check tool result messages for indicators of incomplete execution
        // (pi stores toolResult messages with isError + error details)
        if (msg.role === "toolResult") {
          const details = (msg as any).details
          if (details?.status === "pending") {
            issues.push({ type: "incomplete_tool", severity: "error", entryId: entry.id, description: `Tool call never started: ${msg.toolName}` })
          } else if (details?.status === "running") {
            issues.push({ type: "incomplete_tool", severity: "error", entryId: entry.id, description: `Tool call never completed: ${msg.toolName}` })
          } else if ((msg as any).isError && (msg as any).content?.[0]?.text?.includes("aborted")) {
            issues.push({ type: "aborted_tool", severity: "warning", entryId: entry.id, description: `Tool execution aborted: ${msg.toolName}` })
          }
        }
      }

      if (issues.length === 0) {
        return {
          content: [{ type: "text", text: `Session is healthy. ${branch.filter(e => e.type === "message").length} messages scanned, no issues.` }],
          details: {},
        }
      }

      const errorCount = issues.filter(i => i.severity === "error").length
      const warnCount = issues.filter(i => i.severity === "warning").length
      const lines = [
        `Session diagnostic: ${errorCount} error(s), ${warnCount} warning(s)\n`,
        ...issues.map(issue => {
          const icon = issue.severity === "error" ? "❌" : "⚠️"
          let line = `${icon} [${issue.type}] ${issue.description}`
          if (params.verbose) line += `\n   Entry: ${issue.entryId}`
          return line
        }),
      ]

      return { content: [{ type: "text", text: lines.join("\n") }], details: { issues } }
    },
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMsgForEntry(entry: BranchEntry): { role: string; [k: string]: unknown } | null {
  if (entry.type === "message" && entry.message) return entry.message
  if (entry.type === "compaction") return { role: "compactionSummary", summary: "[compaction summary]" }
  if (entry.type === "branch_summary") return { role: "branchSummary", summary: "[branch summary]" }
  if (entry.type === "custom_message") return { role: "custom", content: entry.customType }
  return null
}

function formatRole(entry: BranchEntry, msg: { role: string; [k: string]: unknown }): string {
  if (msg.role === "toolResult") return `tool:${(msg.toolName as string | undefined) ?? "?"}`
  if (msg.role === "compactionSummary") return "compaction"
  if (msg.role === "branchSummary") return "branch-summary"
  return msg.role
}

function buildStatus(id: string, state: { pinned: Record<string, boolean>; pruned: Record<string, boolean>; sniped: Record<string, unknown>; priority: Record<string, number> }): string {
  const parts: string[] = []
  if (state.pinned[id]) parts.push("PIN")
  if (state.pruned[id]) parts.push("PRN")
  if (state.sniped[id]) parts.push("SNP")
  const p = state.priority[id]
  if (p !== undefined) parts.push(`P:${p}`)
  return parts.join(" ") || "—"
}

function buildPreview(entry: BranchEntry, msg: { role: string; [k: string]: unknown }): string {
  try {
    if (Array.isArray(msg.content)) {
      const text = (msg.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === "text" && b.text)
        .map(b => b.text!)
        .join(" ")
      return text.slice(0, 120).replace(/\n/g, " ")
    }
    if (typeof msg.content === "string") return msg.content.slice(0, 120)
    if (typeof (msg as any).output === "string") return (msg as any).output.slice(0, 120)
    return JSON.stringify(msg).slice(0, 120)
  } catch {
    return "(unable to preview)"
  }
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}
