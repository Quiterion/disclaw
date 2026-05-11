import { describe, it, expect, vi, beforeEach } from "vitest"
import { defaultState } from "../src/state.js"
import { buildEntryMap } from "../src/entry-map.js"
import { applySnipe } from "../src/snipe-apply.js"
import {
  buildPairIndex,
  expandWithPartners,
  repairToolPairing,
  resetTurnStats,
} from "../src/tool-pairing.js"

// ── Helpers ────────────────────────────────────────────────────────────────

type Msg = { role: string; content?: any; toolCallId?: string; toolName?: string; [k: string]: any }

function user(text: string): Msg {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistant(text: string, toolCallId?: string): Msg {
  const content: any[] = [{ type: "text", text }]
  if (toolCallId) content.push({ type: "toolCall", id: toolCallId, name: "bash", arguments: {} })
  return { role: "assistant", content }
}
function toolResult(toolCallId: string, text: string): Msg {
  return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false }
}

// Simulate the context filter pipeline (inline — we're not importing the
// handler directly since it wires to pi events; we test the logic pieces)

function applyPrune(messages: Msg[], pruned: Record<string, boolean>, indexToId: Map<number, string>): Msg[] {
  return messages.filter((_, i) => {
    const id = indexToId.get(i)
    return !id || !pruned[id]
  })
}

function validatePairing(messages: Msg[]): string[] {
  const warnings: string[] = []
  const calledIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "toolCall" && b.id) calledIds.add(b.id)
      }
    }
    // Match both toolResult and bashExecution (pi has multiple result roles)
    if ((msg.role === "toolResult" || msg.role === "bashExecution") && msg.toolCallId) {
      resultIds.add(msg.toolCallId)
    }
  }
  // Only warn on the dangerous direction: result with no call
  for (const id of resultIds) {
    if (!calledIds.has(id)) warnings.push(`orphan result: ${id}`)
  }
  return warnings
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("context filter: pruning", () => {
  it("removes pruned messages from context", () => {
    const messages = [user("hello"), assistant("world"), user("again")]
    const branch = [
      { type: "message", id: "a1", parentId: null, message: messages[0]! },
      { type: "message", id: "b2", parentId: "a1", message: messages[1]! },
      { type: "message", id: "c3", parentId: "b2", message: messages[2]! },
    ]
    const { indexToId } = buildEntryMap(branch, messages)
    const pruned = { "b2": true }
    const result = applyPrune(messages, pruned, indexToId)
    expect(result).toHaveLength(2)
    expect(result[0]!.role).toBe("user")
    expect(result[1]!.role).toBe("user")
  })

  it("leaves non-pruned messages intact", () => {
    const messages = [user("a"), user("b")]
    const branch = [
      { type: "message", id: "x1", parentId: null, message: messages[0]! },
      { type: "message", id: "y2", parentId: "x1", message: messages[1]! },
    ]
    const { indexToId } = buildEntryMap(branch, messages)
    const result = applyPrune(messages, {}, indexToId)
    expect(result).toHaveLength(2)
  })
})

describe("context filter: snipe", () => {
  it("truncates tool result content", () => {
    const longText = "x".repeat(1000)
    const msg: Msg = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: longText }], isError: false }
    applySnipe(msg, { strategy: "truncate", maxChars: 50 })
    const text = (msg.content as any[])[0].text as string
    expect(text.length).toBeLessThan(200)
    expect(text).toContain("[ACM: truncated from 1k chars]")
    expect(text.startsWith("x".repeat(50))).toBe(true)
  })

  it("removes thinking blocks from assistant message", () => {
    const msg: Msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deep thought" },
        { type: "text", text: "The answer is 42" },
      ],
    }
    applySnipe(msg, { strategy: "remove", target: "thinking" })
    expect(msg.content).toHaveLength(1)
    expect((msg.content as any[])[0].type).toBe("text")
  })

  it("replaces content with provided replacement", () => {
    const msg: Msg = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "big output" }], isError: false }
    applySnipe(msg, { strategy: "replace", replacement: "Summary: file has 3 exports" })
    expect((msg.content as any[])[0].text).toBe("Summary: file has 3 exports")
  })

  it("head_tail keeps beginning and end", () => {
    const text = "A".repeat(200) + "B".repeat(200)
    const msg: Msg = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text }], isError: false }
    applySnipe(msg, { strategy: "head_tail", maxChars: 100 })
    const result = (msg.content as any[])[0].text as string
    expect(result).toContain("AAAA")
    expect(result).toContain("BBBB")
    expect(result).toContain("[... ")
  })
})

describe("context filter: tool call pairing validation (legacy)", () => {
  it("does NOT warn about toolCall with no result — expected mid-execution", () => {
    const messages: Msg[] = [
      assistant("I'll run bash", "call_001"),
    ]
    const warnings = validatePairing(messages)
    expect(warnings).toHaveLength(0)
  })

  it("warns when toolResult has no matching toolCall — ACM removed the call", () => {
    const messages: Msg[] = [
      toolResult("call_002", "output"),
    ]
    const warnings = validatePairing(messages)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("call_002")
  })

  it("finds no warnings when pairing is intact", () => {
    const messages: Msg[] = [
      assistant("running", "call_003"),
      toolResult("call_003", "output"),
    ]
    const warnings = validatePairing(messages)
    expect(warnings).toHaveLength(0)
  })
})

// ── Prevention integration tests ──────────────────────────────────────────

describe("context filter: pair-aware prevention", () => {
  it("expandWithPartners pulls tool results when dropping assistant with calls", () => {
    const messages: Msg[] = [
      user("hi"),
      assistant("running", "c1"),
      toolResult("c1", "output"),
      user("next"),
    ]
    const pairIndex = buildPairIndex(messages)
    // Dropping assistant at index 1
    const expanded = expandWithPartners(new Set([1]), pairIndex)
    expect(expanded).toEqual(new Set([1, 2]))  // assistant + its result
  })

  it("expandWithPartners pulls assistant when dropping its tool result", () => {
    const messages: Msg[] = [
      assistant("running", "c1"),
      toolResult("c1", "output"),
    ]
    const pairIndex = buildPairIndex(messages)
    // Dropping result at index 1 → should pull assistant at index 0
    const expanded = expandWithPartners(new Set([1]), pairIndex)
    expect(expanded).toEqual(new Set([0, 1]))
  })

  it("prune filter simulated: pruning assistant auto-includes results", () => {
    const messages: Msg[] = [
      user("q"),
      assistant("run", "c1"),
      toolResult("c1", "r1"),
      assistant("run2", "c2"),
      toolResult("c2", "r2"),
      user("done"),
    ]
    const branch = messages.map((m, i) => ({
      type: "message", id: `e${i}`, parentId: i > 0 ? `e${i - 1}` : null, message: m,
    }))
    const { indexToId } = buildEntryMap(branch, messages)
    const pairIndex = buildPairIndex(messages)

    // User prunes assistant at index 1 (entry "e1")
    const pruneSet = new Set([1])  // assistant with c1
    const expanded = expandWithPartners(pruneSet, pairIndex)

    // Should include index 2 (toolResult for c1)
    expect(expanded).toEqual(new Set([1, 2]))

    // Filter messages
    const surviving = messages.filter((_, i) => !expanded.has(i))
    expect(surviving).toHaveLength(4) // user, assistant2, result2, user
    expect(surviving[0]!.role).toBe("user")
    expect(surviving[1]!.role).toBe("assistant")
  })

  it("summary-marker simulated: marker between call and result expands to include result", () => {
    const messages: Msg[] = [
      user("old"),
      assistant("call", "c1"),
      // ← marker would land here
      toolResult("c1", "output"),
      user("new"),
    ]
    const pairIndex = buildPairIndex(messages)

    // Marker drops indices 0 and 1 (everything before index 2)
    const markerDrops = new Set([0, 1])
    const expanded = expandWithPartners(markerDrops, pairIndex)

    // Should also drop index 2 (the orphaned result)
    expect(expanded).toEqual(new Set([0, 1, 2]))
  })
})

// ── Repair integration tests ──────────────────────────────────────────────

describe("context filter: repair safety net", () => {
  beforeEach(() => resetTurnStats())

  it("repairs orphaned tool result that slipped through prevention", () => {
    // Simulate a case where prevention missed (e.g. race condition)
    const messages: Msg[] = [
      user("hi"),
      toolResult("ghost_call", "orphan"),
      assistant("hello"),
    ]
    const { messages: repaired, repairedCount } = repairToolPairing(messages, true)
    expect(repaired).toHaveLength(2) // orphan removed
    expect(repaired[0]!.role).toBe("user")
    expect(repaired[1]!.role).toBe("assistant")
    expect(repairedCount).toBe(1)
  })

  it("repairs orphaned toolCall block in assistant message", () => {
    const messages: Msg[] = [
      assistant("text", "orphan_call"),
      user("thanks"),
    ]
    const { messages: repaired, repairedCount } = repairToolPairing(messages, true)
    expect(repaired).toHaveLength(2)
    // toolCall block stripped from assistant
    const assistantContent = repaired[0]!.content as any[]
    expect(assistantContent).toHaveLength(1)
    expect(assistantContent[0].type).toBe("text")
    expect(repairedCount).toBe(1)
  })

  it("does not repair mid-execution calls when not actively filtering", () => {
    const messages: Msg[] = [
      assistant("running", "active_call"),
    ]
    const { messages: repaired, repairedCount } = repairToolPairing(messages, false)
    const content = repaired[0]!.content as any[]
    expect(content).toHaveLength(2) // text + toolCall preserved
    expect(repairedCount).toBe(0)
  })

  it("handles mixed orphans: results and calls", () => {
    const messages: Msg[] = [
      toolResult("ghost1", "orphan1"),
      assistant("text", "ghost2"),
      toolResult("ghost3", "orphan3"),
    ]
    const { repairedCount } = repairToolPairing(messages, true)
    expect(repairedCount).toBe(3) // 2 orphan results + 1 orphan toolCall block
  })
})
