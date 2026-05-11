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
import { attachJsonlLineReader } from "./jsonl.js";

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

export class DiscliProcess extends EventEmitter {
  private readonly bin: string;
  private readonly proc: ChildProcess;
  private exited = false;

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
      stdio: ["ignore", "pipe", "pipe"],
      // discli wants DISCORD_BOT_TOKEN; we also pass DISCORD_TOKEN since
      // many setups use that name.
      env: { ...process.env, DISCORD_BOT_TOKEN: opts.token, DISCORD_TOKEN: opts.token },
    });

    this.proc.on("error", (err) => this.emit("error", err));

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
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
      this.emit("event", parsed);
    });
  }

  get isRunning(): boolean {
    return !this.exited;
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
