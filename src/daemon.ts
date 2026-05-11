/**
 * disclaw daemon — slice 3.
 *
 * Embeds an Agent (pi-agent-core) directly in this process. Owns
 * persistent router state (sysprompt slot, subscriptions, ping mode),
 * runs first-run bootstrap, accepts ctl commands over a Unix socket,
 * and routes incoming Discord events to the agent based on
 * subscriptions + ping mode (slice 3c routing).
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
import { DiscliProcess } from "./discli-io.js";
import { routeDiscordEvent, type DiscliMessageEvent } from "./routing.js";
import type { CtlRequest, CtlResponse, DaemonState, PingMode } from "./protocol.js";

const PROVIDER = process.env.DISCLAW_PROVIDER ?? "anthropic";
const MODEL = process.env.DISCLAW_MODEL ?? "claude-haiku-4-5";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

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
  if (!wasInitialized) log(`first-run bootstrap: sandbox=${SANDBOX_DIR}`);
  saveState(state);

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

  // ── Routing helper ──────────────────────────────────────────────────
  // Translates a routing decision into the right AgentHost call,
  // depending on whether the agent is currently idle.
  function deliverToAgent(mode: "push" | "follow_up", userMessage: string): void {
    if (host.isIdle) {
      // All modes collapse to prompt when idle (per design doc).
      host.prompt(userMessage).catch((err) => log(`[deliver-error] ${err.message}`));
      return;
    }
    if (mode === "push") host.steer(userMessage);
    else host.followUp(userMessage);
  }

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
            rpc: { messageCount: host.agent.state.messages.length },
          },
          router: {
            initialized: state.initialized,
            sysprompt_set: state.sysprompt.length > 0,
            sysprompt_chars: state.sysprompt.length,
            subscriptions: [...state.subscriptions],
            ping_mode: state.ping_mode,
          },
        };
        return { req_id: req.req_id, ok: true, result: out };
      }

      case "prompt": {
        if (!host.isIdle) {
          return {
            req_id: req.req_id,
            ok: false,
            error: `agent not idle (isStreaming=${host.isStreaming})`,
          };
        }
        host.prompt(req.message).catch((err) => log(`[prompt-error] ${err.message}`));
        return { req_id: req.req_id, ok: true, result: { accepted: true } };
      }

      case "sysprompt-show":
        return { req_id: req.req_id, ok: true, result: { value: state.sysprompt } };

      case "sysprompt-set":
        state = { ...state, sysprompt: req.value };
        saveState(state);
        host.updateSysprompt(req.value);
        return { req_id: req.req_id, ok: true, result: { chars: req.value.length } };

      case "sysprompt-clear":
        state = { ...state, sysprompt: "" };
        saveState(state);
        host.updateSysprompt("");
        return { req_id: req.req_id, ok: true };

      case "subscribe":
        if (!state.subscriptions.includes(req.channel_id)) {
          state = { ...state, subscriptions: [...state.subscriptions, req.channel_id] };
          saveState(state);
        }
        return {
          req_id: req.req_id,
          ok: true,
          result: { subscriptions: state.subscriptions },
        };

      case "unsubscribe":
        state = {
          ...state,
          subscriptions: state.subscriptions.filter((c) => c !== req.channel_id),
        };
        saveState(state);
        return {
          req_id: req.req_id,
          ok: true,
          result: { subscriptions: state.subscriptions },
        };

      case "list-subscriptions":
        return {
          req_id: req.req_id,
          ok: true,
          result: { subscriptions: state.subscriptions },
        };

      case "set-ping-mode": {
        const valid: PingMode[] = ["push", "follow_up", "none"];
        if (!valid.includes(req.mode)) {
          return {
            req_id: req.req_id,
            ok: false,
            error: `ping-mode must be one of: ${valid.join(", ")}`,
          };
        }
        state = { ...state, ping_mode: req.mode };
        saveState(state);
        return { req_id: req.req_id, ok: true, result: { ping_mode: req.mode } };
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

  // ── Discli (Discord side) ───────────────────────────────────────────
  let discli: DiscliProcess | undefined;
  if (DISCORD_TOKEN) {
    try {
      discli = new DiscliProcess({ token: DISCORD_TOKEN, events: ["messages"] });
      log(`[discli] spawned`);
      discli.on("event", (event: any) => {
        if (event.event === "message") {
          const msgEvent = event as DiscliMessageEvent;
          const decision = routeDiscordEvent(msgEvent, {
            subscriptions: new Set(state.subscriptions),
            ping_mode: state.ping_mode,
          });
          if (decision.kind === "drop") {
            log(
              `[discord-drop] [#${msgEvent.channel}] ${msgEvent.author}: ${decision.reason}`,
            );
            return;
          }
          log(
            `[discord-deliver] mode=${decision.mode} class=${decision.class} ` +
              `from=${msgEvent.author} #${msgEvent.channel}`,
          );
          deliverToAgent(decision.mode, decision.userMessage);
        } else if (event.event === "ready") {
          log(`[discord] ready as ${event.bot_name} (${event.bot_id})`);
        } else if (event.event === "error") {
          log(`[discord] error: ${event.message ?? "(no message)"}`);
        } else if (event.event === "disconnected") {
          log(`[discord] disconnected: code=${event.code ?? "?"} reason=${event.reason ?? "(none)"}`);
        } else {
          log(`[discord] event=${event.event}`);
        }
      });
      discli.on("error", (err: Error) => log(`[discli-error] ${err.message}`));
      discli.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) =>
        log(`[discli-exit] code=${code} signal=${signal}`),
      );
    } catch (err: any) {
      log(`[discli] failed to spawn: ${err?.message ?? err}`);
      log(`[discli] continuing without Discord side`);
    }
  } else {
    log(`[discli] DISCORD_TOKEN not set; Discord side disabled`);
  }

  const ctl = new ControlServer(handler);
  await ctl.listen();
  log(`listening at ${SOCKET_PATH}`);

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
    if (discli) await discli.shutdown();
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
