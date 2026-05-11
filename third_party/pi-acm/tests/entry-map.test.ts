import { describe, it, expect } from "vitest"
import { buildEntryMap } from "../src/entry-map.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

function userMsg(id: string): any {
  return { type: "message", id, parentId: null, message: { role: "user", content: "hello" } }
}
function assistantMsg(id: string): any {
  return { type: "message", id, parentId: null, message: { role: "assistant", content: [] } }
}
function toolResultMsg(id: string): any {
  return { type: "message", id, parentId: null, message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: false } }
}
function compactionEntry(id: string, firstKeptEntryId: string): any {
  return { type: "compaction", id, parentId: null, summary: "...", firstKeptEntryId, tokensBefore: 1000 }
}
function ctxMsg(role: string): any {
  return { role }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildEntryMap", () => {
  it("maps a linear session without compaction", () => {
    const branch = [
      userMsg("a1"),
      assistantMsg("b2"),
      toolResultMsg("c3"),
      userMsg("d4"),
      assistantMsg("e5"),
    ]
    const messages = [
      ctxMsg("user"),
      ctxMsg("assistant"),
      ctxMsg("toolResult"),
      ctxMsg("user"),
      ctxMsg("assistant"),
    ]

    const { idToIndex, indexToId } = buildEntryMap(branch, messages)

    expect(idToIndex.get("a1")).toBe(0)
    expect(idToIndex.get("b2")).toBe(1)
    expect(idToIndex.get("c3")).toBe(2)
    expect(idToIndex.get("d4")).toBe(3)
    expect(idToIndex.get("e5")).toBe(4)

    expect(indexToId.get(0)).toBe("a1")
    expect(indexToId.get(4)).toBe("e5")
  })

  it("handles a session with one compaction", () => {
    // Branch: [user, assistant, COMPACTION, user, assistant]
    // Context: [compactionSummary, user, assistant]
    //          (messages before compaction are dropped from context)
    const branch = [
      userMsg("a1"),
      assistantMsg("b2"),
      compactionEntry("cmp1", "d4"),
      userMsg("d4"),
      assistantMsg("e5"),
    ]
    const messages = [
      ctxMsg("compactionSummary"),  // cmp1 maps here
      ctxMsg("user"),               // d4
      ctxMsg("assistant"),          // e5
    ]

    const { idToIndex, indexToId } = buildEntryMap(branch, messages)

    // Pre-compaction message entries (a1, b2) are not in context
    expect(idToIndex.has("a1")).toBe(false)
    expect(idToIndex.has("b2")).toBe(false)

    // Compaction entry maps to the summary message
    expect(idToIndex.get("cmp1")).toBe(0)
    expect(indexToId.get(0)).toBe("cmp1")

    // Post-compaction messages map normally
    expect(idToIndex.get("d4")).toBe(1)
    expect(idToIndex.get("e5")).toBe(2)
  })

  it("handles a session with multiple compactions", () => {
    // Two compactions: only the LAST one appears in context.
    // Earlier compactions and their pre-boundary messages are fully summarised
    // into the last compaction's summary and do not appear in context at all.
    const branch = [
      userMsg("a1"),
      assistantMsg("b2"),
      compactionEntry("cmp1", "c3"),
      userMsg("c3"),
      assistantMsg("d4"),
      compactionEntry("cmp2", "e5"),
      userMsg("e5"),
      assistantMsg("f6"),
    ]
    // Context: only the LAST compaction summary + post-cmp2 messages
    const messages = [
      ctxMsg("compactionSummary"),  // cmp2 (the last compaction)
      ctxMsg("user"),               // e5
      ctxMsg("assistant"),          // f6
    ]

    const { idToIndex } = buildEntryMap(branch, messages)

    // Only the last compaction is mapped
    expect(idToIndex.has("cmp1")).toBe(false)
    expect(idToIndex.get("cmp2")).toBe(0)
    expect(idToIndex.get("e5")).toBe(1)
    expect(idToIndex.get("f6")).toBe(2)

    // All entries before cmp2's firstKeptEntryId are not in context
    expect(idToIndex.has("a1")).toBe(false)
    expect(idToIndex.has("b2")).toBe(false)
    expect(idToIndex.has("c3")).toBe(false)
    expect(idToIndex.has("d4")).toBe(false)
  })

  it("returns empty maps for empty inputs", () => {
    const { idToIndex, indexToId } = buildEntryMap([], [])
    expect(idToIndex.size).toBe(0)
    expect(indexToId.size).toBe(0)
  })
})
