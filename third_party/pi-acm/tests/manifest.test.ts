import { describe, it, expect } from "vitest"
import { generateManifestEntry, generateManifestEntries } from "../src/manifest.js"
import { defaultState, appendManifestEntries, MANIFEST_CAP } from "../src/state.js"
import type { AcmState, ManifestEntry } from "../src/state.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(id: string, role: string, content: string, extra?: Record<string, any>) {
  return {
    type: "message" as const,
    id,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text: content }], ...extra },
  }
}

function makeToolResult(id: string, toolName: string, content: string) {
  return {
    type: "message" as const,
    id,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolName,
      content: [{ type: "text", text: content }],
    },
  }
}

function makeToolCall(id: string, toolName: string, args: Record<string, any>) {
  return {
    type: "message" as const,
    id,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me do that." },
        { type: "toolCall", id: "tc-1", name: toolName, args },
      ],
    },
  }
}

function makeBashResult(id: string, output: string) {
  return {
    type: "message" as const,
    id,
    timestamp: new Date().toISOString(),
    message: { role: "bashExecution", output },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("generateManifestEntry", () => {
  it("extracts user message with heuristic preview", () => {
    const entry = makeEntry("user-001", "user", "Please fix the auth bug")
    const state = defaultState()
    const m = generateManifestEntry(entry, "prune", state)

    expect(m.id).toBe("user-001")
    expect(m.shortId).toBe("user-001")
    expect(m.role).toBe("user")
    expect(m.tool).toBeUndefined()
    expect(m.preview).toBe("Please fix the auth bug")
    expect(m.reason).toBe("prune")
    expect(m.tokens).toBeGreaterThan(0)
  })

  it("extracts toolResult with tool name", () => {
    const entry = makeToolResult("tr-001", "read", "/src/state.ts\nexport interface AcmConfig {\n  keepActiveMinutes: number\n}")
    const state = defaultState()
    const m = generateManifestEntry(entry, "slide", state)

    expect(m.role).toBe("toolResult")
    expect(m.tool).toBe("read")
    expect(m.preview).toBe("/src/state.ts")
    expect(m.reason).toBe("slide")
  })

  it("extracts assistant toolCall with tool name and arg", () => {
    const entry = makeToolCall("tc-001", "read", { path: "src/config.ts" })
    const state = defaultState()
    const m = generateManifestEntry(entry, "pressure", state)

    expect(m.role).toBe("toolCall")
    expect(m.tool).toBe("read")
    expect(m.arg).toBe("src/config.ts")
    expect(m.reason).toBe("pressure")
  })

  it("uses snipe replace as preview when available", () => {
    const entry = makeToolResult("sr-001", "read", "very long file content here...")
    const state = defaultState()
    state.sniped["sr-001"] = {
      strategy: "replace",
      replacement: "AcmConfig: autoCompactOnPercent=85, keepActiveMinutes=30",
    }
    const m = generateManifestEntry(entry, "slide", state)

    expect(m.preview).toBe("AcmConfig: autoCompactOnPercent=85, keepActiveMinutes=30")
  })

  it("falls back to heuristic for snipe truncate", () => {
    const entry = makeToolResult("st-001", "read", "first line of file\nsecond line")
    const state = defaultState()
    state.sniped["st-001"] = { strategy: "truncate", maxChars: 200 }
    const m = generateManifestEntry(entry, "prune", state)

    expect(m.preview).toBe("first line of file")
  })

  it("falls back to heuristic for snipe head_tail", () => {
    const entry = makeToolResult("ht-001", "bash", "PASS all tests\nDone in 2.3s")
    const state = defaultState()
    state.sniped["ht-001"] = { strategy: "head_tail", maxChars: 200 }
    const m = generateManifestEntry(entry, "prune", state)

    expect(m.preview).toBe("PASS all tests")
  })

  it("uses descriptive preview for snipe remove", () => {
    const entry = makeToolResult("rm-001", "read", "original content")
    const state = defaultState()
    state.sniped["rm-001"] = { strategy: "remove" }
    const m = generateManifestEntry(entry, "slide", state)

    expect(m.preview).toContain("read")
    expect(m.preview).toContain("removed")
  })

  it("handles unsniped entry with heuristic", () => {
    const entry = makeEntry("plain-001", "assistant", "I'll implement the auth module now.")
    const state = defaultState()
    const m = generateManifestEntry(entry, "slide", state)

    expect(m.preview).toBe("I'll implement the auth module now.")
    expect(m.tool).toBeUndefined()
  })

  it("truncates long previews", () => {
    const longText = "A".repeat(200)
    const entry = makeEntry("long-001", "user", longText)
    const state = defaultState()
    const m = generateManifestEntry(entry, "prune", state)

    expect(m.preview.length).toBeLessThanOrEqual(63) // 60 + "..."
  })

  it("truncates long replace previews at 120 chars", () => {
    const entry = makeToolResult("lr-001", "read", "original")
    const state = defaultState()
    state.sniped["lr-001"] = {
      strategy: "replace",
      replacement: "B".repeat(200),
    }
    const m = generateManifestEntry(entry, "slide", state)

    expect(m.preview.length).toBeLessThanOrEqual(123) // 120 + "..."
  })
})

describe("generateManifestEntries", () => {
  it("generates entries for multiple messages", () => {
    const entries = [
      makeEntry("m1", "user", "hello"),
      makeToolResult("m2", "read", "file content"),
      { type: "model_change" as const, id: "mc1", timestamp: new Date().toISOString() }, // should be skipped
    ]
    const state = defaultState()
    const manifests = generateManifestEntries(entries as any, "slide", state)

    expect(manifests).toHaveLength(2)
    expect(manifests[0]!.id).toBe("m1")
    expect(manifests[1]!.id).toBe("m2")
  })
})

describe("appendManifestEntries + FIFO eviction", () => {
  it("appends entries normally under cap", () => {
    const state = defaultState()
    const entries: ManifestEntry[] = [
      { id: "a", shortId: "a", role: "user", preview: "hi", tokens: 10, prunedAt: 1, reason: "prune" },
      { id: "b", shortId: "b", role: "user", preview: "bye", tokens: 20, prunedAt: 2, reason: "prune" },
    ]
    const updated = appendManifestEntries(state, entries)
    expect(updated.prunedManifest).toHaveLength(2)
  })

  it("evicts oldest entries when exceeding cap", () => {
    const state = defaultState()
    // Fill to cap
    state.prunedManifest = Array.from({ length: MANIFEST_CAP }, (_, i) => ({
      id: `old-${i}`, shortId: `old-${i}`.slice(0, 8), role: "user",
      preview: `old ${i}`, tokens: 10, prunedAt: i, reason: "slide" as const,
    }))

    const newEntries: ManifestEntry[] = [
      { id: "new-1", shortId: "new-1", role: "user", preview: "new", tokens: 10, prunedAt: 999, reason: "prune" },
      { id: "new-2", shortId: "new-2", role: "user", preview: "new2", tokens: 10, prunedAt: 1000, reason: "prune" },
    ]
    const updated = appendManifestEntries(state, newEntries)

    expect(updated.prunedManifest).toHaveLength(MANIFEST_CAP)
    // Oldest should be gone
    expect(updated.prunedManifest[0]!.id).toBe("old-2")
    // Newest should be at end
    expect(updated.prunedManifest[MANIFEST_CAP - 1]!.id).toBe("new-2")
    expect(updated.prunedManifest[MANIFEST_CAP - 2]!.id).toBe("new-1")
  })
})
