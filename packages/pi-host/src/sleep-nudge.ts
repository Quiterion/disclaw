/**
 * Sleep + idle-nudge lifecycle.
 *
 * Two related attention primitives, kept together because they share
 * state (sleep suppresses nudges; sleep expiry triggers a nudge):
 *
 *   - `sleep`: the agent (or operator) says "be quiet until something
 *     real happens." Suppresses scheduled idle nudges. Optionally
 *     bounded by a duration after which a sleep-expired nudge fires.
 *   - `nudge`: a quiet prompt that follows agent_end after N ms of
 *     idleness ("anything else?"). Off (`null`) disables entirely.
 *
 * Both are in-memory only; a daemon restart clears any pending state.
 * That's fine — there's no recent agent_end on startup to schedule
 * from, and any sleep was implicit "until next event" which the next
 * event will deliver anyway.
 *
 * This module owns the timers and the state. The daemon hooks `onFire`
 * to actually deliver the prompt to pi and `onEvent` to emit the
 * supervisor's `host:*` event-stream notifications.
 */

export type NudgeReason = "idle" | "sleep-expired";
export type SleepCancelBy = "wake-verb" | "deliver-verb";

export interface SleepNudgeHooks {
  /** Called when a nudge should be sent to pi. Reason indicates why. */
  onFire: (reason: NudgeReason) => void;
  /** Called when an event should be pushed to subscribers. */
  onEvent: (event:
    | { event: "host:sleep_started"; until_ms: number | null }
    | { event: "host:sleep_expired" }
    | { event: "host:sleep_cancelled"; by: SleepCancelBy }
    | { event: "host:nudge_fired"; reason: NudgeReason }
    | { event: "host:idle_nudge_timeout_changed"; timeout_ms: number | null }
  ) => void;
  /** Predicate the manager calls before firing a nudge — skip if not idle. */
  isPiIdle: () => boolean;
  /** Called with each log line — daemon plumbs to its logger. */
  log: (msg: string) => void;
}

export class SleepNudgeManager {
  private nudgeTimer: NodeJS.Timeout | null = null;
  private sleep: { until_ms: number | null; expiryTimer: NodeJS.Timeout | null } | null = null;
  private timeoutMs: number | null;
  private readonly hooks: SleepNudgeHooks;

  constructor(initialTimeoutMs: number | null, hooks: SleepNudgeHooks) {
    this.timeoutMs = initialTimeoutMs;
    this.hooks = hooks;
  }

  // ── nudge ─────────────────────────────────────────────────────────

  /** Schedule a nudge to fire after the configured timeout. No-op if disabled or sleeping. */
  scheduleNudge(): void {
    this.cancelNudge();
    if (this.sleep) return;
    if (this.timeoutMs === null) return;
    const ms = this.timeoutMs;
    this.hooks.log(`[nudge] scheduled in ${ms}ms`);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.fireNudge("idle");
    }, ms);
  }

  cancelNudge(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
      this.hooks.log(`[nudge] cancelled`);
    }
  }

  private fireNudge(reason: NudgeReason): void {
    if (!this.hooks.isPiIdle()) {
      this.hooks.log(`[nudge] skipped — pi not idle`);
      return;
    }
    this.hooks.log(`[nudge] firing (${reason})`);
    this.hooks.onEvent({ event: "host:nudge_fired", reason });
    this.hooks.onFire(reason);
  }

  setTimeoutMs(ms: number | null, opts: { rescheduleIfPending?: boolean } = {}): void {
    this.timeoutMs = ms;
    this.hooks.onEvent({ event: "host:idle_nudge_timeout_changed", timeout_ms: ms });
    if (opts.rescheduleIfPending && this.nudgeTimer !== null) {
      this.scheduleNudge();
    }
  }

  get idleNudgeTimeoutMs(): number | null {
    return this.timeoutMs;
  }

  // ── sleep ─────────────────────────────────────────────────────────

  /** Begin sleep. `durationMs` undefined → indefinite (until external cancel). */
  startSleep(durationMs?: number): { until_ms: number | null } {
    this.cancelNudge();
    this.cancelSleep("wake-verb", { silent: true });
    const until_ms = durationMs !== undefined ? Date.now() + durationMs : null;
    const newSleep: { until_ms: number | null; expiryTimer: NodeJS.Timeout | null } = {
      until_ms,
      expiryTimer: null,
    };
    this.sleep = newSleep;
    if (durationMs !== undefined) {
      newSleep.expiryTimer = setTimeout(() => {
        this.sleep = null;
        this.hooks.log(`[sleep] expired`);
        this.hooks.onEvent({ event: "host:sleep_expired" });
        this.fireNudge("sleep-expired");
      }, durationMs);
      this.hooks.log(`[sleep] starting (until ${new Date(until_ms!).toISOString()})`);
    } else {
      this.hooks.log(`[sleep] starting (until next event)`);
    }
    this.hooks.onEvent({ event: "host:sleep_started", until_ms });
    return { until_ms };
  }

  /**
   * Cancel any active sleep. `by` records who cancelled — useful for
   * subscriber telemetry. The `silent` option suppresses the event
   * emit (used internally to avoid noisy double-cancel events).
   */
  cancelSleep(by: SleepCancelBy, opts: { silent?: boolean } = {}): void {
    if (!this.sleep) return;
    if (this.sleep.expiryTimer) clearTimeout(this.sleep.expiryTimer);
    this.sleep = null;
    this.hooks.log(`[sleep] cancelled by=${by}`);
    if (!opts.silent) this.hooks.onEvent({ event: "host:sleep_cancelled", by });
  }

  isSleeping(): boolean {
    return this.sleep !== null;
  }

  sleepSnapshot(): { until_ms: number | null } | null {
    return this.sleep ? { until_ms: this.sleep.until_ms } : null;
  }
}
