/**
 * Control-plane protocol between disclaw-ctl and the disclaw daemon.
 *
 * One JSON object per line over a Unix socket. Every request has a
 * cmd field; the response echoes the same req_id. Commands grow as
 * each slice lands.
 */

export type PingMode = "push" | "follow_up" | "none";

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
  | { cmd: "discord-channels"; req_id: string; guild_id?: string };

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
  };
}
