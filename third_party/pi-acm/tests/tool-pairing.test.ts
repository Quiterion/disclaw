import { describe, it, expect, beforeEach } from "vitest"
import {
  buildPairIndex,
  getPartnerIndices,
  expandWithPartners,
  repairToolPairing,
  resetTurnStats,
  getTurnStats,
} from "../src/tool-pairing.js"

// ── Helpers ────────────────────────────────────────────────────────────────

type Msg = { role: string; content?: any; toolCallId?: string; toolName?: string; output?: string; [k: string]: any }

function user(text: string): Msg {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistant(text: string, ...toolCallIds: string[]): Msg {
  const content: any[] = [{ type: "text", text }]
  for (const id of toolCallIds) {
    content.push({ type: "toolCall", id, name: "bash", arguments: {} })
  }
  return { role: "assistant", content }
}
function assistantToolOnly(...toolCallIds: string[]): Msg {
  const content: any[] = toolCallIds.map(id => ({ type: "toolCall", id, name: "bash", arguments: {} }))
  return { role: "assistant", content }
}
function toolResult(toolCallId: string, text: string): Msg {
  return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false }
}
function bashExecution(toolCallId: string, output: string): Msg {
  return { role: "bashExecution", toolCallId, toolName: "bash", output }
}

// ── buildPairIndex ─────────────────────────────────────────────────────────

describe("buildPairIndex", () => {
  it("builds correct index for a simple call/result pair", () => {
    const msgs = [
      user("hello"),
      assistant("running", "call_001"),
      toolResult("call_001", "output"),
    ]
    const idx = buildPairIndex(msgs)

    expect(idx.byCallId.size).toBe(1)
    expect(idx.byCallId.get("call_001")).toEqual({
      callId: "call_001", callMsgIdx: 1, resultMsgIdx: 2,
    })
    expect(idx.callIdsByMsgIdx.get(1)).toEqual(["call_001"])
    expect(idx.resultIdByMsgIdx.get(2)).toBe("call_001")
  })

  it("handles multiple parallel tool calls in one assistant message", () => {
    const msgs = [
      assistant("running", "call_a", "call_b"),
      toolResult("call_a", "out_a"),
      toolResult("call_b", "out_b"),
    ]
    const idx = buildPairIndex(msgs)

    expect(idx.byCallId.size).toBe(2)
    expect(idx.callIdsByMsgIdx.get(0)).toEqual(["call_a", "call_b"])
    expect(idx.byCallId.get("call_a")!.resultMsgIdx).toBe(1)
    expect(idx.byCallId.get("call_b")!.resultMsgIdx).toBe(2)
  })

  it("handles bashExecution results", () => {
    const msgs = [
      assistant("running", "call_bash"),
      bashExecution("call_bash", "$ ls\nfile.txt"),
    ]
    const idx = buildPairIndex(msgs)

    expect(idx.byCallId.get("call_bash")!.resultMsgIdx).toBe(1)
    expect(idx.resultIdByMsgIdx.get(1)).toBe("call_bash")
  })

  it("marks mid-execution calls as resultMsgIdx=null", () => {
    const msgs = [
      assistant("running", "call_pending"),
    ]
    const idx = buildPairIndex(msgs)

    expect(idx.byCallId.get("call_pending")!.resultMsgIdx).toBeNull()
  })

  it("handles interleaved user messages between call and result", () => {
    const msgs = [
      assistant("call", "c1"),
      toolResult("c1", "r1"),
      user("question"),
      assistant("call2", "c2"),
      toolResult("c2", "r2"),
    ]
    const idx = buildPairIndex(msgs)
    expect(idx.byCallId.size).toBe(2)
    expect(idx.byCallId.get("c1")!.resultMsgIdx).toBe(1)
    expect(idx.byCallId.get("c2")!.resultMsgIdx).toBe(4)
  })

  it("handles messages with no tool calls", () => {
    const msgs = [user("hi"), assistant("hello")]
    const idx = buildPairIndex(msgs)
    expect(idx.byCallId.size).toBe(0)
    expect(idx.callIdsByMsgIdx.size).toBe(0)
    expect(idx.resultIdByMsgIdx.size).toBe(0)
  })
})

// ── getPartnerIndices ──────────────────────────────────────────────────────

describe("getPartnerIndices", () => {
  it("returns result indices when dropping an assistant msg with calls", () => {
    const msgs = [
      assistant("run", "c1", "c2"),
      toolResult("c1", "r1"),
      toolResult("c2", "r2"),
    ]
    const idx = buildPairIndex(msgs)
    const partners = getPartnerIndices(0, idx)
    expect(partners.sort()).toEqual([1, 2])
  })

  it("returns call index when dropping a result message", () => {
    const msgs = [
      assistant("run", "c1"),
      toolResult("c1", "r1"),
    ]
    const idx = buildPairIndex(msgs)
    const partners = getPartnerIndices(1, idx)
    expect(partners).toEqual([0])
  })

  it("returns empty for messages with no tool involvement", () => {
    const msgs = [user("hi"), assistant("hello")]
    const idx = buildPairIndex(msgs)
    expect(getPartnerIndices(0, idx)).toEqual([])
    expect(getPartnerIndices(1, idx)).toEqual([])
  })

  it("returns empty for mid-execution calls (no result yet)", () => {
    const msgs = [assistant("running", "c1")]
    const idx = buildPairIndex(msgs)
    // Dropping the call has no result partner to pull
    expect(getPartnerIndices(0, idx)).toEqual([])
  })
})

// ── expandWithPartners ─────────────────────────────────────────────────────

describe("expandWithPartners", () => {
  it("expands a single drop to include all partners", () => {
    const msgs = [
      assistant("run", "c1", "c2"),
      toolResult("c1", "r1"),
      toolResult("c2", "r2"),
      user("next"),
    ]
    const idx = buildPairIndex(msgs)
    const expanded = expandWithPartners(new Set([0]), idx)
    expect(expanded).toEqual(new Set([0, 1, 2]))
  })

  it("expands dropping a result to include the call and sibling results", () => {
    const msgs = [
      assistant("run", "c1", "c2"),
      toolResult("c1", "r1"),
      toolResult("c2", "r2"),
    ]
    const idx = buildPairIndex(msgs)
    // Drop result for c1 → should pull assistant (idx 0) → should pull result for c2 (idx 2)
    const expanded = expandWithPartners(new Set([1]), idx)
    expect(expanded).toEqual(new Set([0, 1, 2]))
  })

  it("respects pinned indices — does not expand into pinned", () => {
    const msgs = [
      assistant("run", "c1"),
      toolResult("c1", "r1"),
    ]
    const idx = buildPairIndex(msgs)
    // Assistant (idx 0) is pinned — should not be added when dropping result (idx 1)
    const expanded = expandWithPartners(new Set([1]), idx, new Set([0]))
    expect(expanded).toEqual(new Set([1]))  // can't pull pinned partner
  })
})

// ── repairToolPairing ──────────────────────────────────────────────────────

describe("repairToolPairing", () => {
  beforeEach(() => resetTurnStats())

  it("removes orphaned tool results (result with no call)", () => {
    const msgs: Msg[] = [
      user("hi"),
      toolResult("call_ghost", "orphan output"),
      assistant("hello"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, true)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe("user")
    expect(messages[1]!.role).toBe("assistant")
    expect(repairedCount).toBe(1)
    expect(getTurnStats().orphansRepairedByNet).toBe(1)
  })

  it("removes orphaned bashExecution results", () => {
    const msgs: Msg[] = [
      bashExecution("call_ghost", "orphan output"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, true)
    expect(messages).toHaveLength(0)
    expect(repairedCount).toBe(1)
  })

  it("removes orphaned toolCall blocks from assistant messages when actively filtering", () => {
    const msgs: Msg[] = [
      assistant("text", "orphan_call"),
      user("next"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, true)
    // The toolCall block should be removed, text block preserved
    const content = messages[0]!.content as any[]
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe("text")
    expect(repairedCount).toBe(1)
  })

  it("does NOT remove orphaned toolCall blocks when not actively filtering (mid-execution)", () => {
    const msgs: Msg[] = [
      assistant("running", "pending_call"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, false)
    const content = messages[0]!.content as any[]
    expect(content).toHaveLength(2) // text + toolCall preserved
    expect(repairedCount).toBe(0)
  })

  it("leaves intact pairs untouched", () => {
    const msgs: Msg[] = [
      assistant("run", "c1"),
      toolResult("c1", "output"),
      user("thanks"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, true)
    expect(messages).toHaveLength(3)
    expect(repairedCount).toBe(0)
  })

  it("handles multiple orphans in one pass", () => {
    const msgs: Msg[] = [
      toolResult("ghost1", "x"),
      toolResult("ghost2", "y"),
      assistant("text", "ghost3"),
      user("hi"),
    ]
    const { messages, repairedCount } = repairToolPairing(msgs, true)
    expect(messages).toHaveLength(2) // assistant (with toolCall stripped) + user
    expect(repairedCount).toBe(3) // 2 results + 1 toolCall block
  })
})
