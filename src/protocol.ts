/**
 * Control-plane protocol between disclaw-ctl and the disclaw daemon.
 *
 * One JSON object per line over a Unix socket. Every request has a
 * cmd field; the response echoes the same req_id. Commands grow as
 * each slice lands.
 */

export type PingMode = "push" | "follow_up" | "none";
/**
 * How the activity digest (counts of unsubscribed-channel messages) is
 * delivered. `follow_up` piggybacks the digest on whatever flush fires
 * next (or on the idle nudge if nothing else does); `none` keeps it
 * fully off-channel — the agent can still inspect it via `disclaw-ctl
 * digest`. `push` is intentionally not offered (digest is ambient
 * background, never an interrupt).
 */
export type DigestMode = "follow_up" | "none";

// ── Requests (ctl → daemon) ──────────────────────────────────────────────

export type CtlRequest =
  | { cmd: "ping"; req_id: string }
  | { cmd: "get-state"; req_id: string }
  | { cmd: "sysprompt-show"; req_id: string }
  | { cmd: "sysprompt-set"; req_id: string; value: string }
  | { cmd: "sysprompt-clear"; req_id: string }
  | { cmd: "subscribe"; req_id: string; channel_id: string }
  | { cmd: "unsubscribe"; req_id: string; channel_id: string }
  | { cmd: "list-subscriptions"; req_id: string }
  | { cmd: "set-ping-mode"; req_id: string; mode: PingMode }
  | { cmd: "discord-send"; req_id: string; channel_id: string; content: string }
  | { cmd: "discord-history"; req_id: string; channel_id: string; limit?: number }
  | { cmd: "discord-channels"; req_id: string; guild_id?: string }
  | { cmd: "discord-typing-start"; req_id: string; channel_id: string; duration_ms?: number }
  | { cmd: "discord-typing-stop"; req_id: string; channel_id: string }
  | { cmd: "discord-whois"; req_id: string; name: string; guild_id?: string }
  | { cmd: "set-idle-nudge-timeout"; req_id: string; timeout_ms: number | null }
  | { cmd: "set-digest-mode"; req_id: string; mode: DigestMode }
  | { cmd: "digest"; req_id: string }
  | { cmd: "digest-ack"; req_id: string; channel_id?: string }
  | { cmd: "missed-pings"; req_id: string; limit?: number }
  | { cmd: "missed-pings-clear"; req_id: string }
  | { cmd: "sleep"; req_id: string; duration_ms?: number }
  | { cmd: "wake"; req_id: string };

export type CtlCmdName = CtlRequest["cmd"];

// ── Responses (daemon → ctl) ─────────────────────────────────────────────

export interface CtlResponseOk<T = unknown> {
  req_id: string;
  ok: true;
  result?: T;
}

export interface CtlResponseError {
  req_id: string;
  ok: false;
  error: string;
}

export type CtlResponse<T = unknown> = CtlResponseOk<T> | CtlResponseError;

// ── State payload (returned by get-state) ────────────────────────────────

export interface DaemonState {
  daemon: {
    /** Daemon process uptime in milliseconds. */
    uptime_ms: number;
    /** ms since the most recent inbound event (Discord or agent_end). null if none yet. */
    last_event_ms_ago: number | null;
  };
  pi: {
    isStreaming: boolean;
    isCompacting: boolean;
    isIdle: boolean;
    rpc?: {
      sessionId?: string;
      sessionFile?: string;
      messageCount?: number;
      pendingMessageCount?: number;
    };
  };
  router: {
    initialized: boolean;
    sysprompt_set: boolean;
    sysprompt_chars: number;
    subscriptions: string[];
    ping_mode: PingMode;
    digest_mode: DigestMode;
    idle_nudge_timeout_ms: number | null;
    /** Sleep state — only set while the agent has requested dormancy. */
    sleep?: {
      /** unix-ms timestamp when sleep auto-expires, or null for "until next event". */
      until_ms: number | null;
    };
  };
}
