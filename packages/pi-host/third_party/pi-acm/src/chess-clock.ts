/**
 * chess-clock.ts
 *
 * Tracks active working time in a session — wall-clock time minus idle gaps.
 * Idle gaps above gapThresholdSeconds are excluded from the active count,
 * so overnight pauses don't inflate the session's "age".
 *
 * Used by acm_compact to calculate time-based window boundaries.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getState, saveState } from "./state.js"
import type { ChessClock } from "./state.js"

export function registerChessClock(pi: ExtensionAPI): void {
  // Record turn start timestamp
  pi.on("turn_start", async (_event, _ctx) => {
    const state = getState()
    const updated = {
      ...state,
      chessClock: {
        ...state.chessClock,
        lastTurnStart: Date.now(),
      },
    }
    // Don't persist on every turn_start — only persist meaningful state changes
    // (we persist on turn_end when we accumulate time)
    getState().chessClock.lastTurnStart = Date.now()
  })

  // Accumulate active time on turn end
  pi.on("turn_end", async (_event, ctx) => {
    const state = getState()
    const clock = state.chessClock
    if (clock.lastTurnStart === null) return

    const elapsedMs = Date.now() - clock.lastTurnStart
    const elapsedSeconds = elapsedMs / 1000

    // Only count this as active time if it's under the gap threshold
    const updatedClock: ChessClock = {
      ...clock,
      lastTurnStart: null,
      activeMinutes: elapsedSeconds <= clock.gapThresholdSeconds
        ? clock.activeMinutes + elapsedMs / 60_000
        : clock.activeMinutes,  // gap too large — don't count
    }

    saveState(pi, { ...state, chessClock: updatedClock })
  })
}

/**
 * Return the total active minutes elapsed since a given entry's timestamp.
 *
 * The entry's creation time is used as the "start" of the window.
 * All turn durations recorded AFTER that timestamp that were under the gap
 * threshold count toward the active time for that window.
 *
 * For simplicity in v1 we use the cumulative activeMinutes at the end of the
 * session minus an estimate of minutes before the entry. A future improvement
 * could track per-turn timestamps to get exact per-window minutes.
 *
 * @param entryTimestamp  ISO timestamp string from the session entry
 * @param clock           Current chess-clock state
 */
export function getActiveMinutesSince(entryTimestamp: string, clock: ChessClock): number {
  // v1 approximation: use the fraction of session time since the entry
  // relative to total elapsed wall time
  const entryMs = new Date(entryTimestamp).getTime()
  const nowMs = Date.now()
  const totalWallMs = nowMs - entryMs
  if (totalWallMs <= 0) return 0

  // If we have accumulated active minutes, scale proportionally
  // (later we can make this exact by storing per-turn timestamps)
  return clock.activeMinutes  // conservative: assume all active time was after this entry
}
