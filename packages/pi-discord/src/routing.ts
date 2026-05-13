/**
 * Discord-event routing — pure logic, easy to test without an LLM.
 *
 * Takes a discli `message` event + the daemon's state, returns a
 * routing *classification*: drop (with reason), or deliver-as-class-X-
 * via-mode-Y. The daemon enqueues delivers into per-mode buffers
 * (src/buffering.ts) which flush to the agent on their own triggers
 * (agent_end for follow_up, debounce for push/prompt). Formatting of
 * the user-message body lives in src/formatting.ts and runs at flush
 * time so relative timestamps are accurate.
 *
 * Routing matrix:
 *   - mention/DM (any channel)         → ping path (mode = ping_mode)
 *   - message in subscribed channel    → channel stream (mode = follow_up)
 *   - message in unsubscribed channel  → drop
 *   - message authored by the bot      → drop (filtered by bot_id)
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
export interface AttachmentInfo {
  filename: string;
  url: string;
  size?: number;
}

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
  /** Discord file attachments (images, files, etc.). Absent or empty if none. */
  attachments?: AttachmentInfo[];
}

export interface RoutingState {
  subscriptions: ReadonlySet<string>;
  ping_mode: PingMode;
  /** The bot's own Discord user_id; messages from this author are dropped. */
  bot_id?: string | null;
}

export type RoutingDecision =
  | { kind: "drop"; reason: string }
  | {
      kind: "deliver";
      class: "ping" | "channel";
      mode: "push" | "follow_up";
    };

/**
 * Decide what to do with an incoming Discord message.
 *
 * Notes:
 *   - Other-bot-authored messages are NOT filtered. In Anima-shaped
 *     servers, other LLM agents are bot accounts; filtering by is_bot
 *     would hide most of what's interesting to lurk on.
 *   - The agent's own messages ARE filtered (see bot_id check) — discli
 *     echoes them back when the bot sends to a subscribed channel, and
 *     letting them through caused misattribution in slice-3 e2e (the
 *     agent treated their own echo as user-mediated confirmation).
 */
export function routeDiscordEvent(
  ev: DiscliMessageEvent,
  state: RoutingState,
): RoutingDecision {
  if (state.bot_id && ev.author_id === state.bot_id) {
    return { kind: "drop", reason: "self-message (bot's own send echoed)" };
  }

  const isPing = ev.mentions_bot || ev.is_dm;

  if (isPing) {
    if (state.ping_mode === "none") {
      return { kind: "drop", reason: "ping-mode is none (logged elsewhere)" };
    }
    return {
      kind: "deliver",
      class: "ping",
      mode: state.ping_mode === "push" ? "push" : "follow_up",
    };
  }

  // Non-ping: deliver only if subscribed
  if (state.subscriptions.has(ev.channel_id)) {
    return { kind: "deliver", class: "channel", mode: "follow_up" };
  }

  return { kind: "drop", reason: "unsubscribed channel, no mention" };
}
