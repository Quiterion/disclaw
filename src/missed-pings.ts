/**
 * Missed-pings log — append-only JSONL of pings dropped because
 * `ping_mode === "none"`.
 *
 * Without this, ping-mode=none is silently lossy: the agent has no way
 * to know "someone tried to reach me while I had pings muted." The log
 * gives them a way to review on demand (`disclaw-ctl missed-pings`)
 * without forcing the interruption a ping would have caused.
 *
 * Format: one JSON object per line, append-only. No rotation in v1 —
 * if the log grows large, the agent can `disclaw-ctl missed-pings
 * clear` to drop everything. Per-event records carry enough to
 * reconstruct context: timestamps, channel + server names + IDs, author
 * + ID, message ID (for jump-URL or history fetch), and the content.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DiscliMessageEvent } from "./routing.js";

export interface MissedPingRecord {
  /** ISO 8601 — when the daemon recorded the drop. */
  recorded_at: string;
  /** Discord's own timestamp for the message. */
  message_timestamp: string;
  message_id: string;
  channel_id: string;
  channel: string;
  server: string | undefined;
  server_id: string | undefined;
  author: string;
  author_id: string;
  content: string;
  is_dm: boolean;
}

export function recordMissedPing(file: string, ev: DiscliMessageEvent, recordedAt: Date = new Date()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const record: MissedPingRecord = {
    recorded_at: recordedAt.toISOString(),
    message_timestamp: ev.timestamp,
    message_id: ev.message_id,
    channel_id: ev.channel_id,
    channel: ev.channel,
    server: ev.server,
    server_id: ev.server_id,
    author: ev.author,
    author_id: ev.author_id,
    content: ev.content,
    is_dm: ev.is_dm,
  };
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function readMissedPings(file: string): MissedPingRecord[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const out: MissedPingRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip corrupt lines rather than failing the whole read — the
      // log is best-effort, and the alternative is the agent losing
      // access to the entire history because of one bad line.
    }
  }
  return out;
}

export function clearMissedPings(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}
