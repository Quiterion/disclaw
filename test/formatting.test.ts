import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBatch,
  formatTimeOpener,
  formatWallTime,
  wrapDisclaw,
  type BufferedEvent,
} from "../src/formatting.js";
import type { DiscliMessageEvent } from "../src/routing.js";

// Fixed point in time so wall-clock tests are deterministic.
// 2026-05-12 20:54:00 in the test runner's local timezone.
const ANCHOR = new Date(2026, 4, 12, 20, 54, 0).getTime();

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

function bufAt(eventOverrides: Partial<DiscliMessageEvent>, atMs: number, cls: "ping" | "channel" = "channel"): BufferedEvent {
  return {
    ev: ev(eventOverrides),
    class: cls,
    arrivedAt: atMs,
  };
}

const optsFollowUp = { pingStyle: "follow_up" as const, pingPreviewLength: 150 };
const optsPush = { pingStyle: "push" as const, pingPreviewLength: 150 };

// ── Wall-clock helpers ────────────────────────────────────────────────────

test("formatWallTime: zero-pads HH:MM", () => {
  // 09:05 in local time
  assert.equal(formatWallTime(new Date(2026, 4, 12, 9, 5).getTime()), "09:05");
  // midnight
  assert.equal(formatWallTime(new Date(2026, 4, 12, 0, 0).getTime()), "00:00");
  // late evening (24h, no am/pm)
  assert.equal(formatWallTime(new Date(2026, 4, 12, 23, 59).getTime()), "23:59");
});

test("formatTimeOpener: YYYY-MM-DD HH:MM in local time", () => {
  assert.equal(
    formatTimeOpener(new Date(2026, 4, 12, 20, 54).getTime()),
    "2026-05-12 20:54",
  );
  assert.equal(
    formatTimeOpener(new Date(2026, 0, 1, 0, 0).getTime()),
    "2026-01-01 00:00",
  );
});

// ── Single events ─────────────────────────────────────────────────────────

test("single channel message: collapses to one-liner with wall time + uid", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", content: "hi" }, ANCHOR)],
    optsFollowUp,
  );
  assert.equal(out, "[Test Server / #general] alice (20:54) (uid:U-alice): hi");
});

test("single push ping: short content, no truncation tail", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", content: "hey", mentions_bot: true }, ANCHOR, "ping")],
    optsPush,
  );
  assert.match(out, /\[ping\] alice \(20:54\) \(uid:U-alice\) in Test Server \/ #general: "hey"/);
  assert.doesNotMatch(out, /full via/);
});

test("single push ping: long content, truncated with pointer", () => {
  const long = "x".repeat(300);
  const out = formatBatch(
    [bufAt({ author: "alice", content: long, mentions_bot: true }, ANCHOR, "ping")],
    { ...optsPush, pingPreviewLength: 50 },
  );
  assert.match(out, /…/);
  assert.match(out, /300 chars; full via `disclaw-ctl history C-100/);
});

test("single follow_up ping: full content in dedicated block", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", content: "can you take a look?", mentions_bot: true }, ANCHOR, "ping")],
    optsFollowUp,
  );
  assert.match(out, /\[ping\] alice \(20:54\) \(uid:U-alice\) mentioned you in Test Server \/ #general:/);
  assert.match(out, /can you take a look\?/);
});

test("single DM ping: marked as DM not channel", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", is_dm: true, channel: "DM-with-alice", mentions_bot: true }, ANCHOR, "ping")],
    optsFollowUp,
  );
  assert.match(out, /\[ping\] alice \(20:54\) \(uid:U-alice\) mentioned you in DM:/);
  assert.doesNotMatch(out, /#DM/);
});

// ── Multi-event batches ───────────────────────────────────────────────────

test("multiple channel events same channel: header + per-line wall times, no 'last activity'", () => {
  const t0 = new Date(2026, 4, 12, 20, 50).getTime();
  const t1 = new Date(2026, 4, 12, 20, 51).getTime();
  const t2 = new Date(2026, 4, 12, 20, 54).getTime();
  const out = formatBatch(
    [
      bufAt({ author: "alice", author_id: "U-alice", content: "hey opus, around?" }, t0),
      bufAt({ author: "bob", author_id: "U-bob", content: "I think they're afk" }, t1),
      bufAt({ author: "alice", author_id: "U-alice", content: "👋" }, t2),
    ],
    optsFollowUp,
  );
  // Header is bare — no "last activity X ago" annotation
  assert.match(out, /\[Test Server \/ #general\]/);
  assert.doesNotMatch(out, /last activity/);
  // Per-line wall times + uids
  assert.match(out, /alice \(20:50\) \(uid:U-alice\): hey opus, around\?/);
  assert.match(out, /bob \(20:51\) \(uid:U-bob\): I think they're afk/);
  assert.match(out, /alice \(20:54\) \(uid:U-alice\): 👋/);
  // Header first
  assert.match(out.split("\n")[0]!, /\[Test Server \/ #general\]/);
});

test("multiple channels: separate sections, sorted by last activity", () => {
  const aOlder = new Date(2026, 4, 12, 20, 53).getTime();
  const aNewer = new Date(2026, 4, 12, 20, 54).getTime();
  const bNewer = new Date(2026, 4, 12, 20, 54, 30).getTime(); // C-B last activity > C-A
  const out = formatBatch(
    [
      bufAt({ channel_id: "C-A", channel: "general", author: "alice", content: "morning" }, aOlder),
      bufAt({ channel_id: "C-B", channel: "off-topic", author: "bob", content: "anyone seen..." }, bNewer),
      bufAt({ channel_id: "C-A", channel: "general", author: "charlie", content: "hey" }, aNewer),
    ],
    optsFollowUp,
  );
  // C-A's last activity is older than C-B's — C-A section should come first
  const idxA = out.indexOf("#general");
  const idxB = out.indexOf("#off-topic");
  assert.ok(idxA < idxB, "older-channel section should appear before newer");
});

test("ping + channel mixed: ping section comes first", () => {
  const out = formatBatch(
    [
      bufAt({ author: "bob", content: "ambient" }, ANCHOR),
      bufAt({ author: "alice", content: "@mention me", mentions_bot: true }, ANCHOR, "ping"),
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
      bufAt({ author: "alice", content: "first", mentions_bot: true }, ANCHOR, "ping"),
      bufAt({ author: "bob", content: "second", mentions_bot: true }, ANCHOR, "ping"),
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

test("wrapDisclaw: opens with <time> tag carrying YYYY-MM-DD HH:MM", () => {
  assert.equal(
    wrapDisclaw("hi", ANCHOR),
    "<disclaw>\n<time>2026-05-12 20:54</time>\nhi\n</disclaw>",
  );
});

test("wrapDisclaw: defaults `now` to Date.now() when omitted", () => {
  // We can't pin exact wall time, but the output must start with the
  // expected opener structure.
  const out = wrapDisclaw("hi");
  assert.match(out, /^<disclaw>\n<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>\nhi\n<\/disclaw>$/);
});
