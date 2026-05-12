/**
 * Formatting layer for buffered Discord events.
 *
 * Pure functions. Take a batch of events + the current time, return a
 * user-message body string. The daemon wraps the result in
 * `<disclaw>...</disclaw>` and sends via host.prompt/followUp/steer.
 *
 * Design notes (from docs/dev/disclaw.md "Message format"):
 *   - Pings are emphasized; they appear before channel content in a batch
 *   - Channel content is grouped per channel (all events from #foo together)
 *   - Channel groups are sorted by recency (oldest at top, newest at bottom)
 *   - Relative timestamps are computed at flush time, not event capture time
 *   - Push pings: compact, truncated to ping_preview_length, with pointer
 *   - Follow_up pings: full content, dedicated framed block (room to breathe)
 *   - Single-event batches collapse to a one-liner
 */
import type { DiscliMessageEvent } from "./routing.js";

export interface BufferedEvent {
  ev: DiscliMessageEvent;
  class: "ping" | "channel";
  arrivedAt: number; // ms epoch
}

export function wrapDisclaw(body: string): string {
  return `<disclaw>\n${body}\n</disclaw>`;
}

export function formatRelativeTime(arrivedAt: number, now: number): string {
  const ms = Math.max(0, now - arrivedAt);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}

function channelDescriptor(ev: DiscliMessageEvent): string {
  if (ev.is_dm) return "DM";
  return ev.server ? `${ev.server} / #${ev.channel}` : `#${ev.channel}`;
}

function formatPingPushLine(e: BufferedEvent, now: number, previewLength: number): string {
  const where = channelDescriptor(e.ev);
  const trimmed =
    e.ev.content.length > previewLength
      ? e.ev.content.slice(0, previewLength) + "…"
      : e.ev.content;
  const tail =
    e.ev.content.length > previewLength
      ? ` (${e.ev.content.length} chars; full via \`disclaw-ctl history ${e.ev.channel_id} --from ${e.ev.timestamp}\`)`
      : "";
  return `[ping] ${e.ev.author} (${formatRelativeTime(e.arrivedAt, now)}) in ${where}: "${trimmed}"${tail}`;
}

function formatPingFollowUpBlock(e: BufferedEvent, now: number): string {
  const where = channelDescriptor(e.ev);
  return `[ping] ${e.ev.author} (${formatRelativeTime(e.arrivedAt, now)}) mentioned you in ${where}:\n${e.ev.content}`;
}

function formatChannelLine(e: BufferedEvent, now: number): string {
  return `${e.ev.author} (${formatRelativeTime(e.arrivedAt, now)}): ${e.ev.content}`;
}

export interface FormatBatchOptions {
  /** When the flush is firing — relative-time anchor. */
  now: number;
  /** Push mode shows compact ping lines; follow_up shows full content blocks. */
  pingStyle: "push" | "follow_up";
  /** Truncation length for push pings. Ignored in follow_up. */
  pingPreviewLength: number;
}

export function formatBatch(events: BufferedEvent[], opts: FormatBatchOptions): string {
  if (events.length === 0) return "";

  const pings = events.filter((e) => e.class === "ping");
  const channelEvents = events.filter((e) => e.class === "channel");
  const sections: string[] = [];

  // Pings first
  if (pings.length > 0) {
    if (opts.pingStyle === "push") {
      const lines = pings.map((p) => formatPingPushLine(p, opts.now, opts.pingPreviewLength));
      sections.push(lines.join("\n"));
    } else {
      const blocks = pings.map((p) => formatPingFollowUpBlock(p, opts.now));
      sections.push(blocks.join("\n\n"));
    }
  }

  // Channel events: group by channel_id, then sort groups by last activity (oldest first)
  const byChannel = new Map<string, BufferedEvent[]>();
  for (const e of channelEvents) {
    const arr = byChannel.get(e.ev.channel_id) ?? [];
    arr.push(e);
    byChannel.set(e.ev.channel_id, arr);
  }
  const channelGroups = [...byChannel.values()].sort((a, b) => {
    const aLast = Math.max(...a.map((e) => e.arrivedAt));
    const bLast = Math.max(...b.map((e) => e.arrivedAt));
    return aLast - bLast;
  });

  for (const group of channelGroups) {
    const first = group[0]!;
    const desc = channelDescriptor(first.ev);
    if (group.length === 1) {
      sections.push(`[${desc}] ${formatChannelLine(first, opts.now)}`);
    } else {
      const lastActivity = Math.max(...group.map((e) => e.arrivedAt));
      const header = `[${desc} — last activity ${formatRelativeTime(lastActivity, opts.now)}]`;
      const lines = group.map((e) => formatChannelLine(e, opts.now));
      sections.push([header, ...lines].join("\n"));
    }
  }

  return sections.join("\n\n");
}
