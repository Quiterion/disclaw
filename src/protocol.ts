/**
 * Control-plane protocol between disclaw-ctl and the disclaw daemon.
 *
 * One JSON object per line over a Unix socket. Every request has a
 * cmd field; the response echoes the same req_id. Commands grow as
 * each slice lands.
 */

// ── Requests (ctl → daemon) ──────────────────────────────────────────────

export type CtlRequest =
  | { cmd: "ping"; req_id: string }
  | { cmd: "get-state"; req_id: string }
  | { cmd: "prompt"; req_id: string; message: string }
  | { cmd: "sysprompt-show"; req_id: string }
  | { cmd: "sysprompt-set"; req_id: string; value: string }
  | { cmd: "sysprompt-clear"; req_id: string };

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
    /** Pi's view of state, fetched on demand (slice 1: included for parity). */
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
    /** Length of sysprompt content; full content via sysprompt-show */
    sysprompt_chars: number;
  };
}
