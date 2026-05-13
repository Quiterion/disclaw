/**
 * tools/recall.ts — acm_recall
 *
 * Recover pruned/windowed content from the full session branch.
 * Three modes: list (overview), search (grep), fetch (by ID).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { getState } from "../state.js"
import { resolveId } from "../id-resolver.js"
import { estimateTokens } from "../token-counter.js"

type ContentBlock = { type: string; text?: string; [k: string]: unknown }
type BranchEntry = {
  type: string; id: string; timestamp: string
  message?: {
    role: string
    content?: ContentBlock[] | string
    toolName?: string
    toolCallId?: string
    output?: string
    [k: string]: unknown
  }
}

export function registerRecallTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "acm_recall",
    label: "ACM Recall",
    description: `Recover content from pruned or window-dropped messages.
Reads the full session branch from disk — pruned content is never lost.

Three modes:
  LIST   (no id, no grep) — overview of all hidden entries, matching optional filters
  SEARCH (grep provided)  — regex search across hidden message content
  FETCH  (id provided)    — return full content of specific entries

Combine filters (role, tool) with grep to narrow results. Check <pruned-manifest> for entry IDs and topics.`,

    parameters: Type.Object({
      id: Type.Optional(Type.Union([
        Type.String({ description: "Entry ID or prefix to fetch" }),
        Type.Array(Type.String(), { description: "Multiple entry IDs or prefixes" }),
      ])),
      grep: Type.Optional(Type.String({
        description: "Regex pattern to search across hidden content",
      })),
      role: Type.Optional(Type.String({
        description: "Filter by role: user, assistant, toolResult, toolCall",
      })),
      tool: Type.Optional(Type.String({
        description: "Filter by tool name (e.g., read, bash, edit)",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max entries to return (default 10)",
      })),
      max_tokens: Type.Optional(Type.Number({
        description: "Token budget for response (default 4000)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState()
      const branch = ctx.sessionManager.getBranch() as BranchEntry[]
      const maxTokens = params.max_tokens ?? 4000
      const limit = params.limit ?? 10

      // ── Find all hidden entries ──────────────────────────────────────────
      const hidden = findHiddenEntries(branch, state)

      if (hidden.length === 0) {
        return ok("No hidden entries. Nothing has been pruned or slid out of the window yet.")
      }

      // ── Apply structural filters ─────────────────────────────────────────
      let filtered = hidden
      if (params.role) {
        const r = params.role.toLowerCase()
        filtered = filtered.filter(e => normalizeRole(e).toLowerCase() === r)
      }
      if (params.tool) {
        const t = params.tool.toLowerCase()
        filtered = filtered.filter(e => {
          const toolName = e.message?.toolName ?? extractToolCallName(e)
          return toolName?.toLowerCase() === t
        })
      }

      // ── Dispatch to mode ─────────────────────────────────────────────────
      const ids = params.id
        ? (Array.isArray(params.id) ? params.id : [params.id])
        : null

      if (ids) {
        return fetchMode(ids, branch, maxTokens)
      }
      if (params.grep) {
        return searchMode(params.grep, filtered, limit, maxTokens)
      }
      return listMode(filtered, limit, maxTokens)
    },
  })
}

// ── List mode ────────────────────────────────────────────────────────────────

function listMode(
  entries: BranchEntry[],
  limit: number,
  maxTokens: number
): ToolResult {
  const lines: string[] = [`Hidden entries: ${entries.length}\n`]
  let tokenBudget = maxTokens
  let shown = 0

  for (const entry of entries) {
    if (shown >= limit) break
    const line = formatEntryLine(entry)
    const cost = Math.ceil(line.length / 4) // rough token estimate
    if (tokenBudget - cost < 0 && shown > 0) break
    lines.push(line)
    tokenBudget -= cost
    shown++
  }

  if (shown < entries.length) {
    lines.push(`\n(${entries.length - shown} more hidden. Narrow with role, tool, or grep filters.)`)
  }

  return ok(lines.join("\n"))
}

// ── Search mode ──────────────────────────────────────────────────────────────

function searchMode(
  pattern: string,
  entries: BranchEntry[],
  limit: number,
  maxTokens: number
): ToolResult {
  let re: RegExp
  try {
    re = new RegExp(pattern, "i")
  } catch {
    return ok(`Error: Invalid regex pattern "${pattern}"`)
  }

  const matches: { entry: BranchEntry; snippets: string[] }[] = []

  for (const entry of entries) {
    const text = getFullText(entry)
    if (!text) continue
    if (!re.test(text)) continue

    // Extract matching lines with 1 line of context
    const lines = text.split("\n")
    const snippets: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        const start = Math.max(0, i - 1)
        const end = Math.min(lines.length - 1, i + 1)
        for (let j = start; j <= end; j++) {
          const prefix = j === i ? "→ " : "  "
          snippets.push(prefix + lines[j]!)
        }
        if (end < lines.length - 1) snippets.push("  ...")
      }
    }
    matches.push({ entry, snippets: snippets.slice(0, 10) }) // cap snippets per entry
  }

  if (matches.length === 0) {
    return ok(`No matches for /${pattern}/ in ${entries.length} hidden entries.`)
  }

  const lines: string[] = [`Matches: ${matches.length} entries\n`]
  let tokenBudget = maxTokens
  let shown = 0

  for (const { entry, snippets } of matches) {
    if (shown >= limit) break
    const header = formatEntryLine(entry)
    const body = snippets.join("\n")
    const block = `${header}\n${body}\n`
    const cost = Math.ceil(block.length / 4)
    if (tokenBudget - cost < 0 && shown > 0) break
    lines.push(block)
    tokenBudget -= cost
    shown++
  }

  if (shown < matches.length) {
    lines.push(`(${matches.length - shown} more matches. Use id to fetch specific entries, or narrow filters.)`)
  }

  return ok(lines.join("\n"))
}

// ── Fetch mode ───────────────────────────────────────────────────────────────

function fetchMode(
  ids: string[],
  branch: BranchEntry[],
  maxTokens: number
): ToolResult {
  const lines: string[] = []
  let tokenBudget = maxTokens

  for (const rawId of ids) {
    const resolved = resolveId(rawId, branch)
    if (!resolved.ok) {
      lines.push(`[${rawId}] Error: ${resolved.error}`)
      continue
    }

    const entry = branch.find(e => e.id === resolved.id)
    if (!entry || !entry.message) {
      lines.push(`[${rawId}] Entry found but has no message content.`)
      continue
    }

    const header = formatEntryLine(entry)
    const text = getFullText(entry) ?? "(no text content)"
    const fullBlock = `${header}\n---\n${text}\n---\n`
    const cost = Math.ceil(fullBlock.length / 4)

    if (tokenBudget - cost < 0 && lines.length > 0) {
      // Over budget — truncate with head_tail
      const available = Math.max(200, tokenBudget * 4)
      const half = Math.floor(available / 2)
      const truncated = text.slice(0, half) +
        `\n\n[... ${text.length - available} chars truncated by acm_recall budget ...]\n\n` +
        text.slice(-half)
      lines.push(`${header}\n---\n${truncated}\n---\n`)
      lines.push(`(Token budget exhausted. Fetch fewer entries or increase max_tokens.)`)
      break
    }

    lines.push(fullBlock)
    tokenBudget -= cost
  }

  return ok(lines.join("\n"))
}

// ── Hidden entry resolution ──────────────────────────────────────────────────

interface AcmStateLike {
  pruned: Record<string, boolean>
  summaryMarker: string | null
  pinned: Record<string, boolean>
}

function findHiddenEntries(branch: BranchEntry[], state: AcmStateLike): BranchEntry[] {
  const pinnedIds = new Set(
    Object.keys(state.pinned).filter(id => state.pinned[id])
  )

  const hidden: BranchEntry[] = []
  let pastMarker = state.summaryMarker === null // true if no marker (nothing windowed)

  for (const entry of branch) {
    if (!pastMarker) {
      if (entry.id === state.summaryMarker) {
        pastMarker = true
        continue
      }
      // Before marker and not pinned = hidden by sliding window
      if (entry.type === "message" && entry.message && !pinnedIds.has(entry.id)) {
        hidden.push(entry)
      }
      continue
    }

    // Past marker: check if explicitly pruned
    if (entry.type === "message" && entry.message && state.pruned[entry.id] && !pinnedIds.has(entry.id)) {
      hidden.push(entry)
    }
  }

  return hidden
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeRole(entry: BranchEntry): string {
  const msg = entry.message
  if (!msg) return "unknown"
  if (msg.role === "toolResult") return "toolResult"
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    if ((msg.content as ContentBlock[]).some(b => b.type === "toolCall")) return "toolCall"
  }
  return msg.role
}

function extractToolCallName(entry: BranchEntry): string | null {
  const msg = entry.message
  if (!msg || !Array.isArray(msg.content)) return null
  const tc = (msg.content as ContentBlock[]).find(b => b.type === "toolCall")
  return (tc as any)?.name ?? null
}

function getFullText(entry: BranchEntry): string | null {
  const msg = entry.message
  if (!msg) return null

  if (typeof msg.output === "string") return msg.output

  if (Array.isArray(msg.content)) {
    const texts = (msg.content as ContentBlock[])
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text!)
    if (texts.length > 0) return texts.join("\n")
  }

  if (typeof msg.content === "string") return msg.content
  return null
}

function formatEntryLine(entry: BranchEntry): string {
  const msg = entry.message
  if (!msg) return `[${entry.id.slice(0, 8)}] (no message)`

  const role = normalizeRole(entry)
  const toolName = msg.toolName ?? extractToolCallName(entry)
  const toolPart = toolName ? ` ${toolName}` : ""

  const text = getFullText(entry)
  const preview = text
    ? text.split("\n").find(l => l.trim())?.trim().slice(0, 60) ?? "(empty)"
    : "(no text)"

  const tokens = estimateTokens(msg as { role: string })
  return `[${entry.id.slice(0, 8)}] ${role}${toolPart} — "${preview}" (${tokens}tok)`
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  details: Record<string, unknown>
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} }
}
