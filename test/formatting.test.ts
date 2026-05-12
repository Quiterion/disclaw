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
  assert.equal(formatWallTime(new Date(2026, 4, 12, 9, 5).getTime()), "09:05");
  assert.equal(formatWallTime(new Date(2026, 4, 12, 0, 0).getTime()), "00:00");
  assert.equal(formatWallTime(new Date(2026, 4, 12, 23, 59).getTime()), "23:59");
});

test("formatTimeOpener: YYYY-MM-DD HH:MM in local time", () => {
  assert.equal(
    formatTimeOpener(new Date(2026, 4, 12, 20, 54).getTime()),
    "2026-05-12 20:54",
  );
});

// ── Channel sections (XML-wrapped) ────────────────────────────────────────

test("single channel message: wrapped in <channel> with server/name attrs, no uid per line", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", content: "hi" }, ANCHOR)],
    optsFollowUp,
  );
  assert.equal(
    out,
    `<channel server="Test Server" name="#general">\nalice (20:54): hi\n</channel>`,
  );
  // No uid leaked in the per-line form
  assert.doesNotMatch(out, /uid:/);
});

test("multi-message channel batch: open tag, lines, close tag — no 'last activity' annotation", () => {
  const t0 = new Date(2026, 4, 12, 20, 50).getTime();
  const t1 = new Date(2026, 4, 12, 20, 51).getTime();
  const t2 = new Date(2026, 4, 12, 20, 54).getTime();
  const out = formatBatch(
    [
      bufAt({ author: "alice", content: "hey opus, around?" }, t0),
      bufAt({ author: "bob", content: "I think they're afk" }, t1),
      bufAt({ author: "alice", content: "👋" }, t2),
    ],
    optsFollowUp,
  );
  assert.match(out, /^<channel server="Test Server" name="#general">/);
  assert.match(out, /alice \(20:50\): hey opus, around\?/);
  assert.match(out, /bob \(20:51\): I think they're afk/);
  assert.match(out, /alice \(20:54\): 👋/);
  assert.match(out, /<\/channel>$/);
  assert.doesNotMatch(out, /last activity/);
});

test("multiple channels: each in its own <channel>, sorted by last activity", () => {
  const aOlder = new Date(2026, 4, 12, 20, 53).getTime();
  const aNewer = new Date(2026, 4, 12, 20, 54).getTime();
  const bNewer = new Date(2026, 4, 12, 20, 54, 30).getTime();
  const out = formatBatch(
    [
      bufAt({ channel_id: "C-A", channel: "general", author: "alice", content: "morning" }, aOlder),
      bufAt({ channel_id: "C-B", channel: "off-topic", author: "bob", content: "anyone seen..." }, bNewer),
      bufAt({ channel_id: "C-A", channel: "general", author: "charlie", content: "hey" }, aNewer),
    ],
    optsFollowUp,
  );
  // Two distinct <channel> blocks
  const channelOpens = out.match(/<channel /g) ?? [];
  assert.equal(channelOpens.length, 2);
  // Ordering: #general (older last-activity) before #off-topic
  const idxA = out.indexOf(`name="#general"`);
  const idxB = out.indexOf(`name="#off-topic"`);
  assert.ok(idxA >= 0 && idxB >= 0);
  assert.ok(idxA < idxB);
});

// ── Pings (XML-wrapped) ───────────────────────────────────────────────────

test("single push ping: <ping> with author/uid/server/channel/at attrs", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", content: "hey", mentions_bot: true }, ANCHOR, "ping")],
    optsPush,
  );
  assert.match(out, /<ping author="alice" uid="U-alice" server="Test Server" channel="#general" at="20:54" id="msg-1">/);
  assert.match(out, /\nhey\n/);
  assert.match(out, /<\/ping>$/);
  assert.doesNotMatch(out, /full via/);
});

test("single push ping: long content, truncated with pointer line", () => {
  const long = "x".repeat(300);
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", content: long, mentions_bot: true }, ANCHOR, "ping")],
    { ...optsPush, pingPreviewLength: 50 },
  );
  assert.match(out, /^<ping /);
  assert.match(out, /…/);
  assert.match(out, /300 chars; full via `disclaw-ctl history C-100/);
  assert.match(out, /<\/ping>$/);
});

test("single follow_up ping: full content inside <ping>", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", content: "can you take a look?", mentions_bot: true }, ANCHOR, "ping")],
    optsFollowUp,
  );
  assert.match(out, /<ping author="alice" uid="U-alice" server="Test Server" channel="#general" at="20:54" id="msg-1">/);
  assert.match(out, /can you take a look\?/);
});

test("DM ping: dm=\"true\" attribute, no server/channel attrs", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", author_id: "U-alice", is_dm: true, channel: "DM-with-alice", mentions_bot: true }, ANCHOR, "ping")],
    optsFollowUp,
  );
  assert.match(out, /<ping author="alice" uid="U-alice" dm="true" at="20:54" id="msg-1">/);
  assert.doesNotMatch(out, /server=/);
  assert.doesNotMatch(out, /channel=/);
});

// ── Mixed batches ─────────────────────────────────────────────────────────

test("ping + channel mixed: ping section comes first", () => {
  const out = formatBatch(
    [
      bufAt({ author: "bob", content: "ambient" }, ANCHOR),
      bufAt({ author: "alice", content: "@mention me", mentions_bot: true }, ANCHOR, "ping"),
    ],
    optsFollowUp,
  );
  const pingIdx = out.indexOf("<ping ");
  const channelIdx = out.indexOf("<channel ");
  assert.ok(pingIdx >= 0 && channelIdx >= 0);
  assert.ok(pingIdx < channelIdx);
});

test("multiple push pings: separated by blank line for readability", () => {
  const out = formatBatch(
    [
      bufAt({ author: "alice", author_id: "U-a", content: "first", mentions_bot: true }, ANCHOR, "ping"),
      bufAt({ author: "bob", author_id: "U-b", content: "second", mentions_bot: true }, ANCHOR, "ping"),
    ],
    optsPush,
  );
  // Two <ping> blocks
  assert.equal((out.match(/<ping /g) ?? []).length, 2);
  // Blank line between them
  assert.match(out, /<\/ping>\n\n<ping /);
});

test("empty batch: empty string", () => {
  assert.equal(formatBatch([], optsFollowUp), "");
});

// ── Attachments ───────────────────────────────────────────────────────────

test("channel msg with one attachment: <attachment> tag on the next line", () => {
  const out = formatBatch(
    [
      bufAt(
        {
          author: "alice",
          content: "check this out",
          attachments: [{ filename: "screen.png", url: "https://cdn/abc.png", size: 12345 }],
        },
        ANCHOR,
      ),
    ],
    optsFollowUp,
  );
  assert.match(out, /alice \(20:54\): check this out\n<attachment filename="screen.png" size="12345" url="https:\/\/cdn\/abc.png"\/>/);
});

test("channel msg with multiple attachments: each on its own line", () => {
  const out = formatBatch(
    [
      bufAt(
        {
          author: "alice",
          content: "few screens",
          attachments: [
            { filename: "a.png", url: "https://cdn/a.png" },
            { filename: "b.png", url: "https://cdn/b.png", size: 999 },
          ],
        },
        ANCHOR,
      ),
    ],
    optsFollowUp,
  );
  assert.match(out, /<attachment filename="a.png" url="https:\/\/cdn\/a.png"\/>\n<attachment filename="b.png" size="999" url="https:\/\/cdn\/b.png"\/>/);
});

test("ping with attachment: tag inside the <ping> body", () => {
  const out = formatBatch(
    [
      bufAt(
        {
          author: "alice",
          author_id: "U-alice",
          content: "look at this",
          mentions_bot: true,
          attachments: [{ filename: "bug.png", url: "https://cdn/bug.png" }],
        },
        ANCHOR,
        "ping",
      ),
    ],
    optsFollowUp,
  );
  assert.match(out, /<ping[^>]*>\nlook at this\n<attachment filename="bug.png" url="https:\/\/cdn\/bug.png"\/>\n<\/ping>/);
});

test("no attachments field: no <attachment> tags emitted", () => {
  const out = formatBatch([bufAt({ author: "alice", content: "hi" }, ANCHOR)], optsFollowUp);
  assert.doesNotMatch(out, /<attachment/);
});

test("empty attachments array: no <attachment> tags emitted", () => {
  const out = formatBatch([bufAt({ author: "alice", content: "hi", attachments: [] }, ANCHOR)], optsFollowUp);
  assert.doesNotMatch(out, /<attachment/);
});

test("attachment filename with special chars: XML-escaped", () => {
  const out = formatBatch(
    [
      bufAt(
        {
          author: "alice",
          content: "weird name",
          attachments: [{ filename: `weird "quoted" & <tag>.png`, url: "https://cdn/x" }],
        },
        ANCHOR,
      ),
    ],
    optsFollowUp,
  );
  assert.match(out, /filename="weird &quot;quoted&quot; &amp; &lt;tag&gt;.png"/);
});

// ── Attribute escaping ────────────────────────────────────────────────────

test("XML attribute escaping: server name with special chars", () => {
  const out = formatBatch(
    [bufAt({ author: "alice", server: `Test "Quoted" & <Server>` }, ANCHOR)],
    optsFollowUp,
  );
  // Quotes, ampersand, and angle brackets escaped in attribute
  assert.match(out, /server="Test &quot;Quoted&quot; &amp; &lt;Server&gt;"/);
});

// ── Wrap helper ───────────────────────────────────────────────────────────

test("wrapDisclaw: opens with <time> tag carrying YYYY-MM-DD HH:MM", () => {
  assert.equal(
    wrapDisclaw("hi", ANCHOR),
    "<disclaw>\n<time>2026-05-12 20:54</time>\nhi\n</disclaw>",
  );
});

test("wrapDisclaw: defaults `now` to Date.now() when omitted", () => {
  const out = wrapDisclaw("hi");
  assert.match(out, /^<disclaw>\n<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>\nhi\n<\/disclaw>$/);
});
