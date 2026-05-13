/**
 * pi-host's outward control + event protocol.
 *
 * Single Unix socket. Two connection styles share the same wire format:
 *
 *   - Short-lived (pi-ctl): connect → send 1 request → recv 1 response → close.
 *     No subscription, no event push.
 *   - Long-lived (subscribers, e.g. pi-discord): connect → optional `hello` →
 *     `subscribe` → receive pushed events asynchronously. Can also submit
 *     requests on the same connection at any time.
 *
 * The host re-emits pi's RPC events (prefixed `pi:*`) and originates its own
 * (`host:*`). Subscribers can filter the stream by event-name prefix or by
 * exact name; default subscription is everything.
 *
 * The deliver-verbs (`prompt`, `follow-up`, `steer`) are the supervisor's
 * curated subset of pi's RPC. They centralize the "real activity arrived"
 * semantics — every successful deliver auto-cancels any pending nudge and
 * any active sleep before forwarding to pi. The host also smart-falls-back
 * when pi's state doesn't match the verb (e.g. a `prompt` while pi is
 * streaming becomes a `follow-up`); the response's `delivered_as` field
 * announces the actual disposition.
 */
import type { DeliveredAs } from "./pi-rpc-types.js";

// ── Requests ────────────────────────────────────────────────────────────

export type HostRequest =
  | { req_id: string; cmd: "ping" }
  | { req_id: string; cmd: "hello"; name: string; purpose?: string }
  | { req_id: string; cmd: "subscribe"; events?: string[] }
  | { req_id: string; cmd: "unsubscribe" }
  | { req_id: string; cmd: "get-state" }
  | { req_id: string; cmd: "status" }
  | { req_id: string; cmd: "sysprompt-get" }
  | { req_id: string; cmd: "sysprompt-set"; value: string }
  | { req_id: string; cmd: "sysprompt-clear" }
  | { req_id: string; cmd: "set-idle-nudge-timeout"; timeout_ms: number | null }
  | { req_id: string; cmd: "sleep"; duration_ms?: number }
  | { req_id: string; cmd: "wake" }
  | { req_id: string; cmd: "prompt"; message: string }
  | { req_id: string; cmd: "follow-up"; message: string }
  | { req_id: string; cmd: "steer"; message: string }
  | { req_id: string; cmd: "abort" };

export type HostCmd = HostRequest["cmd"];

// ── Responses ───────────────────────────────────────────────────────────

export interface HostResponseOk<T = unknown> {
  req_id: string;
  ok: true;
  result?: T;
}
export interface HostResponseError {
  req_id: string;
  ok: false;
  error: string;
}
export type HostResponse<T = unknown> = HostResponseOk<T> | HostResponseError;

/** Per-verb response payloads. */
export interface HelloResult {
  subscriber_id: string;
}
export interface SubscribeResult {
  subscriber_id: string;
  events: string[]; // resolved filter ("all" if no filter was passed)
}
export interface SyspromptGetResult {
  value: string;
}
export interface SyspromptSetResult {
  chars: number;
}
export interface SleepResult {
  /** unix-ms when sleep auto-expires, or null for indefinite. */
  until_ms: number | null;
}
export interface DeliverResult {
  /** What the host actually did, which may differ from the verb sent. */
  delivered_as: DeliveredAs;
}
export interface IdleNudgeTimeoutResult {
  timeout_ms: number | null;
}

// ── Events ──────────────────────────────────────────────────────────────

/**
 * Events pushed to subscribers. No `req_id` (matches pi's RPC convention).
 *
 * `pi:*` events are pass-throughs of pi's RPC event stream — minus a few
 * we deliberately drop (extension UI requests, which need bidirectional
 * client-side handling we don't yet expose).
 *
 * `host:*` events are originated by the supervisor itself.
 */
export type HostEvent =
  // pi RPC pass-through
  | { event: "pi:agent_start" }
  | { event: "pi:agent_end"; messages: unknown[] }
  | { event: "pi:turn_start" }
  | { event: "pi:turn_end"; message: unknown; toolResults: unknown[] }
  | { event: "pi:message_start"; message: unknown }
  | { event: "pi:message_update"; message: unknown; assistantMessageEvent: unknown }
  | { event: "pi:message_end"; message: unknown }
  | {
      event: "pi:tool_execution_start";
      toolCallId: string;
      toolName: string;
      args?: unknown;
    }
  | {
      event: "pi:tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult?: unknown;
    }
  | {
      event: "pi:tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError: boolean;
    }
  | {
      event: "pi:compaction_start";
      reason: "manual" | "threshold" | "overflow";
    }
  | {
      event: "pi:compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result: unknown;
      aborted: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      event: "pi:auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | {
      event: "pi:auto_retry_end";
      attempt: number;
      success: boolean;
      finalError?: string;
    }
  | { event: "pi:queue_update"; steering: string[]; followUp: string[] }
  | {
      event: "pi:extension_error";
      extensionPath: string;
      event_name: string;
      error: string;
    }
  // host-originated
  | {
      event: "host:welcome";
      host_uptime_ms: number;
      deploy: { provider: string; model: string; modelName: string };
    }
  | { event: "host:pi_alive" }
  | {
      event: "host:pi_exit";
      code: number | null;
      signal: string | null;
    }
  | { event: "host:bootstrap_first_run" }
  | { event: "host:sysprompt_changed"; chars: number }
  | { event: "host:sleep_started"; until_ms: number | null }
  | { event: "host:sleep_expired" }
  | {
      event: "host:sleep_cancelled";
      by: "wake-verb" | "deliver-verb";
    }
  | { event: "host:nudge_fired"; reason: "idle" | "sleep-expired" }
  | {
      event: "host:idle_nudge_timeout_changed";
      timeout_ms: number | null;
    };

export type HostEventName = HostEvent["event"];

// ── State payload (get-state) ───────────────────────────────────────────

export interface HostStateSnapshot {
  host: {
    uptime_ms: number;
    /** ms since the most recent inbound activity (pi event or subscriber deliver). */
    last_event_ms_ago: number | null;
    deploy: { provider: string; model: string; modelName: string };
    subscribers: Array<{
      id: string;
      name?: string;
      purpose?: string;
      subscribed: boolean;
      connected_for_ms: number;
    }>;
  };
  pi: {
    alive: boolean;
    isStreaming: boolean;
    isCompacting: boolean;
    isIdle: boolean;
    exit?: { code: number | null; signal: string | null };
    rpc?: {
      sessionId?: string;
      sessionFile?: string;
      messageCount?: number;
      pendingMessageCount?: number;
    };
  };
  config: {
    initialized: boolean;
    sysprompt_chars: number;
    idle_nudge_timeout_ms: number | null;
    sleep?: { until_ms: number | null };
    /** Pi session files keyed by `<provider>:<model>`. */
    sessions: Record<string, string>;
  };
}

/**
 * Slim, agent-facing view of state — what an inhabitant typically
 * wants to glance at on cold-start ("what's currently configured for
 * me?") without wading through daemon meta / pi RPC internals.
 *
 * A strict subset of {@link HostStateSnapshot}: drops uptime,
 * subscribers, isCompacting, pi.exit, pi.rpc detail, session
 * registry, and the initialized flag.
 */
export interface HostStatusSnapshot {
  deploy: { provider: string; model: string; modelName: string };
  pi: { alive: boolean; isIdle: boolean; sessionFile?: string };
  sysprompt_chars: number;
  idle_nudge_timeout_ms: number | null;
  sleep?: { until_ms: number | null };
}
