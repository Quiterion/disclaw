/**
 * Discord-event routing — pure logic, easy to test without an LLM.
 *
 * Takes a discli `message` event + the daemon's state, returns a
 * routing decision: drop, or deliver-via-mode with a formatted user
 * message string. The daemon translates "deliver-via-mode" into the
 * appropriate AgentHost call (prompt/followUp/steer) based on whether
 * the agent is currently idle.
 *
 * Slice 3 routing matrix:
 *   - mention/DM (any channel)         → ping path (mode = ping_mode)
 *   - message in subscribed channel    → channel stream (mode = follow_up)
 *   - message in unsubscribed channel  → drop
 *
 * Activity digest, sleep state, and per-event-class push debounce are
 * deferred to later slices.
 */
import type { PingMode } from "./protocol.js";

/**
 * Subset of discli's `message` event we depend on. Keeping this narrow
 * lets us test routing with synthetic events that don't have to mirror
 * discli's full schema.
 */
export interface DiscliMessageEvent {
  event: "message";
  message_id: string;
  channel_id: string;
  channel: string;
  server?: string;
  server_id?: string;
  author: string;
  author_id: string;
  content: string;
  is_bot: boolean;
  mentions_bot: boolean;
  is_dm: boolean;
  timestamp: string; // ISO 8601
}

export interface RoutingState {
  subscriptions: ReadonlySet<string>;
  ping_mode: PingMode;
}

export type RoutingDecision =
  | { kind: "drop"; reason: string }
  | {
      kind: "deliver";
      class: "ping" | "channel";
      mode: "push" | "follow_up";
      userMessage: string;
    };

/** Format a single Discord message as a user-message string for the agent. */
export function formatChannelMessage(ev: DiscliMessageEvent): string {
  const where = ev.server ? `${ev.server} / #${ev.channel}` : `#${ev.channel}`;
  return `[${where}] ${ev.author}: ${ev.content}`;
}

export function formatPingFollowUp(ev: DiscliMessageEvent): string {
  const where = ev.is_dm ? "DM" : `#${ev.channel}` + (ev.server ? ` (${ev.server})` : "");
  return `[ping] ${ev.author} mentioned you in ${where}:\n${ev.content}`;
}

export function formatPingPush(ev: DiscliMessageEvent, previewLength = 150): string {
  const where = ev.is_dm ? "DM" : `#${ev.channel}` + (ev.server ? ` (${ev.server})` : "");
  const trimmed = ev.content.length > previewLength
    ? ev.content.slice(0, previewLength) + "…"
    : ev.content;
  const tail = ev.content.length > previewLength
    ? ` (${ev.content.length} chars; full via \`disclaw-ctl history ${ev.channel_id} --from ${ev.timestamp}\`)`
    : "";
  return `[ping] ${ev.author} in ${where}: "${trimmed}"${tail}`;
}

/**
 * Decide what to do with an incoming Discord message.
 *
 * Notes:
 *   - Bot-authored messages are NOT filtered. In Anima-shaped servers,
 *     other LLM agents are bot accounts; filtering by is_bot would hide
 *     most of what's interesting to lurk on.
 *   - The agent sending its own messages is a separate concern: discli
 *     can be configured with --no-include-self at the spawn-args level
 *     if we want to suppress those, but for slice 3 we leave it on.
 */
export function routeDiscordEvent(
  ev: DiscliMessageEvent,
  state: RoutingState,
): RoutingDecision {
  const isPing = ev.mentions_bot || ev.is_dm;

  if (isPing) {
    if (state.ping_mode === "none") {
      return { kind: "drop", reason: "ping-mode is none (logged elsewhere)" };
    }
    if (state.ping_mode === "push") {
      return {
        kind: "deliver",
        class: "ping",
        mode: "push",
        userMessage: formatPingPush(ev),
      };
    }
    // follow_up
    return {
      kind: "deliver",
      class: "ping",
      mode: "follow_up",
      userMessage: formatPingFollowUp(ev),
    };
  }

  // Non-ping: deliver only if subscribed
  if (state.subscriptions.has(ev.channel_id)) {
    return {
      kind: "deliver",
      class: "channel",
      mode: "follow_up",
      userMessage: formatChannelMessage(ev),
    };
  }

  return { kind: "drop", reason: "unsubscribed channel, no mention" };
}
