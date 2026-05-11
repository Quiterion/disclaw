/**
 * manifest.ts
 *
 * Heuristic metadata extraction for pruned/slid messages.
 * Generates ManifestEntry breadcrumbs so the LLM knows what was dropped.
 * Snipe-aware: uses LLM-written replacement as preview when available.
 */

import type { ManifestEntry, AcmState } from "./state.js"
import { estimateTokens } from "./token-counter.js"

// ── Types (subset of pi session entry) ───────────────────────────────────────

type ContentBlock = { type: string; text?: string; [k: string]: unknown }
type BranchEntry = {
  type: string
  id: string
  timestamp: string
  message?: {
    role: string
    content?: ContentBlock[] | string
    toolName?: string
    toolCallId?: string
    output?: string
    [k: string]: unknown
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a ManifestEntry for a message being pruned/slid/pressure-dropped.
 * Checks snipe state for LLM-written replacements before falling back to heuristic.
 */
export function generateManifestEntry(
  entry: BranchEntry,
  reason: ManifestEntry["reason"],
  state: AcmState
): ManifestEntry {
  const msg = entry.message
  const role = normalizeRole(msg)
  const tool = extractTool(msg)
  const arg = extractArg(msg)
  const preview = extractPreview(entry, state)
  const tokens = msg ? estimateTokens(msg as { role: string }) : 0

  return {
    id: entry.id,
    shortId: entry.id.slice(0, 8),
    role,
    tool: tool ?? undefined,
    arg: arg ?? undefined,
    preview,
    tokens,
    prunedAt: Date.now(),
    reason,
  }
}

/**
 * Generate manifest entries for multiple entries at once.
 */
export function generateManifestEntries(
  entries: ReadonlyArray<BranchEntry>,
  reason: ManifestEntry["reason"],
  state: AcmState
): ManifestEntry[] {
  return entries
    .filter(e => e.type === "message" && e.message)
    .map(e => generateManifestEntry(e, reason, state))
}

// ── Role normalization ───────────────────────────────────────────────────────

function normalizeRole(msg: BranchEntry["message"]): string {
  if (!msg) return "unknown"
  if (msg.role === "toolResult") return "toolResult"
  if (msg.role === "assistant" && hasToolCalls(msg)) return "toolCall"
  return msg.role
}

function hasToolCalls(msg: NonNullable<BranchEntry["message"]>): boolean {
  if (!Array.isArray(msg.content)) return false
  return (msg.content as ContentBlock[]).some(b => b.type === "toolCall")
}

// ── Tool extraction ──────────────────────────────────────────────────────────

function extractTool(msg: BranchEntry["message"]): string | null {
  if (!msg) return null
  // toolResult messages have toolName directly
  if (msg.toolName) return msg.toolName as string
  // assistant messages with tool calls: get first tool name
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const toolCall = (msg.content as ContentBlock[]).find(b => b.type === "toolCall")
    if (toolCall && toolCall.name) return toolCall.name as string
  }
  return null
}

// ── Arg extraction ───────────────────────────────────────────────────────────

function extractArg(msg: BranchEntry["message"]): string | null {
  if (!msg) return null

  // toolResult: try to find the original call's argument from content
  // The arg is typically in the tool call, not the result. Use toolName as hint.
  if (msg.role === "toolResult") {
    // For common tools, extract from the result content (file paths often appear first)
    const text = getTextContent(msg)
    if (text) {
      // File path heuristic: first thing that looks like a path
      const pathMatch = text.match(/^(?:\/|\.\/|[a-zA-Z]:\\)[\w.\/\\-]+/)
      if (pathMatch) return truncate(pathMatch[0], 60)
    }
    return null
  }

  // assistant with tool calls: get first arg
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const toolCall = (msg.content as ContentBlock[]).find(b => b.type === "toolCall")
    if (toolCall) {
      const args = (toolCall as any).args ?? (toolCall as any).input
      if (args && typeof args === "object") {
        // Common patterns: path, file_path, command, query
        const firstArg = args.path ?? args.file_path ?? args.command ?? args.query
        if (typeof firstArg === "string") return truncate(firstArg, 60)
        // Fallback: first string value
        for (const v of Object.values(args)) {
          if (typeof v === "string" && v.length > 0) return truncate(v, 60)
        }
      }
    }
  }

  return null
}

// ── Preview extraction (snipe-aware) ─────────────────────────────────────────

function extractPreview(entry: BranchEntry, state: AcmState): string {
  const snipe = state.sniped[entry.id]

  // Snipe-aware: use LLM-written replacement if available
  if (snipe) {
    if (snipe.strategy === "replace" && snipe.replacement) {
      return truncate(snipe.replacement, 120)
    }
    if (snipe.strategy === "remove") {
      const tool = extractTool(entry.message)
      const arg = extractArg(entry.message)
      const desc = [tool, arg].filter(Boolean).join(" ")
      return desc ? `[${desc} — content was removed]` : "[content was removed]"
    }
    // truncate/head_tail: fall through to heuristic (original content still useful)
  }

  // Heuristic: first non-empty line of text content
  const msg = entry.message
  if (!msg) return "(no content)"

  const text = getTextContent(msg)
  if (!text) return "(no text content)"

  const firstLine = text.split("\n").find(line => line.trim().length > 0)
  return truncate(firstLine?.trim() ?? "(empty)", 60)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTextContent(msg: NonNullable<BranchEntry["message"]>): string | null {
  // BashExecution output
  if (typeof msg.output === "string") return msg.output

  // Array content: join text blocks
  if (Array.isArray(msg.content)) {
    const texts = (msg.content as ContentBlock[])
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text!)
    if (texts.length > 0) return texts.join("\n")
  }

  // String content
  if (typeof msg.content === "string") return msg.content

  return null
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + "..."
}
