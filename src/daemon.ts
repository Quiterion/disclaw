/**
 * disclaw daemon — slice 2.
 *
 * Spawns pi --mode rpc, exposes a Unix socket control plane, owns the
 * persistent router state (sysprompt slot, init flag), runs first-run
 * bootstrap if needed, and seeds pi with the first-run prompt once.
 *
 * Usage:
 *   npm run daemon
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProcess } from "./pi-io.js";
import { ControlServer, SOCKET_PATH } from "./control.js";
import { loadState, saveState, type RouterState } from "./state.js";
import { maybeBootstrap, SANDBOX_DIR } from "./bootstrap.js";
import type { CtlRequest, CtlResponse, DaemonState } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_SCRIPT = resolve(__dirname, "../third_party/pi/pi-test.sh");
const PROVIDER = process.env.DISCLAW_PROVIDER ?? "anthropic";
const MODEL = process.env.DISCLAW_MODEL ?? "claude-haiku-4-5";

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[disclaw ${ts}] ${args.map(String).join(" ")}\n`);
}

async function main(): Promise<void> {
  log(`starting; pi=${PI_SCRIPT} provider=${PROVIDER} model=${MODEL}`);

  // ── State + first-run bootstrap ─────────────────────────────────────
  let state: RouterState = loadState();
  const wasInitialized = state.initialized;
  const bootstrap = maybeBootstrap(state);
  state = bootstrap.state;
  if (!wasInitialized) {
    log(`first-run bootstrap: sandbox=${SANDBOX_DIR}`);
  }
  saveState(state);

  // ── Spawn pi ────────────────────────────────────────────────────────
  // Use the sandbox dir as cwd so pi-acm sidecars and any extension state
  // colocate with the agent's space. Also makes pi pick up the sandbox's
  // .pi/extensions/ if present.
  const pi = new PiProcess({
    command: PI_SCRIPT,
    args: ["--mode", "rpc", "--no-session", "--provider", PROVIDER, "--model", MODEL],
  });

  let assistantTextBuffer = "";
  pi.on("event", (event: any) => {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      // Accumulate assistant text for debug visibility; flushed at agent_end.
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        assistantTextBuffer += ame.delta;
      }
      log(`[pi-event] message_update(${ame?.type ?? "?"})`);
      return;
    }
    if (event.type === "agent_end" && assistantTextBuffer) {
      log(`[pi-text] ${JSON.stringify(assistantTextBuffer)}`);
      assistantTextBuffer = "";
    }
    log(`[pi-event] ${event.type}`);
  });

  pi.on("error", (err: Error) => log(`[pi-error] ${err.message}`));

  pi.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
    log(`[pi-exit] code=${code} signal=${signal}`);
    void shutdown(1);
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
            isStreaming: pi.isStreaming,
            isCompacting: pi.isCompacting,
            isIdle: pi.isIdle,
          },
          router: {
            initialized: state.initialized,
            sysprompt_set: state.sysprompt.length > 0,
            sysprompt_chars: state.sysprompt.length,
          },
        };
        try {
          const piState = await pi.send({ type: "get_state" });
          out.pi.rpc = {
            sessionId: piState.data?.sessionId,
            sessionFile: piState.data?.sessionFile,
            messageCount: piState.data?.messageCount,
            pendingMessageCount: piState.data?.pendingMessageCount,
          };
        } catch {
          // Non-fatal
        }
        return { req_id: req.req_id, ok: true, result: out };
      }

      case "prompt": {
        if (!pi.isIdle) {
          return {
            req_id: req.req_id,
            ok: false,
            error:
              `pi not idle (isStreaming=${pi.isStreaming} isCompacting=${pi.isCompacting}); ` +
              `slice 2 only handles idle prompts`,
          };
        }
        const resp = await pi.send({ type: "prompt", message: req.message });
        return { req_id: req.req_id, ok: true, result: { piResponse: resp } };
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
        return {
          req_id: req.req_id,
          ok: true,
          result: { chars: req.value.length },
        };
      }

      case "sysprompt-clear": {
        state = { ...state, sysprompt: "" };
        saveState(state);
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

  // ── Send first-run prompt once pi is ready ──────────────────────────
  // Pi accepts stdin commands as soon as it's spawned (Node buffers writes
  // until pi reads). For the first-run case, fire the prompt now; pi will
  // process it once its init finishes.
  if (bootstrap.firstRunPrompt !== null) {
    log(`[bootstrap] sending first-run prompt`);
    pi.send({ type: "prompt", message: bootstrap.firstRunPrompt }).catch((err) => {
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
    await pi.shutdown();
    process.exit(code);
  }

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

main().catch((err) => {
  process.stderr.write(`[disclaw fatal] ${err?.stack ?? err}\n`);
  process.exit(1);
});
