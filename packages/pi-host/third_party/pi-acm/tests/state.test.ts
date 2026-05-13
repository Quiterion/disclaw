import { describe, it, expect } from "vitest"
import { loadState, defaultState } from "../src/state.js"

describe("loadState", () => {
  it("returns default state when no acm entries", () => {
    const entries: any[] = [
      { type: "session", id: "hdr" },
      { type: "message", id: "a1", message: { role: "user" } },
    ]
    const state = loadState(entries)
    expect(state).toEqual(defaultState())
  })

  it("reconstructs state from a single acm entry", () => {
    const acmData = {
      ...defaultState(),
      pinned: { "a1b2c3d4": true },
      pruned: { "e5f6g7h8": true },
    }
    const entries: any[] = [
      { type: "custom", customType: "acm", data: acmData },
    ]
    const state = loadState(entries)
    expect(state.pinned["a1b2c3d4"]).toBe(true)
    expect(state.pruned["e5f6g7h8"]).toBe(true)
  })

  it("last-write-wins across multiple acm entries", () => {
    const first = { ...defaultState(), pinned: { "aaa": true } }
    const second = { ...defaultState(), pinned: { "bbb": true } }  // overwrites pinned
    const entries: any[] = [
      { type: "custom", customType: "acm", data: first },
      { type: "custom", customType: "acm", data: second },
    ]
    const state = loadState(entries)
    // Second entry wins — "aaa" is gone, "bbb" is present
    expect(state.pinned["aaa"]).toBeUndefined()
    expect(state.pinned["bbb"]).toBe(true)
  })

  it("ignores entries with wrong customType", () => {
    const entries: any[] = [
      { type: "custom", customType: "other-extension", data: { pinned: { "x": true } } },
    ]
    const state = loadState(entries)
    expect(state).toEqual(defaultState())
  })
})
