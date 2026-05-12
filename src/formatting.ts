/**
 * Formatting layer for buffered Discord events.
 *
 * Pure functions. Take a batch of events + the current time, return a
 * user-message body string. `wrapDisclaw` then wraps in
 * `<disclaw>...</disclaw>` with a `<time>` opener carrying the
 * delivery wall-clock.
 *
 * Why wall-clock instead of relative ("Xs ago"):
 *   Relative time is correct at the moment of delivery but rots —
 *   reading turn N+20 in the transcript, "5s ago" still says 5s ago
 *   even though the event is 47 minutes old. Wall-clock anchors the
 *   timing to a specific point that stays correct forever.
 *
 * Why `(uid:<id>)` next to author name:
 *   Inbound mention syntax is humanized to `@name` (discli patch), but
 *   to *send* a mention the agent needs the wire form `<@user_id>`.
 *   Surfacing the uid here means the agent has it in front of them
 *   without an extra `disclaw-ctl history` round-trip.
 *
 * Design notes (from docs/dev/disclaw.md "Message format"):
 *   - Pings are emphasized; they appear before channel content in a batch
 *   - Channel content is grouped per channel (all events from #foo together)
 *   - Channel groups are sorted by recency (oldest at top, newest at bottom)
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" in local 24h format. */
export function formatWallTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DD HH:MM" in local 24h. Used by `<time>` opener tag. */
export function formatTimeOpener(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatWallTime(ms)}`;
}

/**
 * Wrap a body in `<disclaw>...</disclaw>` with a `<time>` opener.
 * `now` defaults to `Date.now()`; tests pass a fixed value.
 */
export function wrapDisclaw(body: string, now: number = Date.now()): string {
  return `<disclaw>\n<time>${formatTimeOpener(now)}</time>\n${body}\n</disclaw>`;
}

/**
 * XML attribute escaping. Discord names rarely contain `"` / `<` / `>` /
 * `&`, but cheap defense beats malformed wraps.
 */
function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the location attributes for a `<ping>` (DMs vs guild channels
 * differ — DM gets `dm="true"` and no server/channel).
 */
function pingLocationAttrs(ev: DiscliMessageEvent): string {
  if (ev.is_dm) return ` dm="true"`;
  const parts: string[] = [];
  if (ev.server) parts.push(`server="${xmlAttr(ev.server)}"`);
  parts.push(`channel="#${xmlAttr(ev.channel)}"`);
  return ` ${parts.join(" ")}`;
}

function formatPingPush(e: BufferedEvent, previewLength: number): string {
  const trimmed =
    e.ev.content.length > previewLength
      ? e.ev.content.slice(0, previewLength) + "…"
      : e.ev.content;
  const tail =
    e.ev.content.length > previewLength
      ? `\n(${e.ev.content.length} chars; full via \`disclaw-ctl history ${e.ev.channel_id} --from ${e.ev.timestamp}\`)`
      : "";
  return (
    `<ping author="${xmlAttr(e.ev.author)}" uid="${e.ev.author_id}"` +
    pingLocationAttrs(e.ev) +
    ` at="${formatWallTime(e.arrivedAt)}">\n` +
    `${trimmed}${tail}\n</ping>`
  );
}

function formatPingFollowUp(e: BufferedEvent): string {
  return (
    `<ping author="${xmlAttr(e.ev.author)}" uid="${e.ev.author_id}"` +
    pingLocationAttrs(e.ev) +
    ` at="${formatWallTime(e.arrivedAt)}">\n` +
    `${e.ev.content}\n</ping>`
  );
}

/** A single line within a `<channel>` block. No uid here — agent uses `whois`. */
function formatChannelLine(e: BufferedEvent): string {
  return `${e.ev.author} (${formatWallTime(e.arrivedAt)}): ${e.ev.content}`;
}

function channelOpenTag(ev: DiscliMessageEvent): string {
  const parts: string[] = [];
  if (ev.server) parts.push(`server="${xmlAttr(ev.server)}"`);
  parts.push(`name="#${xmlAttr(ev.channel)}"`);
  return `<channel ${parts.join(" ")}>`;
}

export interface FormatBatchOptions {
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

  // Pings first — each in its own <ping> tag (parser-unambiguous,
  // metadata in attributes, content as text).
  if (pings.length > 0) {
    const fmt = opts.pingStyle === "push" ? (p: BufferedEvent) => formatPingPush(p, opts.pingPreviewLength) : formatPingFollowUp;
    sections.push(pings.map(fmt).join("\n\n"));
  }

  // Channel events: group by channel_id, then sort groups by last activity (oldest first).
  // Each group becomes a <channel server name> tag. Per-line author/time
  // inside; uid is dropped (agent uses `whois` if they want to ping).
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
    const open = channelOpenTag(first.ev);
    const lines = group.map((e) => formatChannelLine(e));
    sections.push([open, ...lines, "</channel>"].join("\n"));
  }

  return sections.join("\n\n");
}
