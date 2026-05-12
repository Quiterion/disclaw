/**
 * AgentHost: wraps a `pi --mode rpc` subprocess via PiProcess.
 *
 * Slice 3.5 revert: rolled back the slice-2.5 embedded-Agent approach.
 * Pi-coding-agent (subprocess) gives us session persistence, pi-acm
 * compatibility, and the full pi tool catalog (read/write/edit/grep/bash)
 * for free. The system-prompt-control concern that motivated the pivot
 * is addressed by `.pi/extensions/sysprompt/`, which REPLACES (not
 * appends) pi-coding-agent's default sysprompt with our own model-derived
 * floor + the agent's self-managed slot.
 *
 * AgentHost preserves the same outward shape that the daemon already
 * uses (prompt/followUp/steer/abort/waitForIdle/shutdown,
 * isStreaming/isCompacting/isIdle, EventEmitter for `event`). The
 * implementation underneath is now an RPC subprocess instead of an
 * in-process Agent.
 */
import { EventEmitter } from "node:events";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProcess } from "./pi-io.js";
import { SYSPROMPT_FILE } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
// Default: the npm-installed pi binary (shipped with our pi-acm peer dep
// chain). We use the @mariozechner/* namespace because pi-acm was built
// against that fork and references its packages at runtime; mixing with
// the @earendil-works/* fork in third_party/pi/ would be a peer-dep
// nightmare. Override via DISCLAW_PI_BIN if you want a different one.
const DEFAULT_PI_BIN = resolve(REPO_ROOT, "node_modules/.bin/pi");

export interface AgentHostOptions {
  /** Provider id, e.g. "anthropic". */
  provider: string;
  /** Model id, e.g. "claude-haiku-4-5". */
  modelId: string;
  /**
   * Display name for the model (e.g. "Claude Haiku 4.5"). Passed to the
   * sysprompt extension via env var so the floor sysprompt identifies
   * the right model. Falls back to modelId if not provided.
   */
  modelName?: string;
  /** Initial slot content (logged for diagnostics; not actually used). */
  initialSysprompt?: string;
  /** Path to pi binary. Default: node_modules/.bin/pi. */
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

    const piBin = opts.piBin ?? process.env.DISCLAW_PI_BIN ?? DEFAULT_PI_BIN;

    // Make `disclaw-ctl` discoverable in the agent's bash by prepending
    // bin/ to PATH. (E2E test caught the agent doing `find ~ -name disclaw*`
    // because `disclaw-ctl send` returned "command not found" — small
    // friction, easy fix here.)
    const binDir = resolve(REPO_ROOT, "bin");
    const newPath = `${binDir}:${process.env.PATH ?? ""}`;

    // Load extensions + skills via explicit absolute paths so pi finds
    // them regardless of the cwd it was spawned in. We deliberately do
    // *not* set pi's cwd; it inherits from the daemon process. For dev
    // run from a scratch dir; for prod the deploy script does
    // `cd $HOME && exec`. Either way the agent's bash defaults to that
    // cwd, while extension/skill loading is decoupled.
    const syspromptExtDir = resolve(REPO_ROOT, ".pi/extensions/sysprompt");
    const piAcmDir = resolve(REPO_ROOT, "third_party/pi-acm");
    const piAcmSkill = resolve(REPO_ROOT, "third_party/pi-acm/skills/acm");

    // If we have a previously-recorded session file path, pass it to pi
    // via --session so it resumes that session. Pi creates session files
    // lazily (on first prompt), so a path may be recorded before the
    // file actually exists; pi handles this by writing to that path
    // when the first agent_run happens. The daemon refreshes the
    // recorded path after every agent_end in case pi rotated sessions.
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
        DISCLAW_MODEL_NAME: this.modelName,
        // Pin the extension's sysprompt-file path to the same one the
        // daemon's state writes to. Without this, the extension defaults
        // to ~/.disclaw/sysprompt.txt regardless of DISCLAW_RUNTIME_DIR,
        // which leaks any prior agent's sysprompt slot into isolated
        // test runs (caught by the Opus 4.7 test instance — see
        // ~/disclaw-tests/2026-05-12_17-53-09/feedback.md).
        DISCLAW_SYSPROMPT_FILE: SYSPROMPT_FILE,
      },
      // Note: no cwd specified — pi inherits from the daemon's cwd.
    });

    // Forward pi's events. Daemon-side listener uses the same shape as
    // before (event.type, event.assistantMessageEvent, etc.).
    this.pi.on("event", (event: any) => this.emit("event", event));
    this.pi.on("error", (err: Error) => this.emit("error", err));
    this.pi.on("exit", (info) => {
      this.exitInfo = info;
      this.emit("exit", info);
    });
  }

  /**
   * True while pi is running. Goes false on pi exit (whether crash,
   * normal shutdown, or anything else). Used for cheap operator/agent
   * "is the agent still there?" checks via get-state.
   */
  get alive(): boolean {
    return this.exitInfo === null;
  }

  /** Exit info once pi has exited; null while alive. */
  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }

  get isStreaming(): boolean {
    return this.pi.isStreaming;
  }

  get isCompacting(): boolean {
    return this.pi.isCompacting;
  }

  get isIdle(): boolean {
    return this.pi.isIdle;
  }

  /**
   * Provided for backwards-compat with daemon code that expects an
   * in-process agent state object. Returns minimal shape — full state
   * is queryable via `pi.send({type: "get_state"})`.
   */
  get agent(): { state: { messages: unknown[] } } {
    // Daemon's get-state reads .messages.length; in slice 3.5+ that's
    // moved to a get_state RPC call. For now, return 0 — daemon should
    // be migrated to use pi.send({type:"get_state"}) directly.
    return { state: { messages: [] } };
  }

  /** Send a new prompt; throws if pi is not idle. */
  async prompt(message: string): Promise<void> {
    if (!this.isIdle) {
      throw new Error(
        `agent not idle (isStreaming=${this.pi.isStreaming} isCompacting=${this.pi.isCompacting})`,
      );
    }
    await this.pi.send({ type: "prompt", message });
  }

  /** Queue a message to be delivered after the current agent run finishes. */
  followUp(message: string): void {
    this.pi.send({ type: "follow_up", message }).catch(() => {});
  }

  /** Inject a message between turns within the current agent run. */
  steer(message: string): void {
    this.pi.send({ type: "steer", message }).catch(() => {});
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.pi.send({ type: "abort" }).catch(() => {});
  }

  /**
   * The sysprompt slot lives in a file the extension reads on every
   * agent_run. The daemon writes the file via state.saveState; this
   * method exists for API parity but is a no-op (the file IS the
   * source of truth, no in-memory mirror to update).
   */
  updateSysprompt(_newSlot: string): void {
    // No-op — extension reads the file fresh each agent_run.
  }

  /** Wait for any current run to settle. */
  async waitForIdle(): Promise<void> {
    while (!this.isIdle) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Best-effort shutdown — closes pi cleanly. */
  async shutdown(): Promise<void> {
    await this.pi.shutdown();
  }
}
