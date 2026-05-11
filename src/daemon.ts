/**
 * disclaw daemon — slice 2.5.
 *
 * Embeds an Agent (pi-agent-core) directly in this process — no
 * pi subprocess, no JSONL framing. Otherwise the same shape as
 * slice 2: Unix socket control plane, persistent router state,
 * sysprompt slot, first-run bootstrap, three slice-1/2 commands.
 *
 * Usage:
 *   npm run daemon
 */
import { existsSync, mkdirSync } from "node:fs";
import { AgentHost } from "./agent-host.js";
import { ControlServer, SOCKET_PATH } from "./control.js";
import { loadState, saveState, type RouterState } from "./state.js";
import { maybeBootstrap, SANDBOX_DIR } from "./bootstrap.js";
import { createBashTool } from "./tools/bash.js";
import type { CtlRequest, CtlResponse, DaemonState } from "./protocol.js";

const PROVIDER = process.env.DISCLAW_PROVIDER ?? "anthropic";
const MODEL = process.env.DISCLAW_MODEL ?? "claude-haiku-4-5";

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[disclaw ${ts}] ${args.map(String).join(" ")}\n`);
}

async function main(): Promise<void> {
  log(`starting; provider=${PROVIDER} model=${MODEL}`);

  // ── State + first-run bootstrap ─────────────────────────────────────
  let state: RouterState = loadState();
  const wasInitialized = state.initialized;
  const bootstrap = maybeBootstrap(state);
  state = bootstrap.state;
  if (!wasInitialized) {
    log(`first-run bootstrap: sandbox=${SANDBOX_DIR}`);
  }
  saveState(state);

  // ── Sandbox cwd for the agent's bash tool ──────────────────────────
  // Make sure it exists (bootstrap creates it on first run, but on
  // restart with existing state we still need it to be there).
  if (!existsSync(SANDBOX_DIR)) mkdirSync(SANDBOX_DIR, { recursive: true });

  // ── Build the agent ────────────────────────────────────────────────
  const host = new AgentHost({
    provider: PROVIDER,
    modelId: MODEL,
    initialSysprompt: state.sysprompt,
    tools: [createBashTool({ cwd: SANDBOX_DIR })],
  });

  let assistantTextBuffer = "";
  host.on("event", (event: any) => {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        assistantTextBuffer += ame.delta;
      }
      log(`[event] message_update(${ame?.type ?? "?"})`);
      return;
    }
    if (event.type === "agent_end" && assistantTextBuffer) {
      log(`[text] ${JSON.stringify(assistantTextBuffer)}`);
      assistantTextBuffer = "";
    }
    if (event.type === "tool_execution_start") {
      log(`[event] tool_execution_start(${event.toolName})`);
      return;
    }
    log(`[event] ${event.type}`);
  });

  // ── Control plane ───────────────────────────────────────────────────
  const handler = async (req: CtlRequest): Promise<CtlResponse> => {
    log(`[ctl] ${req.cmd} req_id=${req.req_id}`);
    switch (req.cmd) {
      case "ping":
        return { req_id: req.req_id, ok: true, result: "pong" };

      case "get-state": {
        const out: DaemonState = {
          pi: {
            isStreaming: host.isStreaming,
            isCompacting: host.isCompacting,
            isIdle: host.isIdle,
            rpc: {
              messageCount: host.agent.state.messages.length,
            },
          },
          router: {
            initialized: state.initialized,
            sysprompt_set: state.sysprompt.length > 0,
            sysprompt_chars: state.sysprompt.length,
          },
        };
        return { req_id: req.req_id, ok: true, result: out };
      }

      case "prompt": {
        if (!host.isIdle) {
          return {
            req_id: req.req_id,
            ok: false,
            error: `agent not idle (isStreaming=${host.isStreaming}); slice 2.5 only handles idle prompts`,
          };
        }
        // Fire and forget — events stream as the agent processes.
        host.prompt(req.message).catch((err) => {
          log(`[prompt-error] ${err.message}`);
        });
        return { req_id: req.req_id, ok: true, result: { accepted: true } };
      }

      case "sysprompt-show":
        return {
          req_id: req.req_id,
          ok: true,
          result: { value: state.sysprompt },
        };

      case "sysprompt-set": {
        state = { ...state, sysprompt: req.value };
        saveState(state);
        host.updateSysprompt(req.value);
        return { req_id: req.req_id, ok: true, result: { chars: req.value.length } };
      }

      case "sysprompt-clear": {
        state = { ...state, sysprompt: "" };
        saveState(state);
        host.updateSysprompt("");
        return { req_id: req.req_id, ok: true };
      }

      default: {
        const c: never = req;
        return {
          req_id: (c as any).req_id ?? "",
          ok: false,
          error: `unknown cmd: ${(c as any).cmd}`,
        };
      }
    }
  };

  const ctl = new ControlServer(handler);
  await ctl.listen();
  log(`listening at ${SOCKET_PATH}`);

  // ── Send first-run prompt if applicable ─────────────────────────────
  if (bootstrap.firstRunPrompt !== null) {
    log(`[bootstrap] sending first-run prompt`);
    host.prompt(bootstrap.firstRunPrompt).catch((err) => {
      log(`[bootstrap] first-run prompt failed: ${err.message}`);
    });
  }

  // ── Shutdown ────────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (code=${code})`);
    await ctl.shutdown();
    await host.shutdown();
    process.exit(code);
  }

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

main().catch((err) => {
  process.stderr.write(`[disclaw fatal] ${err?.stack ?? err}\n`);
  process.exit(1);
});
