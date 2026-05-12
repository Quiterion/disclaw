import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBatch,
  formatRelativeTime,
  wrapDisclaw,
  type BufferedEvent,
} from "../src/formatting.js";
import type { DiscliMessageEvent } from "../src/routing.js";

const NOW = 1_000_000_000_000; // arbitrary fixed "now" for relative times

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
    timestamp: "2026-05-12T08:00:00Z",
    ...overrides,
  };
}

function buf(eventOverrides: Partial<DiscliMessageEvent>, secondsAgo: number, cls: "ping" | "channel" = "channel"): BufferedEvent {
  return {
    ev: ev(eventOverrides),
    class: cls,
    arrivedAt: NOW - secondsAgo * 1000,
  };
}

const optsFollowUp = { now: NOW, pingStyle: "follow_up" as const, pingPreviewLength: 150 };
const optsPush = { now: NOW, pingStyle: "push" as const, pingPreviewLength: 150 };

// ── Relative time ─────────────────────────────────────────────────────────

test("formatRelativeTime: seconds, minutes, hours", () => {
  assert.equal(formatRelativeTime(NOW - 5_000, NOW), "5s ago");
  assert.equal(formatRelativeTime(NOW - 90_000, NOW), "2m ago");
  assert.equal(formatRelativeTime(NOW - 9_000_000, NOW), "2.5h ago");
});

test("formatRelativeTime: clamps negative deltas to 0", () => {
  // future timestamp shouldn't yield negative-time formatting
  assert.equal(formatRelativeTime(NOW + 5_000, NOW), "0s ago");
});

// ── Single events ─────────────────────────────────────────────────────────

test("single channel message: collapses to one-liner", () => {
  const out = formatBatch([buf({ author: "alice", content: "hi" }, 5)], optsFollowUp);
  assert.equal(out, "[Test Server / #general] alice (5s ago): hi");
});

test("single push ping: short content, no truncation tail", () => {
  const out = formatBatch(
    [buf({ author: "alice", content: "hey", mentions_bot: true }, 3, "ping")],
    optsPush,
  );
  assert.match(out, /\[ping\] alice \(3s ago\) in Test Server \/ #general: "hey"/);
  assert.doesNotMatch(out, /full via/);
});

test("single push ping: long content, truncated with pointer", () => {
  const long = "x".repeat(300);
  const out = formatBatch(
    [buf({ author: "alice", content: long, mentions_bot: true }, 3, "ping")],
    { ...optsPush, pingPreviewLength: 50 },
  );
  assert.match(out, /…/);
  assert.match(out, /300 chars; full via `disclaw-ctl history C-100/);
});

test("single follow_up ping: full content in dedicated block", () => {
  const out = formatBatch(
    [buf({ author: "alice", content: "can you take a look?", mentions_bot: true }, 3, "ping")],
    optsFollowUp,
  );
  assert.match(out, /\[ping\] alice \(3s ago\) mentioned you in Test Server \/ #general:/);
  assert.match(out, /can you take a look\?/);
});

test("single DM ping: marked as DM not channel", () => {
  const out = formatBatch(
    [buf({ author: "alice", is_dm: true, channel: "DM-with-alice", mentions_bot: true }, 3, "ping")],
    optsFollowUp,
  );
  assert.match(out, /\[ping\] alice \(3s ago\) mentioned you in DM:/);
  assert.doesNotMatch(out, /#DM/);
});

// ── Multi-event batches ───────────────────────────────────────────────────

test("multiple channel events same channel: header + per-line", () => {
  const out = formatBatch(
    [
      buf({ author: "alice", content: "hey opus, around?" }, 240),
      buf({ author: "bob", content: "I think they're afk" }, 180),
      buf({ author: "alice", content: "👋" }, 12),
    ],
    optsFollowUp,
  );
  assert.match(out, /\[Test Server \/ #general — last activity 12s ago\]/);
  assert.match(out, /alice \(4m ago\): hey opus, around\?/);
  assert.match(out, /bob \(3m ago\): I think they're afk/);
  assert.match(out, /alice \(12s ago\): 👋/);
  // ensure ordering: header first, then events as added
  const lines = out.split("\n");
  assert.match(lines[0]!, /last activity 12s ago/);
});

test("multiple channels: separate sections, sorted by last activity", () => {
  const out = formatBatch(
    [
      buf({ channel_id: "C-A", channel: "general", author: "alice", content: "morning" }, 120),
      buf({ channel_id: "C-B", channel: "off-topic", author: "bob", content: "anyone seen..." }, 30),
      buf({ channel_id: "C-A", channel: "general", author: "charlie", content: "hey" }, 60),
    ],
    optsFollowUp,
  );
  // C-A has last activity 60s ago, C-B has 30s ago. C-A should come first (older).
  const idxA = out.indexOf("#general");
  const idxB = out.indexOf("#off-topic");
  assert.ok(idxA < idxB, "older-channel section should appear before newer");
});

test("ping + channel mixed: ping section comes first", () => {
  const out = formatBatch(
    [
      buf({ author: "bob", content: "ambient" }, 30),
      buf({ author: "alice", content: "@mention me", mentions_bot: true }, 5, "ping"),
    ],
    optsFollowUp,
  );
  const pingIdx = out.indexOf("[ping]");
  const channelIdx = out.indexOf("[Test Server / #general]");
  assert.ok(pingIdx >= 0 && channelIdx >= 0);
  assert.ok(pingIdx < channelIdx, "ping section should come before channel section");
});

test("multiple push pings: combined into one section", () => {
  const out = formatBatch(
    [
      buf({ author: "alice", content: "first", mentions_bot: true }, 3, "ping"),
      buf({ author: "bob", content: "second", mentions_bot: true }, 1, "ping"),
    ],
    optsPush,
  );
  assert.match(out, /\[ping\] alice/);
  assert.match(out, /\[ping\] bob/);
  // both on consecutive lines, no blank line between (push is compact)
  const aliceIdx = out.indexOf("[ping] alice");
  const bobIdx = out.indexOf("[ping] bob");
  const between = out.slice(aliceIdx, bobIdx);
  assert.equal(between.split("\n").length, 2, "push pings should be on consecutive lines");
});

test("empty batch: empty string", () => {
  assert.equal(formatBatch([], optsFollowUp), "");
});

// ── Wrap helper ───────────────────────────────────────────────────────────

test("wrapDisclaw wraps body in <disclaw>...</disclaw>", () => {
  assert.equal(wrapDisclaw("hi"), "<disclaw>\nhi\n</disclaw>");
});
