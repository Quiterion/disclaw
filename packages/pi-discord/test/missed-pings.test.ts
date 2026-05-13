/**
 * Missed-pings log tests — pure I/O, no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMissedPing, readMissedPings, clearMissedPings } from "../src/missed-pings.js";
import type { DiscliMessageEvent } from "../src/routing.js";

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
    content: "hey opus, around?",
    is_bot: false,
    mentions_bot: true,
    is_dm: false,
    timestamp: "2026-05-12T08:00:00Z",
    ...overrides,
  };
}

function freshFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-discord-missed-pings-test-"));
  return join(dir, "missed-pings.log");
}

test("readMissedPings: nonexistent file returns empty array", () => {
  const file = freshFile();
  assert.deepEqual(readMissedPings(file), []);
});

test("recordMissedPing + readMissedPings: roundtrip preserves fields", () => {
  const file = freshFile();
  const recordedAt = new Date("2026-05-12T09:00:00Z");
  recordMissedPing(file, ev(), recordedAt);
  const all = readMissedPings(file);
  assert.equal(all.length, 1);
  const r = all[0]!;
  assert.equal(r.recorded_at, "2026-05-12T09:00:00.000Z");
  assert.equal(r.message_id, "msg-1");
  assert.equal(r.channel, "general");
  assert.equal(r.server, "Test Server");
  assert.equal(r.author, "alice");
  assert.equal(r.content, "hey opus, around?");
  assert.equal(r.is_dm, false);
  rmSync(file);
});

test("recordMissedPing: appends in order across multiple calls", () => {
  const file = freshFile();
  recordMissedPing(file, ev({ message_id: "m1", content: "first" }));
  recordMissedPing(file, ev({ message_id: "m2", content: "second" }));
  recordMissedPing(file, ev({ message_id: "m3", content: "third" }));
  const all = readMissedPings(file);
  assert.deepEqual(
    all.map((r) => r.message_id),
    ["m1", "m2", "m3"],
  );
  rmSync(file);
});

test("readMissedPings: skips corrupt lines without aborting", () => {
  const file = freshFile();
  recordMissedPing(file, ev({ message_id: "good1" }));
  // Append a corrupt line directly
  appendFileSync(file, "this is not json\n");
  recordMissedPing(file, ev({ message_id: "good2" }));
  const all = readMissedPings(file);
  assert.deepEqual(
    all.map((r) => r.message_id),
    ["good1", "good2"],
  );
  rmSync(file);
});

test("clearMissedPings: removes the file; idempotent", () => {
  const file = freshFile();
  recordMissedPing(file, ev());
  assert.equal(existsSync(file), true);
  clearMissedPings(file);
  assert.equal(existsSync(file), false);
  // Second clear does not throw
  clearMissedPings(file);
});

test("DM ping: is_dm preserved in the record", () => {
  const file = freshFile();
  recordMissedPing(file, ev({ is_dm: true, channel: "DM-with-alice", server: undefined }));
  const all = readMissedPings(file);
  assert.equal(all[0]!.is_dm, true);
  assert.equal(all[0]!.server, undefined);
  rmSync(file);
});
