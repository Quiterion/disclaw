/**
 * AgentHost: wraps a `pi --mode rpc` subprocess via PiProcess.
 *
 * Pi gives us session persistence, pi-acm-compatible context management,
 * and the full pi tool catalog (read/write/edit/grep/bash) out of the
 * box. Our `.pi/extensions/sysprompt/` REPLACES (not appends) pi's
 * default coding-assistant sysprompt with our own model-derived floor +
 * the agent-managed slot.
 *
 * AgentHost preserves the same outward shape the daemon uses
 * (prompt/followUp/steer/abort/waitForIdle/shutdown,
 * isStreaming/isCompacting/isIdle, EventEmitter for `event`).
 */
import { EventEmitter } from "node:events";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProcess } from "./pi-io.js";
import { SYSPROMPT_FILE } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/agent-host.js → packages/pi-host/dist/ → packages/pi-host/
const PKG_ROOT = resolve(__dirname, "..");
const WORKSPACE_ROOT = resolve(PKG_ROOT, "..", "..");
// Default: the npm-installed pi binary. We use @mariozechner/* (which
// pi-acm was built against) — mixing with the @earendil-works/* fork in
// third_party/pi/ would be a peer-dep nightmare. Override via PI_BIN.
const DEFAULT_PI_BIN = resolve(WORKSPACE_ROOT, "node_modules/.bin/pi");

export interface AgentHostOptions {
  provider: string;
  modelId: string;
  /**
   * Display name for the model (e.g. "Claude Haiku 4.5"). Passed to the
   * sysprompt extension via env var so the floor sysprompt identifies
   * the right model. Falls back to modelId if not provided.
   */
  modelName?: string;
  initialSysprompt?: string;
  piBin?: string;
  /**
   * Optional pi session file to resume from. If the path exists, pi is
   * spawned with `--session <path>` and continues writing to that file.
   * If null/undefined or the path doesn't exist, pi starts a fresh
   * session.
   */
  resumeSessionFile?: string | null;
}

export class AgentHost extends EventEmitter {
  readonly pi: PiProcess;
  private readonly modelName: string;
  /** Set when pi process exits. Null while pi is alive. */
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(opts: AgentHostOptions) {
    super();
    this.modelName = opts.modelName ?? opts.modelId;

    const piBin = opts.piBin ?? process.env.PI_BIN ?? DEFAULT_PI_BIN;

    // Make `pi-ctl` and (if installed) `pi-discord-ctl` discoverable in
    // the agent's bash by prepending the workspace bin/ dir to PATH.
    const binDir = resolve(WORKSPACE_ROOT, "bin");
    const newPath = `${binDir}:${process.env.PATH ?? ""}`;

    // Load extensions + skills via explicit absolute paths so pi finds
    // them regardless of the cwd it was spawned in. We deliberately do
    // *not* set pi's cwd; it inherits from the daemon process. For dev
    // run from a scratch dir; for prod the deploy script does
    // `cd $HOME && exec`.
    const syspromptExtDir = resolve(PKG_ROOT, ".pi/extensions/sysprompt");
    const piAcmDir = resolve(PKG_ROOT, "third_party/pi-acm");
    const piAcmSkill = resolve(PKG_ROOT, "third_party/pi-acm/skills/acm");

    const sessionArgs: string[] = [];
    if (opts.resumeSessionFile) {
      sessionArgs.push("--session", opts.resumeSessionFile);
    }

    this.pi = new PiProcess({
      command: piBin,
      args: [
        "--mode", "rpc",
        "--provider", opts.provider,
        "--model", opts.modelId,
        "--extension", syspromptExtDir,
        "--extension", piAcmDir,
        "--skill", piAcmSkill,
        ...sessionArgs,
      ],
      env: {
        ...process.env,
        PATH: newPath,
        PI_HOST_MODEL_NAME: this.modelName,
        // Pin the sysprompt-extension's read path to the same one this
        // daemon writes to (state.ts's atomicWrite). Without this the
        // extension defaults to the user-level path and leaks any prior
        // agent's slot into isolated test runs.
        PI_HOST_SYSPROMPT_FILE: SYSPROMPT_FILE,
      },
      // No cwd specified — pi inherits from the daemon's cwd.
    });

    this.pi.on("event", (event: any) => this.emit("event", event));
    this.pi.on("error", (err: Error) => this.emit("error", err));
    this.pi.on("exit", (info) => {
      this.exitInfo = info;
      this.emit("exit", info);
    });
  }

  /** True while pi is running. Goes false on pi exit. */
  get alive(): boolean {
    return this.exitInfo === null;
  }

  /** Exit info once pi has exited; null while alive. */
  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }

  get isStreaming(): boolean { return this.pi.isStreaming; }
  get isCompacting(): boolean { return this.pi.isCompacting; }
  get isIdle(): boolean { return this.pi.isIdle; }

  /** Send a new prompt; throws if pi is not idle. */
  async prompt(message: string): Promise<void> {
    if (!this.isIdle) {
      throw new Error(
        `agent not idle (isStreaming=${this.pi.isStreaming} isCompacting=${this.pi.isCompacting})`,
      );
    }
    await this.pi.send({ type: "prompt", message });
  }

  /** Queue a message for delivery after the current run finishes. */
  followUp(message: string): void {
    this.pi.send({ type: "follow_up", message }).catch(() => {});
  }

  /** Inject a message between turns within the current run. */
  steer(message: string): void {
    this.pi.send({ type: "steer", message }).catch(() => {});
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.pi.send({ type: "abort" }).catch(() => {});
  }

  /**
   * The sysprompt slot is a file the extension reads on every agent
   * run. saveState writes the file; this method exists for API parity
   * but is a no-op (the file IS the source of truth).
   */
  updateSysprompt(_newSlot: string): void {
    // No-op — extension reads the file fresh each agent_run.
  }

  async waitForIdle(): Promise<void> {
    while (!this.isIdle) await new Promise((r) => setTimeout(r, 100));
  }

  async shutdown(): Promise<void> {
    await this.pi.shutdown();
  }
}
