/**
 * snipe-apply.ts
 *
 * Apply snipe configs to messages in the context event deep copy.
 * Never modifies the session JSONL — only the in-memory deep copy.
 */

import type { SnipeConfig } from "./state.js"

type ContentBlock = { type: string; text?: string; [k: string]: unknown }
type AgentMessage = { role: string; content?: ContentBlock[] | string; output?: string; [k: string]: unknown }

/**
 * Mutate `msg` (a deep copy) according to the snipe config.
 * Safe to call — the original session entry is untouched.
 */
export function applySnipe(msg: AgentMessage, snipe: SnipeConfig): void {
  const target = snipe.target ?? "content"

  switch (target) {
    case "thinking":
      applyThinkingSnipe(msg, snipe)
      break
    case "images":
      applyImageSnipe(msg, snipe)
      break
    case "content":
    default:
      applyContentSnipe(msg, snipe)
      break
  }
}

// ── Content snipe (tool results, bash output, user/assistant text) ────────────

function applyContentSnipe(msg: AgentMessage, snipe: SnipeConfig): void {
  const maxChars = snipe.maxChars ?? 200
  const role = msg.role

  // BashExecutionMessage: truncate the output string
  if (role === "bashExecution" && typeof (msg as any).output === "string") {
    const orig = (msg as any).output as string
    ;(msg as any).output = applyStrategy(orig, snipe, msg)
    return
  }

  // ToolResultMessage or UserMessage or AssistantMessage: operate on content array
  if (Array.isArray(msg.content)) {
    msg.content = msg.content.map(block => {
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: applyStrategy(block.text, snipe, msg) }
      }
      return block
    })
    return
  }

  // String content
  if (typeof msg.content === "string") {
    msg.content = applyStrategy(msg.content, snipe, msg)
  }
}

// ── Thinking snipe (removes ThinkingContent blocks from AssistantMessage) ─────

function applyThinkingSnipe(msg: AgentMessage, _snipe: SnipeConfig): void {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return
  msg.content = msg.content.filter(block => block.type !== "thinking")
}

// ── Image snipe (removes ImageContent blocks from UserMessage) ────────────────

function applyImageSnipe(msg: AgentMessage, _snipe: SnipeConfig): void {
  if (!Array.isArray(msg.content)) return
  msg.content = msg.content.filter(block => block.type !== "image")
}

// ── Strategy dispatch ─────────────────────────────────────────────────────────

function applyStrategy(text: string, snipe: SnipeConfig, msg: AgentMessage): string {
  const maxChars = snipe.maxChars ?? 200
  const originalLen = text.length

  switch (snipe.strategy) {
    case "truncate": {
      if (text.length <= maxChars) return text
      return text.slice(0, maxChars) + `\n[ACM: truncated from ${fmtSize(originalLen)} chars]`
    }
    case "head_tail": {
      if (text.length <= maxChars) return text
      const half = Math.floor(maxChars / 2)
      const head = text.slice(0, half)
      const tail = text.slice(-half)
      const removed = originalLen - maxChars
      return head + `\n[... ${fmtSize(removed)} chars removed by ACM ...]\n` + tail
    }
    case "remove": {
      const role = msg.role
      const toolName = (msg as any).toolName ? `/${(msg as any).toolName}` : ""
      return `[ACM: ${fmtSize(originalLen)} chars removed from ${role}${toolName}]`
    }
    case "replace": {
      return snipe.replacement ?? `[ACM: content replaced]`
    }
    default:
      return text
  }
}

function fmtSize(chars: number): string {
  if (chars >= 1000) return `${Math.round(chars / 1000)}k`
  return String(chars)
}
