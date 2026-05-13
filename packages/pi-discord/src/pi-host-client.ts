/**
 * Client for pi-host's outward RPC + event stream.
 *
 * One long-lived Unix-socket connection. On connect: send `hello` to
 * identify ourselves, then `subscribe` to opt into the event push.
 * After that, requests (deliver verbs) and pushed events share the
 * same socket — responses are correlated by req_id, events have no
 * req_id (so we can disambiguate at parse time).
 *
 * Auto-reconnect: pi-host's lifecycle is independent of ours. If pi-
 * host exits or restarts, this client backs off and reconnects. Any
 * in-flight requests at disconnect time fail; the consumer can retry.
 *
 * Connection state is exposed via `connected` so the daemon can
 * report it in get-state and decline new delivers when we're offline.
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, serializeJsonLine } from "pi-shared/jsonl";

export interface PiHostClientOptions {
  socketPath: string;
  /** Subscriber name reported in `hello`. */
  name: string;
  /** Optional purpose string reported in `hello`. */
  purpose?: string;
  /** Initial reconnect delay, doubles up to max. Default: 500ms. */
  initialBackoffMs?: number;
  /** Max reconnect delay. Default: 10_000ms. */
  maxBackoffMs?: number;
  /** Called with each log line — daemon plumbs to its logger. */
  log: (msg: string) => void;
}

interface PendingResponse {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class PiHostClient extends EventEmitter {
  private socket: Socket | null = null;
  private pending = new Map<string, PendingResponse>();
  private _connected = false;
  private shuttingDown = false;
  private backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly initialBackoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PiHostClientOptions) {
    super();
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.backoffMs = this.initialBackoffMs;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this.connectOnce();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) this.socket.destroy();
  }

  /**
   * Send a request to pi-host and await its response.
   *
   * Throws if we're not currently connected. The caller is responsible
   * for retry semantics (today, only delivers go through here, and
   * Discord events should buffer until we reconnect).
   */
  async send<T = any>(req: { cmd: string; [k: string]: any }): Promise<T> {
    if (!this._connected || !this.socket) {
      throw new Error("pi-host client not connected");
    }
    const req_id = req.req_id ?? randomUUID();
    const payload = { ...req, req_id };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject });
      this.socket!.write(serializeJsonLine(payload));
    });
  }

  /** Fire a request without awaiting a response (used for fire-and-forget unsubscribe etc.). */
  sendFireAndForget(req: { cmd: string; [k: string]: any }): void {
    if (!this._connected || !this.socket) return;
    const req_id = req.req_id ?? randomUUID();
    this.socket.write(serializeJsonLine({ ...req, req_id }));
  }

  private connectOnce(): void {
    if (this.shuttingDown) return;
    const sock = connect(this.opts.socketPath);
    this.socket = sock;

    sock.on("connect", () => {
      this._connected = true;
      this.backoffMs = this.initialBackoffMs;
      this.opts.log(`[pi-host-client] connected to ${this.opts.socketPath}`);
      this.emit("connect");
      // Identify + subscribe immediately. Both fire-and-forget — we
      // don't actually need their responses to start receiving events,
      // and waiting would delay first delivery if pi-host had buffered
      // anything for us during a reconnect window.
      this.sendFireAndForget({
        cmd: "hello",
        name: this.opts.name,
        ...(this.opts.purpose ? { purpose: this.opts.purpose } : {}),
      });
      this.sendFireAndForget({ cmd: "subscribe" });
    });

    sock.on("error", (err) => {
      this.opts.log(`[pi-host-client] error: ${err.message}`);
    });

    sock.on("close", () => {
      const wasConnected = this._connected;
      this._connected = false;
      this.socket = null;
      // Fail any pending in-flight requests
      for (const p of this.pending.values()) {
        p.reject(new Error("pi-host client disconnected"));
      }
      this.pending.clear();
      if (wasConnected) {
        this.opts.log(`[pi-host-client] disconnected`);
        this.emit("disconnect");
      }
      if (!this.shuttingDown) this.scheduleReconnect();
    });

    attachJsonlLineReader(sock, (line) => this.handleLine(line));
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    const ms = this.backoffMs;
    this.opts.log(`[pi-host-client] reconnecting in ${ms}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.connectOnce();
    }, ms);
  }

  private handleLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.opts.log(`[pi-host-client] parse error: ${err}`);
      return;
    }
    // Responses have req_id (always set, even if "" for parse errors).
    // Events have `event:` instead of `cmd:` and no req_id field.
    if (parsed.req_id !== undefined && parsed.ok !== undefined) {
      const pending = this.pending.get(parsed.req_id);
      if (pending) {
        this.pending.delete(parsed.req_id);
        if (parsed.ok) pending.resolve(parsed);
        else pending.reject(new Error(parsed.error ?? "unknown error"));
      }
      return;
    }
    if (typeof parsed.event === "string") {
      this.emit("event", parsed);
    }
  }
}
