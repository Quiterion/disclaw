/**
 * DiscliProcess: subprocess wrapper for `discli serve`.
 *
 * discli is a Python CLI (third_party/discli) that bridges Discord ↔ JSONL.
 * `discli serve` writes events to stdout (one JSON object per line) and
 * diagnostics to stderr.
 *
 * For slice 3b we spawn discli, attach a JSONL reader to stdout, and
 * emit each parsed event. Routing logic lives in slice 3c on top of
 * this. discli's stderr is forwarded to our stderr with a [discli] prefix
 * so any auth/connectivity problems surface at the operator level.
 *
 * Token comes from DISCORD_TOKEN in process.env (loaded from .env by
 * the daemon's startup wrapper).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Default to the project-local venv binary. Overridable via env. */
const DEFAULT_DISCLI_BIN = resolve(REPO_ROOT, ".venv/bin/discli");

export interface DiscliProcessOptions {
  /** Path to the discli executable. Defaults to .venv/bin/discli. */
  bin?: string;
  /** Discord bot token. Required. */
  token: string;
  /**
   * Optional event-type filter passed to discli (e.g. ["messages",
   * "reactions"]). Defaults to messages-only for slice 3.
   */
  events?: string[];
  /** Optional --no-include-self flag (default: include self). */
  excludeSelf?: boolean;
}

interface PendingResponse {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class DiscliProcess extends EventEmitter {
  private readonly bin: string;
  private readonly proc: ChildProcess;
  private exited = false;
  private pending = new Map<string, PendingResponse>();

  constructor(opts: DiscliProcessOptions) {
    super();
    this.bin = opts.bin ?? DEFAULT_DISCLI_BIN;
    if (!existsSync(this.bin)) {
      throw new Error(
        `discli binary not found at ${this.bin}. ` +
          `Run \`python3 -m venv .venv && .venv/bin/pip install -e third_party/discli\`, ` +
          `or set DISCLAW_DISCLI_BIN to a different location.`,
      );
    }

    const args = ["serve"];
    if (opts.events && opts.events.length > 0) {
      args.push("--events", opts.events.join(","));
    }
    if (opts.excludeSelf) args.push("--no-include-self");

    this.proc = spawn(this.bin, args, {
      // stdin must be piped — discli serve reads JSONL actions from
      // stdin (sendAction writes to it) and exits if stdin is closed.
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DISCORD_BOT_TOKEN: opts.token, DISCORD_TOKEN: opts.token },
    });

    this.proc.on("error", (err) => this.emit("error", err));

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      // Fail any pending action calls
      for (const p of this.pending.values()) {
        p.reject(new Error(`discli exited (code=${code} signal=${signal}) before response`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // discli's stderr is prose diagnostics — forward to our stderr.
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line) process.stderr.write(`[discli] ${line}\n`);
      }
    });

    attachJsonlLineReader(this.proc.stdout!, (line) => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.emit("parseError", { line, err });
        return;
      }

      // Route response events to the matching pending action call.
      if (parsed.event === "response" && typeof parsed.req_id === "string") {
        const pending = this.pending.get(parsed.req_id);
        if (pending) {
          this.pending.delete(parsed.req_id);
          if (parsed.error !== undefined) {
            pending.reject(new Error(String(parsed.error)));
          } else {
            pending.resolve(parsed);
          }
          return;
        }
      }

      this.emit("event", parsed);
    });
  }

  get isRunning(): boolean {
    return !this.exited;
  }

  /**
   * Send an action to discli and await its response (correlated by req_id).
   * Auto-assigns a req_id; throws if discli has exited or returns an error.
   */
  sendAction<T = any>(
    action: { action: string; [k: string]: any },
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.exited) return Promise.reject(new Error("discli has exited"));
    const req_id = action.req_id ?? randomUUID();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`discli action ${action.action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(req_id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin!.write(serializeJsonLine({ ...action, req_id }));
    });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 2000);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
