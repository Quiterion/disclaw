/**
 * ui/status.ts
 *
 * Registers the turn_end handler that updates the pi footer status widget.
 * Shows: ACM: 187k/200k (93%) | pinned:3 pruned:12
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState } from "../state.js"
import { getActualTokens } from "../token-counter.js"


export function registerStatusWidget(pi: ExtensionAPI): void {
  pi.on("turn_end", async (_event, ctx) => {
    updateStatus(ctx)
  })

  // Also update on session_start in case we're resuming a session
  pi.on("session_start", async (_event, ctx) => {
    // Short delay to let state load first
    setTimeout(() => updateStatus(ctx), 100)
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function updateStatus(ctx: any): void {
  const state = getState()
  const usage = ctx.getContextUsage()
  const actualTokens = getActualTokens(ctx as any)

  const tokens = actualTokens ?? usage?.tokens ?? 0
  const contextWindow = usage?.contextWindow ?? 0
  const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0

  const pinnedCount = Object.values(state.pinned).filter(Boolean).length
  const prunedCount = Object.values(state.pruned).filter(Boolean).length

  const tokenStr = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
  const windowStr = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}k` : String(contextWindow)

  const status = contextWindow > 0
    ? `ACM: ${tokenStr}/${windowStr} (${pct}%) | ↑${pinnedCount} ✂${prunedCount}`
    : `ACM: ${tokenStr} tokens | ↑${pinnedCount} ✂${prunedCount}`

  ctx.ui.setStatus("acm", status)

  // Orphan repairs are self-healing and non-critical.
  // Stats are available via /acm-diagnose — no need to interrupt user flow.
}
