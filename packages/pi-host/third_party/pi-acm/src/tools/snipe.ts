/**
 * tools/snipe.ts — acm_snipe
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { StringEnum } from "@mariozechner/pi-ai"
import { getState, saveState } from "../state.js"
import type { SnipeConfig, SnipeStrategy, SnipeTarget } from "../state.js"
import { resolveId } from "../id-resolver.js"

export function registerSnipeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "acm_snipe",
    label: "ACM Snipe",
    description: `Surgically reduce a message's token footprint without removing it from context.
Unlike acm_prune (removes the whole message), snipe replaces expensive content with a compact version.
The message shell stays intact, preserving conversation structure and tool call/result pairings.

Strategies:
  truncate  — keep first max_chars characters + truncation marker (default)
  head_tail — keep first + last max_chars/2 characters (good for logs with errors at end)
  remove    — replace entire content with "[ACM: removed]" marker
  replace   — substitute with your provided replacement text (most powerful)

Targets:
  content   — main text content (tool results, bash output, user/assistant text) [default]
  thinking  — remove ThinkingContent blocks from assistant messages
  images    — remove ImageContent blocks from user messages

WARNING: toolCall blocks in assistant messages cannot be sniped (would orphan tool results).

Tip for "replace" strategy: read the message content first, write a brief summary, then snipe with that summary as the replacement.`,

    parameters: Type.Object({
      id: Type.String({ description: "Entry ID or unique prefix of message to snipe" }),
      strategy: StringEnum(["truncate", "head_tail", "remove", "replace"] as const),
      max_chars: Type.Optional(Type.Number({
        description: "Characters to keep for truncate/head_tail strategies (default 200)",
        minimum: 50,
      })),
      replacement: Type.Optional(Type.String({
        description: "Replacement text — required when strategy is 'replace'",
      })),
      target: Type.Optional(StringEnum(["content", "thinking", "images"] as const)),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch() as Array<{ type: string; id: string; message?: { role: string; content?: unknown } }>
      const resolved = resolveId(params.id, branch)
      if (!resolved.ok) return errorResult(resolved.error)

      const entry = branch.find(e => e.id === resolved.id)
      if (!entry || entry.type !== "message") {
        return errorResult(`Entry ${resolved.id} is not a message entry (type: ${entry?.type ?? "not found"})`)
      }

      // Guard: cannot snipe toolCall blocks
      const target = (params.target as SnipeTarget | undefined) ?? "content"
      if (target === "content" && entry.message?.role === "assistant") {
        const content = entry.message.content
        if (Array.isArray(content)) {
          const hasToolCalls = content.some((b: any) => b.type === "toolCall")
          if (hasToolCalls) {
            // Only block if the message has NO text blocks — then we'd have to
            // remove toolCall blocks which would orphan their results
            const hasTextBlocks = content.some((b: any) => b.type === "text")
            if (!hasTextBlocks) {
              return errorResult(
                `Cannot snipe assistant message ${resolved.id}: it contains only toolCall blocks. ` +
                `Sniping toolCall blocks would orphan the corresponding tool results. ` +
                `Use target:"thinking" to remove thinking blocks, or acm_prune to remove the whole message.`
              )
            }
          }
        }
      }

      // Validate replace strategy has replacement text
      if (params.strategy === "replace" && !params.replacement) {
        return errorResult(`Strategy "replace" requires a "replacement" string.`)
      }

      const config: SnipeConfig = {
        strategy: params.strategy as SnipeStrategy,
        maxChars: params.max_chars ?? 200,
        replacement: params.replacement,
        target,
      }

      const state = getState()
      saveState(pi, {
        ...state,
        sniped: { ...state.sniped, [resolved.id]: config },
      })

      return {
        content: [{ type: "text" as const, text: `Sniped ${resolved.id} with strategy "${config.strategy}"${target !== "content" ? ` (target: ${target})` : ""}. Content will be replaced on the next LLM turn. Original remains in the session file.` }],
        details: { id: resolved.id, config },
      }
    },
  })
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: {} }
}
