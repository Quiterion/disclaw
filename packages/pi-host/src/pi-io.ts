/**
 * PiProcess: long-lived wrapper around `pi --mode rpc`.
 *
 *   - send(cmd) — send an RPC command, get its response (correlated by id)
 *   - on('event', handler) — non-response events from pi
 *   - on('exit', handler) — pi process exited
 *   - shutdown() — close pi cleanly
 *
 * Tracks isStreaming via agent_start/agent_end and isCompacting via
 * compaction_start/compaction_end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, serializeJsonLine } from "pi-shared/jsonl";

export interface PiProcessOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface PendingResponse {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class PiProcess extends EventEmitter {
  private proc: ChildProcess;
  private pending = new Map<string, PendingResponse>();
  private _isStreaming = false;
  private _isCompacting = false;
  private exited = false;

  constructor(opts: PiProcessOptions) {
    super();
    this.proc = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });

    this.proc.on("error", (err) => this.emit("error", err));

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        p.reject(new Error(`pi exited (code=${code} signal=${signal}) before response`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pi-stderr] ${chunk.toString()}`);
    });

    attachJsonlLineReader(this.proc.stdout!, (line) => this.handleLine(line));
  }

  get isStreaming(): boolean { return this._isStreaming; }
  get isCompacting(): boolean { return this._isCompacting; }
  /** Pi is "idle" when no agent run is in flight and not compacting. */
  get isIdle(): boolean { return !this._isStreaming && !this._isCompacting; }

  send<T = any>(cmd: { type: string; [k: string]: any }): Promise<T> {
    if (this.exited) return Promise.reject(new Error("pi has exited"));
    const id = cmd.id ?? randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { ...cmd, id };
      this.proc.stdin!.write(serializeJsonLine(payload));
    });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGTERM");
        resolve();
      }, 1000);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.emit("parseError", { line, err });
      return;
    }

    switch (parsed.type) {
      case "agent_start": this._isStreaming = true; break;
      case "agent_end": this._isStreaming = false; break;
      case "compaction_start": this._isCompacting = true; break;
      case "compaction_end": this._isCompacting = false; break;
    }

    if (parsed.type === "response" && parsed.id) {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        this.pending.delete(parsed.id);
        if (parsed.success === false) {
          pending.reject(new Error(parsed.error ?? "unknown error"));
        } else {
          pending.resolve(parsed);
        }
        return;
      }
    }

    this.emit("event", parsed);
  }
}
