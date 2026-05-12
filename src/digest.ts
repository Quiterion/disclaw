/**
 * Activity digest — counts of unsubscribed-channel messages since last
 * flush, modeled on Discord's sidebar unread indicators.
 *
 * The accumulator only sees events the daemon explicitly notes (via
 * `note()` after routing decides "drop, unsubscribed channel, no
 * mention"). It has no own buffer or flush trigger: digest content
 * piggybacks on whatever flush fires (follow_up / push / prompt /
 * nudge). On flush, the consumer either `drain()`s (resets) or
 * `peek()`s (no reset, used by `disclaw-ctl digest` for on-demand
 * inspection).
 *
 * What we count: any non-mention message in an unsubscribed channel,
 * authored by anyone other than the bot itself (the bot-self filter
 * happens upstream in routing). Subscribed channels and pings never
 * appear in the digest — they're delivered through their own paths and
 * counting them would be redundant or duplicative.
 */
import type { DiscliMessageEvent } from "./routing.js";

export interface DigestEntry {
  channel_id: string;
  channel: string;
  /** Server name if known (DMs have no server). */
  server: string | undefined;
  count: number;
  /** ms timestamp of the most recent counted message (used for sort order). */
  last_activity_ms: number;
}

export class DigestAccumulator {
  private entries: Map<string, DigestEntry> = new Map();

  note(ev: DiscliMessageEvent, arrivedAt: number = Date.now()): void {
    const existing = this.entries.get(ev.channel_id);
    if (existing) {
      existing.count += 1;
      existing.last_activity_ms = arrivedAt;
    } else {
      this.entries.set(ev.channel_id, {
        channel_id: ev.channel_id,
        channel: ev.channel,
        server: ev.server,
        count: 1,
        last_activity_ms: arrivedAt,
      });
    }
  }

  /** Inspect without resetting. Returns entries sorted by recency (newest first). */
  peek(): DigestEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => b.last_activity_ms - a.last_activity_ms,
    );
  }

  /** Drain (reset) and return the entries that were present. */
  drain(): DigestEntry[] {
    const out = this.peek();
    this.entries.clear();
    return out;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }
}

/**
 * Format the digest tail line. Returns null if there's nothing to say.
 *
 * Compact one-liner per the design doc:
 *   "[activity] #help: 3 msgs, #random: 12 msgs since you last checked"
 *
 * If multiple servers are involved we qualify each entry; same-server
 * batches stay compact.
 */
export function formatDigest(entries: DigestEntry[]): string | null {
  if (entries.length === 0) return null;
  const servers = new Set(entries.map((e) => e.server ?? "(DM)"));
  const qualify = servers.size > 1;
  const parts = entries.map((e) => {
    const channelLabel = qualify && e.server ? `${e.server} / #${e.channel}` : `#${e.channel}`;
    return `${channelLabel}: ${e.count} ${e.count === 1 ? "msg" : "msgs"}`;
  });
  return `[activity] ${parts.join(", ")} since you last checked`;
}
