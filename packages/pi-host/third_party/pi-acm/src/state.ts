import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// ── Types ────────────────────────────────────────────────────────────────────

export type SnipeStrategy = "truncate" | "head_tail" | "remove" | "replace"
export type SnipeTarget = "content" | "thinking" | "images"

export interface SnipeConfig {
  strategy: SnipeStrategy
  maxChars?: number       // for truncate / head_tail
  replacement?: string    // for replace strategy
  target?: SnipeTarget    // defaults to "content"
}

export interface ChessClock {
  activeMinutes: number
  lastTurnStart: number | null
  gapThresholdSeconds: number
}

export interface ManifestEntry {
  id: string           // entry ID (full)
  shortId: string      // first 8 chars for display
  role: string         // "user" | "assistant" | "toolResult" | "toolCall"
  tool?: string        // tool name if tool message
  arg?: string         // first significant arg (file path, command, etc.)
  preview: string      // snipe-aware or heuristic preview
  tokens: number       // estimated token count at prune time
  prunedAt: number     // Date.now() when pruned
  reason: "prune" | "slide" | "pressure"  // why it was dropped
}

export const MANIFEST_CAP = 100

export interface AcmConfig {
  autoCompactOnPercent: number  // trigger pressure pruning at this % (default 85)
  keepActiveMinutes: number     // default window size for acm_compact
}

export interface AcmState {
  pinned:       Record<string, boolean>      // entryId → true
  pruned:       Record<string, boolean>      // entryId → true
  sniped:       Record<string, SnipeConfig>  // entryId → snipe config
  priority:     Record<string, number>       // entryId → 0-10
  chessClock:   ChessClock
  summaryMarker: string | null               // sliding window boundary entry ID
  config:       AcmConfig
  prunedManifest: ManifestEntry[]            // breadcrumbs for pruned/slid entries
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export function defaultState(): AcmState {
  return {
    pinned:       {},
    pruned:       {},
    sniped:       {},
    priority:     {},
    chessClock: {
      activeMinutes:      0,
      lastTurnStart:      null,
      gapThresholdSeconds: 60,
    },
    summaryMarker: null,
    config: {
      autoCompactOnPercent: 85,
      keepActiveMinutes:    30,
    },
    prunedManifest: [],
  }
}

/**
 * Append manifest entries with FIFO eviction at MANIFEST_CAP.
 */
export function appendManifestEntries(state: AcmState, entries: ManifestEntry[]): AcmState {
  const manifest = [...state.prunedManifest, ...entries]
  const overflow = manifest.length - MANIFEST_CAP
  return {
    ...state,
    prunedManifest: overflow > 0 ? manifest.slice(overflow) : manifest,
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _state: AcmState = defaultState()

export function getState(): AcmState {
  return _state
}

export function setState(s: AcmState): void {
  _state = s
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Replay all customType:"acm" entries from the session in order.
 * Last-write-wins per top-level key — later entries overwrite earlier ones.
 */
export function loadState(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): AcmState {
  let state = defaultState()
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "acm" && entry.data && typeof entry.data === "object") {
      const patch = entry.data as Partial<AcmState>
      state = { ...state, ...patch }
    }
  }
  return state
}

/**
 * Persist current state as a new sidecar entry.
 * Each call appends; state is rebuilt by replaying on next load.
 */
export function saveState(pi: ExtensionAPI, state: AcmState): void {
  pi.appendEntry("acm", state as unknown as Record<string, unknown>)
  _state = state
}

// ── session_start handler ─────────────────────────────────────────────────────

export function registerStateHandlers(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries()
    _state = loadState(entries as Array<{ type: string; customType?: string; data?: unknown }>)
  })
}
