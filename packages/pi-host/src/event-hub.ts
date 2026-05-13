/**
 * EventHub — registry of long-lived subscribers + dispatcher for the
 * supervisor's outward event stream.
 *
 * A subscriber is a connected socket that has sent the `subscribe`
 * verb. It receives every event in the host's event-stream until the
 * connection closes (or it sends `unsubscribe`).
 *
 * Event filtering: a subscriber can pass an `events` array to
 * `subscribe` listing the event-name prefixes it wants. A prefix
 * match wins (`"pi:"` matches all `pi:*` events; `"host:sleep_*"`
 * matches by literal prefix). Empty/omitted means everything.
 *
 * Backpressure model: writes to the socket are fire-and-forget. If a
 * subscriber falls behind, Node's stream layer buffers until the
 * socket closes or the OS kills us. We don't queue or coalesce —
 * pi-discord is the only expected subscriber and runs on the same
 * host, so backpressure isn't a real risk. Revisit if multiple
 * subscribers ever land.
 */
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { serializeJsonLine } from "pi-shared/jsonl";
import type { HostEvent } from "./protocol.js";

export interface SubscriberInfo {
  id: string;
  name?: string;
  purpose?: string;
  subscribed: boolean;
  connected_at_ms: number;
  events?: string[]; // prefix filters; undefined = all
}

interface SubscriberEntry extends SubscriberInfo {
  socket: Socket;
}

export class EventHub {
  private subscribers = new Map<string, SubscriberEntry>();
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  register(socket: Socket): string {
    const id = randomUUID();
    this.subscribers.set(id, {
      id,
      socket,
      subscribed: false,
      connected_at_ms: Date.now(),
    });
    socket.on("close", () => {
      if (this.subscribers.has(id)) {
        const s = this.subscribers.get(id)!;
        this.log(`[subscriber] disconnected name=${s.name ?? "?"} id=${id}`);
        this.subscribers.delete(id);
      }
    });
    socket.on("error", () => this.subscribers.delete(id));
    return id;
  }

  setHello(id: string, name: string, purpose: string | undefined): void {
    const s = this.subscribers.get(id);
    if (!s) return;
    s.name = name;
    s.purpose = purpose;
    this.log(`[subscriber] hello name=${name}${purpose ? ` purpose=${purpose}` : ""} id=${id}`);
  }

  subscribe(id: string, events: string[] | undefined): void {
    const s = this.subscribers.get(id);
    if (!s) return;
    s.subscribed = true;
    s.events = events;
    this.log(`[subscriber] subscribed name=${s.name ?? "?"} id=${id} events=${events ? events.join(",") : "all"}`);
  }

  unsubscribe(id: string): void {
    const s = this.subscribers.get(id);
    if (!s) return;
    s.subscribed = false;
    s.events = undefined;
    this.log(`[subscriber] unsubscribed name=${s.name ?? "?"} id=${id}`);
  }

  /** Push an event to every matching subscribed socket. */
  emit(event: HostEvent): void {
    if (this.subscribers.size === 0) return;
    const line = serializeJsonLine(event);
    for (const s of this.subscribers.values()) {
      if (!s.subscribed) continue;
      if (!this.matches(s.events, event.event)) continue;
      try {
        s.socket.write(line);
      } catch {
        // Socket may have died between the iteration start and the
        // write; we'll drop it on the next close/error event. Don't
        // throw on broken pipe.
      }
    }
  }

  /** Push an event to one specific subscriber by id (used for hello/welcome). */
  emitTo(id: string, event: HostEvent): void {
    const s = this.subscribers.get(id);
    if (!s) return;
    try {
      s.socket.write(serializeJsonLine(event));
    } catch {
      /* see emit() */
    }
  }

  snapshot(now: number = Date.now()): SubscriberInfo[] {
    return [...this.subscribers.values()].map((s) => ({
      id: s.id,
      name: s.name,
      purpose: s.purpose,
      subscribed: s.subscribed,
      connected_at_ms: s.connected_at_ms,
      events: s.events,
    }));
  }

  private matches(filters: string[] | undefined, eventName: string): boolean {
    if (!filters || filters.length === 0) return true;
    for (const f of filters) {
      if (eventName === f) return true;
      if (f.endsWith("*") && eventName.startsWith(f.slice(0, -1))) return true;
      if (eventName.startsWith(f + ":")) return true; // tolerate "pi" matching "pi:*"
    }
    return false;
  }
}
