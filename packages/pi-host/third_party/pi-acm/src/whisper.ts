/**
 * whisper.ts — disclaw-patched.
 *
 * Original pi-acm injected a `<context-status>` tag (with token counts,
 * percentage, etc.) as a hidden custom message before each agent run.
 * For disclaw's indefinite-rolling-session use case that's wrong:
 * the steady-state context-fill percentage parks near the auto-compact
 * threshold and stays there forever, so reporting it on every run is a
 * constant-value gauge — at best useless, at worst ambient pressure
 * framing every moment as "approaching a limit" when in fact the
 * steady state is sustainable indefinitely.
 *
 * Disclaw patch (relative to upstream pi-acm 0.3.9): the
 * `<context-status>` tag is gone. The `<pruned-manifest>` (episodic —
 * only present when content has actually been pruned) and the
 * system-prompt addition explaining ACM tools are kept. Agent queries
 * usage on demand via `acm_map` or pi's get_state.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState } from "./state.js"
import type { ManifestEntry } from "./state.js"

export function registerWhisperHandler(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, _ctx) => {
    const state = getState()
    const manifestBlock = renderManifest(state.prunedManifest)

    const systemPromptAddition =
      `\nACM (Active Context Management) is active. A <pruned-manifest> is injected ` +
      `before each agent run when content has been pruned. ` +
      `Use acm_map to inspect context, acm_pin to preserve critical messages, ` +
      `acm_prune/acm_snipe to reduce token usage, acm_compact to slide the window. ` +
      `Scan <pruned-manifest> for topics relevant to the current task — use acm_recall ` +
      `to recover pruned content when needed.`

    // No content message when there's nothing pruned (cache stays warm).
    // Custom message only fires when there's actually a manifest to show.
    const result: any = {
      systemPrompt: (_event as any).systemPrompt
        ? (_event as any).systemPrompt + systemPromptAddition
        : systemPromptAddition,
    }
    if (manifestBlock) {
      result.message = {
        customType: "acm-status",
        content: manifestBlock,
        display: false,
      }
    }
    return result
  })
}

// ── Manifest rendering ───────────────────────────────────────────────────────

function renderManifest(manifest: ManifestEntry[]): string | null {
  if (manifest.length === 0) return null

  // Sort by prunedAt descending (most recent drops first)
  const sorted = [...manifest].sort((a, b) => b.prunedAt - a.prunedAt)

  const now = Date.now()
  const lines = sorted.map(e => {
    const age = formatAge(now - e.prunedAt)
    const toolPart = e.tool ? ` ${e.tool}` : ""
    const argPart = e.arg ? ` "${e.arg}"` : ""
    return `  [${e.shortId}]${e.role}${toolPart}${argPart} — \"${e.preview}\" (${age}, ${e.tokens}tok)`
  })

  return `<pruned-manifest count="${manifest.length}">\n${lines.join("\n")}\n</pruned-manifest>`
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
