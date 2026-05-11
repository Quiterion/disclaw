/**
 * token-counter.ts
 *
 * Token estimation using gpt-tokenizer (cl100k_base).
 * These are approximations — real Anthropic token counts may differ by 5-15%.
 * Where available, actual counts from AssistantMessage.usage are preferred.
 */

import { encode } from "gpt-tokenizer/encoding/cl100k_base"
import type { ExtensionContext } from "@mariozechner/pi-coding-agent"

type AgentMessage = { role: string; [key: string]: unknown }
type AcmState = { sniped: Record<string, { strategy: string; maxChars?: number; replacement?: string }> }

/**
 * Estimate the token count for a single AgentMessage.
 * Serialises to JSON and counts BPE tokens with cl100k_base.
 */
export function estimateTokens(message: AgentMessage): number {
  try {
    const text = JSON.stringify(message)
    return encode(text).length
  } catch {
    // Fallback: rough character-based estimate (1 token ≈ 4 chars)
    return Math.ceil(JSON.stringify(message).length / 4)
  }
}

/**
 * Estimate tokens after a snipe has been applied in-memory.
 * Used by acm_map to show effective vs. stored counts.
 */
export function estimateSnipedTokens(
  message: AgentMessage,
  snipe: { strategy: string; maxChars?: number; replacement?: string }
): number {
  const maxChars = snipe.maxChars ?? 200
  switch (snipe.strategy) {
    case "truncate":
    case "head_tail":
      // Conservative: maxChars + marker (~20 chars)
      return Math.ceil((maxChars + 40) / 4)
    case "remove":
      return Math.ceil(40 / 4)  // Just the marker text
    case "replace":
      return snipe.replacement ? Math.ceil(snipe.replacement.length / 4) : 10
    default:
      return estimateTokens(message)
  }
}

/**
 * Get the actual token count from the most recent assistant message that
 * includes usage data from the API. Returns null if no such message exists.
 */
export function getActualTokens(ctx: ExtensionContext): number | null {
  const entries = ctx.sessionManager.getEntries() as Array<{
    type: string
    message?: {
      role: string
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
    }
  }>

  // Walk backwards to find the latest assistant message with usage
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const usage = entry.message.usage
      if (usage && (usage.input !== undefined || usage.totalTokens !== undefined)) {
        // Return total if available, else input (totalTokens includes cache)
        return usage.totalTokens ?? (
          (usage.input ?? 0) +
          (usage.output ?? 0) +
          (usage.cacheRead ?? 0) +
          (usage.cacheWrite ?? 0)
        )
      }
    }
  }
  return null
}

/**
 * Sum estimated token counts for a list of messages.
 * If actual usage data is available from ctx, uses that as the total instead
 * of estimating (estimates tend to undercount for large tool outputs).
 */
export function getEffectiveTokens(
  messages: ReadonlyArray<AgentMessage>,
  _acmState: AcmState,
  actualTokens: number | null
): number {
  const estimate = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0)
  // When actual data is available it's more reliable; use it as a ceiling hint
  return actualTokens !== null ? Math.max(estimate, actualTokens) : estimate
}
