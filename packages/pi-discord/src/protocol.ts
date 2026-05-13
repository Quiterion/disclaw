/**
 * Control-plane protocol between pi-discord-ctl and the pi-discord
 * daemon. Strictly request/response over a Unix socket — pi-discord
 * has no pub/sub surface (subscribing to pi happens via pi-host's
 * socket, in the opposite direction).
 */

export type PingMode = "push" | "follow_up" | "none";
/**
 * How the activity digest is delivered. `follow_up` piggybacks the
 * digest on whatever Discord-event delivery fires next; `none` keeps
 * it off-channel (the agent can still inspect via `pi-discord-ctl
 * digest`). `push` is intentionally not offered (digest is ambient
 * background, never an interrupt).
 */
export type DigestMode = "follow_up" | "none";

// ── Requests ────────────────────────────────────────────────────────────

export type DiscordCtlRequest =
  | { req_id: string; cmd: "ping" }
  | { req_id: string; cmd: "get-state" }
  | { req_id: string; cmd: "status" }
  | { req_id: string; cmd: "subscribe"; channel_id: string }
  | { req_id: string; cmd: "unsubscribe"; channel_id: string }
  | { req_id: string; cmd: "list-subscriptions" }
  | { req_id: string; cmd: "set-ping-mode"; mode: PingMode }
  | { req_id: string; cmd: "set-digest-mode"; mode: DigestMode }
  | { req_id: string; cmd: "digest" }
  | { req_id: string; cmd: "digest-ack"; channel_id?: string }
  | { req_id: string; cmd: "missed-pings"; limit?: number }
  | { req_id: string; cmd: "missed-pings-clear" }
  | { req_id: string; cmd: "send"; channel_id: string; content: string }
  | { req_id: string; cmd: "history"; channel_id: string; limit?: number }
  | { req_id: string; cmd: "channels"; guild_id?: string }
  | { req_id: string; cmd: "typing-start"; channel_id: string; duration_ms?: number }
  | { req_id: string; cmd: "typing-stop"; channel_id: string }
  | { req_id: string; cmd: "whois"; name: string; guild_id?: string }
  | { req_id: string; cmd: "react"; channel_id: string; message_id: string; emoji: string }
  | { req_id: string; cmd: "unreact"; channel_id: string; message_id: string; emoji: string };

export type DiscordCtlCmd = DiscordCtlRequest["cmd"];

// ── Responses ───────────────────────────────────────────────────────────

export interface DiscordCtlResponseOk<T = unknown> {
  req_id: string;
  ok: true;
  result?: T;
}
export interface DiscordCtlResponseError {
  req_id: string;
  ok: false;
  error: string;
}
export type DiscordCtlResponse<T = unknown> = DiscordCtlResponseOk<T> | DiscordCtlResponseError;

// ── State payload (get-state) ───────────────────────────────────────────

/**
 * Slim, agent-facing view of bridge state — what an inhabitant
 * typically wants on cold-start. A strict subset of
 * {@link DiscordDaemonState} plus two pre-computed counts
 * (digest_count, missed_pings_count) friendlier than peeking full
 * lists.
 */
export interface DiscordStatusSnapshot {
  discord_connected: boolean;
  pi_host_connected: boolean;
  pi_idle: boolean;
  subscriptions: string[];
  ping_mode: PingMode;
  digest_mode: DigestMode;
  digest_count: number;
  missed_pings_count: number;
  deploy?: { provider: string; model: string; modelName: string };
}

export interface DiscordDaemonState {
  daemon: {
    uptime_ms: number;
    /** ms since most recent Discord event (any). */
    last_event_ms_ago: number | null;
  };
  discord: {
    /** False if discli failed to spawn or has exited. */
    connected: boolean;
    bot_id: string | null;
    bot_name: string | null;
  };
  pi_host: {
    /** True while we have an active subscriber connection to pi-host. */
    connected: boolean;
    /**
     * Pi's idle state as last reported by pi-host's event stream
     * (agent_start / agent_end). Used by the buffering layer to pick
     * the right deliver-verb.
     */
    pi_idle: boolean;
    deploy?: { provider: string; model: string; modelName: string };
  };
  router: {
    subscriptions: string[];
    ping_mode: PingMode;
    digest_mode: DigestMode;
  };
}
