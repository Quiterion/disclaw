import { describe, it, expect } from "vitest"
import { calculateWindowBoundary } from "../src/compaction.js"
import { defaultState } from "../src/state.js"
import type { AcmState } from "../src/state.js"

type BranchEntry = { type: string; id: string; parentId: string | null; timestamp: string; message?: { role: string; content?: any; toolCallId?: string; [k: string]: any } }

function makeEntry(id: string, minutesAgo: number): BranchEntry {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return { type: "message", id, parentId: null, timestamp: ts, message: { role: "user" } }
}

function makeAssistantEntry(id: string, minutesAgo: number, ...toolCallIds: string[]): BranchEntry {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const content: any[] = [{ type: "text", text: "running" }]
  for (const tcId of toolCallIds) {
    content.push({ type: "toolCall", id: tcId, name: "bash", arguments: {} })
  }
  return { type: "message", id, parentId: null, timestamp: ts, message: { role: "assistant", content } }
}

function makeToolResultEntry(id: string, minutesAgo: number, toolCallId: string): BranchEntry {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return { type: "message", id, parentId: null, timestamp: ts, message: { role: "toolResult", toolCallId, content: [{ type: "text", text: "output" }] } }
}

describe("calculateWindowBoundary", () => {
  it("returns null when session has fewer than 2 messages", () => {
    const state = defaultState()
    state.chessClock.activeMinutes = 60
    const result = calculateWindowBoundary([makeEntry("a1", 10)], state)
    expect(result).toBeNull()
  })

  it("returns null when all messages are within the window", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 60
    state.chessClock.activeMinutes = 5
    const branch = [makeEntry("a1", 5), makeEntry("b2", 3), makeEntry("c3", 1)]
    const result = calculateWindowBoundary(branch, state)
    // All messages are recent (within 60 min active); nothing to drop
    expect(result).toBeNull()
  })

  it("dry_run: calculateWindowBoundary does not mutate state", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 5
    state.chessClock.activeMinutes = 60
    const branch = [
      makeEntry("old1", 120),
      makeEntry("old2", 90),
      makeEntry("recent1", 2),
      makeEntry("recent2", 1),
    ]
    // Call once
    const stateBefore = JSON.stringify(state)
    calculateWindowBoundary(branch, state)
    // State must be unchanged (no mutation)
    expect(JSON.stringify(state)).toBe(stateBefore)
  })

  it("excludes pinned messages from droppedCount", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 5
    state.chessClock.activeMinutes = 60
    state.pinned["old1"] = true  // pinned — should not be counted as dropped
    const branch = [
      makeEntry("old1", 120),  // pinned
      makeEntry("old2", 90),   // will be dropped
      makeEntry("recent1", 2),
    ]
    const result = calculateWindowBoundary(branch, state)
    if (result) {
      expect(result.droppedCount).toBe(1)  // only old2, not old1
    }
  })
})

describe("calculateWindowBoundary: pair-aware snapping", () => {
  it("snaps boundary forward when it would split a tool call/result pair", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 5
    state.chessClock.activeMinutes = 60
    const branch = [
      makeEntry("old_user", 120),                          // old — would be dropped
      makeAssistantEntry("old_asst", 110, "call_1"),       // old — would be dropped, has toolCall
      makeToolResultEntry("recent_result", 2, "call_1"),   // recent — in window, but its call is old
      makeEntry("recent_user", 1),                         // recent
    ]
    const result = calculateWindowBoundary(branch, state)
    // Boundary should snap forward past the tool result to avoid orphan
    // The result at index 2 references call_1 from old_asst at index 1
    // So boundary snaps to index 3 (recent_user), dropping old_user, old_asst, AND recent_result
    if (result) {
      expect(result.newMarker).toBe("recent_user")
      expect(result.droppedCount).toBe(3) // old_user + old_asst + recent_result
    }
  })

  it("does not snap when pairs are already intact within the window", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 5
    state.chessClock.activeMinutes = 60
    const branch = [
      makeEntry("old_user", 120),                         // old — dropped
      makeAssistantEntry("recent_asst", 3, "call_1"),     // recent — kept
      makeToolResultEntry("recent_result", 2, "call_1"),  // recent — kept, pair intact
      makeEntry("recent_user", 1),                        // recent
    ]
    const result = calculateWindowBoundary(branch, state)
    if (result) {
      // Boundary is at recent_asst — pair is intact (both call and result in window)
      expect(result.newMarker).toBe("recent_asst")
      expect(result.droppedCount).toBe(1) // only old_user
    }
  })

  it("handles parallel tool calls — snaps past all orphaned results", () => {
    const state = defaultState()
    state.config.keepActiveMinutes = 5
    state.chessClock.activeMinutes = 60
    const branch = [
      makeEntry("old_user", 120),
      makeAssistantEntry("old_asst", 110, "call_a", "call_b"),  // 2 parallel calls
      makeToolResultEntry("result_a", 3, "call_a"),              // recent
      makeToolResultEntry("result_b", 2, "call_b"),              // recent
      makeEntry("recent_user", 1),
    ]
    const result = calculateWindowBoundary(branch, state)
    if (result) {
      // Both results reference the old assistant — snap past both
      expect(result.newMarker).toBe("recent_user")
      expect(result.droppedCount).toBe(4) // old_user + old_asst + result_a + result_b
    }
  })
})
