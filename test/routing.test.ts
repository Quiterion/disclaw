/**
 * Routing logic tests — no LLM, no daemon, no Discord. Pure functions.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeDiscordEvent, type DiscliMessageEvent, type RoutingState } from "../src/routing.js";

function makeEvent(overrides: Partial<DiscliMessageEvent> = {}): DiscliMessageEvent {
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
    timestamp: "2026-05-12T00:00:00Z",
    ...overrides,
  };
}

function makeState(overrides: Partial<RoutingState> = {}): RoutingState {
  return {
    subscriptions: new Set(),
    ping_mode: "none",
    ...overrides,
  };
}

// ── Drop cases ──────────────────────────────────────────────────────────

test("non-mention in unsubscribed channel: drop", () => {
  const decision = routeDiscordEvent(makeEvent(), makeState());
  assert.equal(decision.kind, "drop");
});

test("ping with ping-mode=none: drop", () => {
  const decision = routeDiscordEvent(
    makeEvent({ mentions_bot: true }),
    makeState({ ping_mode: "none" }),
  );
  assert.equal(decision.kind, "drop");
});

// ── Subscribed channel ──────────────────────────────────────────────────

test("non-mention in subscribed channel: follow_up channel delivery", () => {
  const decision = routeDiscordEvent(
    makeEvent(),
    makeState({ subscriptions: new Set(["C-100"]) }),
  );
  assert.equal(decision.kind, "deliver");
  if (decision.kind !== "deliver") return;
  assert.equal(decision.class, "channel");
  assert.equal(decision.mode, "follow_up");
});

// ── Pings ───────────────────────────────────────────────────────────────

test("mention with ping-mode=push: classifies as push", () => {
  const decision = routeDiscordEvent(
    makeEvent({ mentions_bot: true }),
    makeState({ ping_mode: "push" }),
  );
  assert.equal(decision.kind, "deliver");
  if (decision.kind !== "deliver") return;
  assert.equal(decision.class, "ping");
  assert.equal(decision.mode, "push");
});

test("mention with ping-mode=follow_up: classifies as follow_up", () => {
  const decision = routeDiscordEvent(
    makeEvent({ mentions_bot: true }),
    makeState({ ping_mode: "follow_up" }),
  );
  assert.equal(decision.kind, "deliver");
  if (decision.kind !== "deliver") return;
  assert.equal(decision.class, "ping");
  assert.equal(decision.mode, "follow_up");
});

test("DM: routes through ping path regardless of subscriptions", () => {
  const decision = routeDiscordEvent(
    makeEvent({ is_dm: true, channel: "DM-with-alice" }),
    makeState({ ping_mode: "follow_up" }),
  );
  assert.equal(decision.kind, "deliver");
  if (decision.kind !== "deliver") return;
  assert.equal(decision.class, "ping");
});

// ── Pings on subscribed channels: still ping path ───────────────────────

test("mention in subscribed channel: still routes as ping (not channel stream)", () => {
  const decision = routeDiscordEvent(
    makeEvent({ mentions_bot: true }),
    makeState({
      subscriptions: new Set(["C-100"]),
      ping_mode: "follow_up",
    }),
  );
  assert.equal(decision.kind, "deliver");
  if (decision.kind !== "deliver") return;
  assert.equal(decision.class, "ping");
});

// ── Bot-authored messages: NOT filtered ─────────────────────────────────

test("other-bot-authored message in subscribed channel: delivered (not filtered)", () => {
  const decision = routeDiscordEvent(
    makeEvent({ is_bot: true, author: "OtherBot", author_id: "U-other-bot" }),
    makeState({ subscriptions: new Set(["C-100"]), bot_id: "U-self" }),
  );
  assert.equal(decision.kind, "deliver");
});

test("self-authored message: dropped regardless of channel/mention", () => {
  // Self in subscribed channel
  let d = routeDiscordEvent(
    makeEvent({ author_id: "U-self" }),
    makeState({ subscriptions: new Set(["C-100"]), bot_id: "U-self" }),
  );
  assert.equal(d.kind, "drop");
  if (d.kind !== "drop") return;
  assert.match(d.reason, /self-message/);

  // Self with self-mention (impossible in practice, defensive)
  d = routeDiscordEvent(
    makeEvent({ author_id: "U-self", mentions_bot: true }),
    makeState({ ping_mode: "push", bot_id: "U-self" }),
  );
  assert.equal(d.kind, "drop");
});

test("self-filter requires bot_id; without it, self-messages flow through", () => {
  const d = routeDiscordEvent(
    makeEvent({ author_id: "U-self" }),
    makeState({ subscriptions: new Set(["C-100"]) }), // no bot_id
  );
  assert.equal(d.kind, "deliver");
});
