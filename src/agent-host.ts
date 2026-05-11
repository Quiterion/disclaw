/**
 * AgentHost: thin wrapper around an embedded pi-agent-core Agent.
 *
 * Replaces slice 1's PiProcess (which spawned `pi --mode rpc`). The
 * Agent runs in this same Node process; we own the system prompt
 * directly, register only the tools we want, and observe events via
 * the same agent_start / turn_start / turn_end / agent_end stream we
 * already verified in slice 0.
 *
 * Key changes from PiProcess:
 *   - No subprocess. No JSONL framing.
 *   - System prompt is `floor + (sysprompt slot ? "\n\n" + slot : "")`.
 *     Refreshed before every prompt() so writes to the slot take effect
 *     on the next agent_run (not retroactively, not silently).
 *   - Tools we explicitly register (slice 2.5: bash). Coding-agent's
 *     baked-in tools and system prompt are NOT in the picture.
 */
import { EventEmitter } from "node:events";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

export interface AgentHostOptions {
  /** Provider id, e.g. "anthropic". */
  provider: string;
  /** Model id, e.g. "claude-haiku-4-5". */
  modelId: string;
  /** Floor system prompt (immutable; set once at construction). */
  floorSystemPrompt: string;
  /** Initial slot content (loaded from persisted state). May be empty. */
  initialSysprompt: string;
  /** Tools the agent has access to. */
  tools: AgentTool<any>[];
}

export class AgentHost extends EventEmitter {
  readonly agent: Agent;
  private readonly floor: string;
  private slot: string;
  private _isStreaming = false;
  private _isCompacting = false; // pi-agent-core has no built-in compaction events; reserved for future transformContext-driven signal

  constructor(opts: AgentHostOptions) {
    super();
    this.floor = opts.floorSystemPrompt;
    this.slot = opts.initialSysprompt;

    const model = getModel(opts.provider as any, opts.modelId);
    if (!model) {
      throw new Error(`Unknown model: ${opts.provider}/${opts.modelId}`);
    }

    this.agent = new Agent({
      initialState: {
        systemPrompt: this.buildSystemPrompt(),
        model,
        tools: opts.tools,
      },
    });

    this.agent.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") this._isStreaming = true;
      if (event.type === "agent_end") this._isStreaming = false;
      this.emit("event", event);
    });
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  get isIdle(): boolean {
    return !this._isStreaming && !this._isCompacting;
  }

  get sysprompt(): string {
    return this.slot;
  }

  /** Update the system-prompt slot. Takes effect on the next prompt(). */
  updateSysprompt(newSlot: string): void {
    this.slot = newSlot;
  }

  /** Refresh systemPrompt on the agent state from current floor + slot. */
  private refreshSystemPrompt(): void {
    this.agent.state.systemPrompt = this.buildSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return this.slot ? `${this.floor}\n\n${this.slot}` : this.floor;
  }

  /** Send a new prompt; throws if pi is not idle. */
  async prompt(message: string): Promise<void> {
    if (!this.isIdle) {
      throw new Error(
        `agent not idle (isStreaming=${this._isStreaming} isCompacting=${this._isCompacting}); ` +
          "use followUp() or steer() to queue while streaming",
      );
    }
    this.refreshSystemPrompt();
    await this.agent.prompt(message);
  }

  /** Queue a message for delivery after the current agent_run finishes. */
  followUp(message: string): void {
    this.agent.followUp({ role: "user", content: message, timestamp: Date.now() });
  }

  /** Inject a message between turns within the current agent_run. */
  steer(message: string): void {
    this.agent.steer({ role: "user", content: message, timestamp: Date.now() });
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.agent.abort();
  }

  /** Wait for any current run + listeners to settle. */
  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  /** Best-effort shutdown — abort if streaming, then wait. */
  async shutdown(): Promise<void> {
    if (this._isStreaming) this.agent.abort();
    await this.agent.waitForIdle();
  }
}
