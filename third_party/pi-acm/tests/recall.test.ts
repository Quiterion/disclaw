import { describe, it, expect } from "vitest"

/**
 * acm_recall tool tests.
 *
 * Since registerRecallTool needs a full ExtensionAPI mock, we test the
 * core logic indirectly by testing the hidden entry resolution and
 * the search/format helpers. The tool itself is a thin wrapper.
 *
 * For a full integration test, see recall-integration.test.ts.
 */

// We re-implement the key internal logic here to test independently.
// In production, these live inside recall.ts as private functions.

type ContentBlock = { type: string; text?: string; [k: string]: unknown }
type BranchEntry = {
  type: string; id: string; timestamp: string
  message?: { role: string; content?: ContentBlock[] | string; toolName?: string; output?: string; [k: string]: unknown }
}

interface AcmStateLike {
  pruned: Record<string, boolean>
  summaryMarker: string | null
  pinned: Record<string, boolean>
}

function findHiddenEntries(branch: BranchEntry[], state: AcmStateLike): BranchEntry[] {
  const pinnedIds = new Set(
    Object.keys(state.pinned).filter(id => state.pinned[id])
  )
  const hidden: BranchEntry[] = []
  let pastMarker = state.summaryMarker === null

  for (const entry of branch) {
    if (!pastMarker) {
      if (entry.id === state.summaryMarker) {
        pastMarker = true
        continue
      }
      if (entry.type === "message" && entry.message && !pinnedIds.has(entry.id)) {
        hidden.push(entry)
      }
      continue
    }
    if (entry.type === "message" && entry.message && state.pruned[entry.id] && !pinnedIds.has(entry.id)) {
      hidden.push(entry)
    }
  }
  return hidden
}

function getFullText(entry: BranchEntry): string | null {
  const msg = entry.message
  if (!msg) return null
  if (typeof msg.output === "string") return msg.output
  if (Array.isArray(msg.content)) {
    const texts = (msg.content as ContentBlock[])
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text!)
    if (texts.length > 0) return texts.join("\n")
  }
  if (typeof msg.content === "string") return msg.content
  return null
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function msg(id: string, role: string, text: string, extra?: Record<string, any>): BranchEntry {
  return {
    type: "message", id, timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }], ...extra },
  }
}

function toolResult(id: string, toolName: string, text: string): BranchEntry {
  return {
    type: "message", id, timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolName, content: [{ type: "text", text }] },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("findHiddenEntries", () => {
  it("returns empty when nothing pruned or windowed", () => {
    const branch = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
    ]
    const state: AcmStateLike = { pruned: {}, summaryMarker: null, pinned: {} }
    expect(findHiddenEntries(branch, state)).toHaveLength(0)
  })

  it("finds entries behind sliding window marker", () => {
    const branch = [
      msg("m1", "user", "old message"),
      msg("m2", "assistant", "old reply"),
      msg("m3", "user", "new message"),  // marker points here
      msg("m4", "assistant", "new reply"),
    ]
    const state: AcmStateLike = { pruned: {}, summaryMarker: "m3", pinned: {} }
    const hidden = findHiddenEntries(branch, state)

    expect(hidden).toHaveLength(2)
    expect(hidden[0]!.id).toBe("m1")
    expect(hidden[1]!.id).toBe("m2")
  })

  it("excludes pinned entries from hidden", () => {
    const branch = [
      msg("m1", "user", "important pinned"),
      msg("m2", "assistant", "old reply"),
      msg("m3", "user", "new message"),
    ]
    const state: AcmStateLike = { pruned: {}, summaryMarker: "m3", pinned: { m1: true } }
    const hidden = findHiddenEntries(branch, state)

    expect(hidden).toHaveLength(1)
    expect(hidden[0]!.id).toBe("m2")
  })

  it("finds explicitly pruned entries past the marker", () => {
    const branch = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "pruned reply"),
      msg("m3", "user", "visible"),
    ]
    const state: AcmStateLike = { pruned: { m2: true }, summaryMarker: null, pinned: {} }
    const hidden = findHiddenEntries(branch, state)

    expect(hidden).toHaveLength(1)
    expect(hidden[0]!.id).toBe("m2")
  })

  it("combines windowed and pruned entries", () => {
    const branch = [
      msg("m1", "user", "windowed"),
      msg("m2", "user", "marker"),  // marker
      msg("m3", "assistant", "pruned"),
      msg("m4", "user", "visible"),
    ]
    const state: AcmStateLike = { pruned: { m3: true }, summaryMarker: "m2", pinned: {} }
    const hidden = findHiddenEntries(branch, state)

    expect(hidden).toHaveLength(2)
    expect(hidden.map(h => h.id)).toEqual(["m1", "m3"])
  })

  it("skips non-message entries", () => {
    const branch: BranchEntry[] = [
      { type: "model_change", id: "mc1", timestamp: new Date().toISOString() },
      msg("m1", "user", "hello"),
      msg("m2", "user", "marker"),
    ]
    const state: AcmStateLike = { pruned: {}, summaryMarker: "m2", pinned: {} }
    const hidden = findHiddenEntries(branch, state)

    // model_change has no message, should not appear
    expect(hidden).toHaveLength(1)
    expect(hidden[0]!.id).toBe("m1")
  })
})

describe("getFullText", () => {
  it("extracts from text content blocks", () => {
    const entry = msg("m1", "user", "hello world")
    expect(getFullText(entry)).toBe("hello world")
  })

  it("extracts from bash output", () => {
    const entry: BranchEntry = {
      type: "message", id: "b1", timestamp: new Date().toISOString(),
      message: { role: "bashExecution", output: "npm test: PASS" },
    }
    expect(getFullText(entry)).toBe("npm test: PASS")
  })

  it("extracts from string content", () => {
    const entry: BranchEntry = {
      type: "message", id: "s1", timestamp: new Date().toISOString(),
      message: { role: "user", content: "plain string content" },
    }
    expect(getFullText(entry)).toBe("plain string content")
  })

  it("returns null for entry with no message", () => {
    const entry: BranchEntry = { type: "message", id: "n1", timestamp: new Date().toISOString() }
    expect(getFullText(entry)).toBeNull()
  })

  it("joins multiple text blocks", () => {
    const entry: BranchEntry = {
      type: "message", id: "mt1", timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "first block" },
          { type: "toolCall", id: "tc1", name: "read" },
          { type: "text", text: "second block" },
        ],
      },
    }
    expect(getFullText(entry)).toBe("first block\nsecond block")
  })
})

describe("search (grep) logic", () => {
  it("matches regex across hidden entries", () => {
    const entries = [
      toolResult("tr1", "read", "export interface AcmConfig {\n  keepActiveMinutes: number\n}"),
      toolResult("tr2", "bash", "npm test: all passed"),
      msg("m1", "user", "use RS256 not HS256"),
    ]

    const re = /RS256/i
    const matches = entries.filter(e => {
      const text = getFullText(e)
      return text && re.test(text)
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]!.id).toBe("m1")
  })

  it("matches across tool results", () => {
    const entries = [
      toolResult("tr1", "read", "const JWT_EXPIRY = 3600"),
      toolResult("tr2", "read", "function processAuth() {}"),
    ]

    const re = /JWT/i
    const matches = entries.filter(e => {
      const text = getFullText(e)
      return text && re.test(text)
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]!.id).toBe("tr1")
  })
})
