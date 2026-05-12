/**
 * Per-mode event buffers + flush triggers.
 *
 * Three buffers — follow_up / push / prompt — keyed by how the daemon
 * intends to deliver them to the agent. Routing classifies an arriving
 * Discord event (push or follow_up) and the daemon picks the buffer
 * based on pi's current state (idle → prompt; streaming → the routed
 * mode).
 *
 * Flush triggers:
 *   - follow_up: pi emits agent_end (no timer; the natural batching
 *     window is the in-flight agent_run)
 *   - push: short debounce window from first event in the batch
 *   - prompt: short debounce window from first event in the batch
 *
 * At flush time we drain the buffer into a formatted user-message body
 * (formatting.ts), wrap in `<disclaw>...</disclaw>`, and call the
 * appropriate AgentHost method. The "prompt" buffer's flush re-checks
 * pi state at the time of dispatch — if pi started streaming during
 * the debounce, the buffer is delivered as follow_up instead.
 */
import { formatBatch, type BufferedEvent } from "./formatting.js";

export type BufferKind = "follow_up" | "push" | "prompt";

export interface BufferingOptions {
  /** Debounce window for push and prompt buffers, in ms. Default: 500. */
  debounceMs?: number;
  /** Truncation length for push-mode pings. Default: 150. */
  pingPreviewLength?: number;
  /**
   * Called to deliver the formatted (but un-wrapped) batch body to the
   * agent. The dispatch layer is responsible for appending any tail
   * content (e.g. activity digest) and wrapping in `<disclaw>...
   * </disclaw>` before sending. Keeping wrap+tail composition outside
   * BufferManager means idle nudges and bootstrap prompts share the
   * same composition path as buffered batches.
   */
  dispatch: (kind: BufferKind, body: string) => void;
}

export class BufferManager {
  private buffers: Record<BufferKind, BufferedEvent[]> = {
    follow_up: [],
    push: [],
    prompt: [],
  };
  private flushTimers: Record<BufferKind, NodeJS.Timeout | null> = {
    follow_up: null, // never used — flushes on agent_end
    push: null,
    prompt: null,
  };
  private readonly debounceMs: number;
  private readonly pingPreviewLength: number;
  private readonly dispatch: BufferingOptions["dispatch"];

  constructor(opts: BufferingOptions) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.pingPreviewLength = opts.pingPreviewLength ?? 150;
    this.dispatch = opts.dispatch;
  }

  /**
   * Add an event to a buffer. For push/prompt, schedules a debounced
   * flush if not already pending. For follow_up, just queues — caller
   * triggers via flush('follow_up') on agent_end.
   */
  add(kind: BufferKind, event: BufferedEvent): void {
    this.buffers[kind].push(event);
    if (kind === "follow_up") return;
    if (this.flushTimers[kind] !== null) return;
    this.flushTimers[kind] = setTimeout(() => {
      this.flushTimers[kind] = null;
      this.flush(kind);
    }, this.debounceMs);
  }

  /**
   * Drain a buffer and dispatch as a formatted, wrapped user message.
   * No-op if the buffer is empty. Cancels any pending timer for that
   * buffer.
   */
  flush(kind: BufferKind): void {
    const t = this.flushTimers[kind];
    if (t !== null) {
      clearTimeout(t);
      this.flushTimers[kind] = null;
    }
    const events = this.buffers[kind].splice(0);
    if (events.length === 0) return;
    const body = formatBatch(events, {
      now: Date.now(),
      pingStyle: kind === "push" ? "push" : "follow_up",
      pingPreviewLength: this.pingPreviewLength,
    });
    this.dispatch(kind, body);
  }

  /** Drop all buffered events for a given kind without dispatching. */
  clear(kind: BufferKind): void {
    this.buffers[kind] = [];
    const t = this.flushTimers[kind];
    if (t !== null) {
      clearTimeout(t);
      this.flushTimers[kind] = null;
    }
  }

  /** Inspect — for tests / get-state diagnostics. */
  pending(kind: BufferKind): number {
    return this.buffers[kind].length;
  }
}
