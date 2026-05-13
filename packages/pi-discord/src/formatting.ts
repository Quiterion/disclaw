/**
 * Formatting layer for buffered Discord events.
 *
 * Pure functions. Take a batch of events + the current time, return a
 * user-message body string. `wrapDiscord` then wraps in
 * `<discord>...</discord>` with a `<time>` opener carrying the
 * delivery wall-clock.
 *
 * Why wall-clock instead of relative ("Xs ago"):
 *   Relative time is correct at the moment of delivery but rots —
 *   reading turn N+20 in the transcript, "5s ago" still says 5s ago
 *   even though the event is 47 minutes old. Wall-clock anchors the
 *   timing to a specific point that stays correct forever.
 *
 * Why `uid="..."` next to author name on `<ping>`:
 *   Inbound mention syntax is humanized to `@name` (discli patch), but
 *   to *send* a mention the agent needs the wire form `<@user_id>`.
 *   Surfacing the uid here means the agent has it in front of them
 *   without an extra `pi-discord-ctl history` round-trip.
 *
 * Why each `<channel>` message gets its own `<msg ... id="...">`:
 *   Ambient lines need the Discord message_id available for one-step
 *   reactions; without it, agents who want to react on something they
 *   saw stream past have to fall back to `history` and disambiguate
 *   (and the prior line-style format confused at least one tester
 *   into using an attachment URL's id, which is the file id, not the
 *   message id). The XML wrap also handles multi-line message content
 *   cleanly — the previous line-per-event shape ambiguated on
 *   newline-in-content.
 *
 * Layout:
 *   - Pings are emphasized; they appear before channel content in a batch
 *   - Channel content is grouped per channel (all events from #foo together)
 *   - Channel groups are sorted by recency (oldest at top, newest at bottom)
 *   - Push pings: compact, truncated to pingPreviewLength, with pointer
 *   - Follow-up pings: full content, dedicated framed block
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
 * Wrap a body in `<discord>...</discord>` with a `<time>` opener.
 * `now` defaults to `Date.now()`; tests pass a fixed value.
 */
export function wrapDiscord(body: string, now: number = Date.now()): string {
  return `<discord>\n<time>${formatTimeOpener(now)}</time>\n${body}\n</discord>`;
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

function pingLocationAttrs(ev: DiscliMessageEvent): string {
  if (ev.is_dm) return ` dm="true"`;
  const parts: string[] = [];
  if (ev.server) parts.push(`server="${xmlAttr(ev.server)}"`);
  parts.push(`channel="#${xmlAttr(ev.channel)}"`);
  return ` ${parts.join(" ")}`;
}

function pingOpenTag(e: BufferedEvent): string {
  return (
    `<ping author="${xmlAttr(e.ev.author)}" uid="${e.ev.author_id}"` +
    pingLocationAttrs(e.ev) +
    ` at="${formatWallTime(e.arrivedAt)}" id="${e.ev.message_id}">`
  );
}

function formatPingPush(e: BufferedEvent, previewLength: number): string {
  const trimmed =
    e.ev.content.length > previewLength
      ? e.ev.content.slice(0, previewLength) + "…"
      : e.ev.content;
  const tail =
    e.ev.content.length > previewLength
      ? `\n(${e.ev.content.length} chars; full via \`pi-discord-ctl history ${e.ev.channel_id} --from ${e.ev.timestamp}\`)`
      : "";
  return `${pingOpenTag(e)}\n${trimmed}${tail}${formatAttachments(e.ev)}\n</ping>`;
}

function formatPingFollowUp(e: BufferedEvent): string {
  return `${pingOpenTag(e)}\n${e.ev.content}${formatAttachments(e.ev)}\n</ping>`;
}

function formatAttachments(ev: DiscliMessageEvent): string {
  if (!ev.attachments || ev.attachments.length === 0) return "";
  return (
    "\n" +
    ev.attachments
      .map((a) => {
        const sizeAttr = typeof a.size === "number" ? ` size="${a.size}"` : "";
        return `<attachment filename="${xmlAttr(a.filename)}"${sizeAttr} url="${xmlAttr(a.url)}"/>`;
      })
      .join("\n")
  );
}

/**
 * Render a single message inside a `<channel>` block. Wrapped in
 * `<msg>` with author / wall-clock / message-id attributes so the
 * agent can react/reply without a history round-trip. No uid here —
 * `whois` handles name → id resolution. Attachments hang inside the
 * body the same way they do inside `<ping>`.
 */
function formatChannelMsg(e: BufferedEvent): string {
  const open =
    `<msg author="${xmlAttr(e.ev.author)}"` +
    ` at="${formatWallTime(e.arrivedAt)}" id="${e.ev.message_id}">`;
  return `${open}${e.ev.content}${formatAttachments(e.ev)}</msg>`;
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

  if (pings.length > 0) {
    const fmt = opts.pingStyle === "push" ? (p: BufferedEvent) => formatPingPush(p, opts.pingPreviewLength) : formatPingFollowUp;
    sections.push(pings.map(fmt).join("\n\n"));
  }

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
    const lines = group.map((e) => formatChannelMsg(e));
    sections.push([open, ...lines, "</channel>"].join("\n"));
  }

  return sections.join("\n\n");
}
