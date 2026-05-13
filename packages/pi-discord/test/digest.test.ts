/**
 * Digest accumulator + formatter tests — pure logic, no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DigestAccumulator, formatDigest, type DigestEntry } from "../src/digest.js";
import type { DiscliMessageEvent } from "../src/routing.js";

const T0 = 1_000_000_000_000;

function ev(overrides: Partial<DiscliMessageEvent> = {}): DiscliMessageEvent {
  return {
    event: "message",
    message_id: "msg-1",
    channel_id: "C-100",
    channel: "general",
    server: "Test Server",
    server_id: "S-1",
    author: "alice",
    author_id: "U-alice",
    content: "hello",
    is_bot: false,
    mentions_bot: false,
    is_dm: false,
    timestamp: "2026-05-12T00:00:00Z",
    ...overrides,
  };
}

// ── Accumulator ───────────────────────────────────────────────────────────

test("accumulator: empty by default", () => {
  const d = new DigestAccumulator();
  assert.equal(d.isEmpty(), true);
  assert.deepEqual(d.peek(), []);
});

test("accumulator: counts per channel", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }), T0);
  d.note(ev({ channel_id: "C-A", channel: "help" }), T0 + 1000);
  d.note(ev({ channel_id: "C-B", channel: "random" }), T0 + 500);
  const entries = d.peek();
  assert.equal(entries.length, 2);
  const help = entries.find((e) => e.channel_id === "C-A")!;
  assert.equal(help.count, 2);
  assert.equal(help.last_activity_ms, T0 + 1000);
  const random = entries.find((e) => e.channel_id === "C-B")!;
  assert.equal(random.count, 1);
});

test("accumulator: peek sorts by recency, newest first", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }), T0);
  d.note(ev({ channel_id: "C-B", channel: "random" }), T0 + 5000);
  d.note(ev({ channel_id: "C-C", channel: "off-topic" }), T0 + 2000);
  const order = d.peek().map((e) => e.channel);
  assert.deepEqual(order, ["random", "off-topic", "help"]);
});

test("accumulator: peek does not reset", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }));
  d.peek();
  d.peek();
  assert.equal(d.peek().length, 1);
});

test("accumulator: drain returns + resets", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }));
  const drained = d.drain();
  assert.equal(drained.length, 1);
  assert.equal(d.isEmpty(), true);
  // Subsequent drain is empty
  assert.deepEqual(d.drain(), []);
});

// ── Formatter ─────────────────────────────────────────────────────────────

test("formatDigest: empty returns null", () => {
  assert.equal(formatDigest([]), null);
});

test("formatDigest: single channel, single message", () => {
  const out = formatDigest([
    { channel_id: "C-A", channel: "help", server: "Server", count: 1, last_activity_ms: T0 },
  ]);
  assert.equal(out, "[unread] #help: 1");
});

test("formatDigest: single server, multiple channels — no qualifier", () => {
  const out = formatDigest([
    { channel_id: "C-A", channel: "help", server: "Server", count: 3, last_activity_ms: T0 + 1000 },
    { channel_id: "C-B", channel: "random", server: "Server", count: 12, last_activity_ms: T0 },
  ]);
  assert.equal(out, "[unread] #help: 3, #random: 12");
});

test("formatDigest: multiple servers — qualifies each entry", () => {
  const out = formatDigest([
    { channel_id: "C-A", channel: "general", server: "Server A", count: 2, last_activity_ms: T0 + 1000 },
    { channel_id: "C-B", channel: "general", server: "Server B", count: 5, last_activity_ms: T0 },
  ]);
  // Both have channel name "general" so qualification is essential
  assert.match(out!, /Server A \/ #general: 2/);
  assert.match(out!, /Server B \/ #general: 5/);
});

test("formatDigest: DM (no server) treated as its own bucket for qualification", () => {
  const out = formatDigest([
    { channel_id: "C-A", channel: "general", server: "Server", count: 2, last_activity_ms: T0 + 1000 },
    { channel_id: "DM-X", channel: "DM-with-alice", server: undefined, count: 1, last_activity_ms: T0 },
  ]);
  // DM should not get "Server / " prefix since it has no server; non-DM should be qualified.
  assert.match(out!, /Server \/ #general: 2/);
  assert.match(out!, /#DM-with-alice: 1/);
});

test("clear(channel_id): removes only that channel", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }));
  d.note(ev({ channel_id: "C-B", channel: "random" }));
  assert.equal(d.clear("C-A"), 1);
  const remaining = d.peek();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.channel_id, "C-B");
});

test("clear(): removes all entries, returns count cleared", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }));
  d.note(ev({ channel_id: "C-B", channel: "random" }));
  d.note(ev({ channel_id: "C-C", channel: "off-topic" }));
  assert.equal(d.clear(), 3);
  assert.equal(d.isEmpty(), true);
});

test("clear(unknown channel_id): returns 0, leaves digest intact", () => {
  const d = new DigestAccumulator();
  d.note(ev({ channel_id: "C-A", channel: "help" }));
  assert.equal(d.clear("nonexistent"), 0);
  assert.equal(d.peek().length, 1);
});

test("clear() on empty: returns 0", () => {
  const d = new DigestAccumulator();
  assert.equal(d.clear(), 0);
  assert.equal(d.clear("any"), 0);
});
