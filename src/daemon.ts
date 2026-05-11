/**
 * disclaw daemon — slice 1.
 *
 * Spawns pi --mode rpc, exposes a Unix socket control plane that
 * accepts ping / get-state / prompt commands. Logs pi events to
 * stderr with a [pi-event] prefix so they're visible during dev.
 *
 * Usage:
 *   npm run daemon
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiProcess } from "./pi-io.js";
import { ControlServer, SOCKET_PATH } from "./control.js";
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

  const pi = new PiProcess({
    command: PI_SCRIPT,
    args: ["--mode", "rpc", "--no-session", "--provider", PROVIDER, "--model", MODEL],
  });

  pi.on("event", (event: any) => {
    // Concise summary; verbose events get truncated
    const summary = event.type === "message_update"
      ? `message_update(${event.assistantMessageEvent?.type ?? "?"})`
      : event.type;
    log(`[pi-event] ${summary}`);
  });

  pi.on("error", (err: Error) => {
    log(`[pi-error] ${err.message}`);
  });

  pi.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
    log(`[pi-exit] code=${code} signal=${signal}`);
    void shutdown(1);
  });

  const handler = async (req: CtlRequest): Promise<CtlResponse> => {
    log(`[ctl] ${req.cmd} req_id=${req.req_id}`);
    switch (req.cmd) {
      case "ping":
        return { req_id: req.req_id, ok: true, result: "pong" };

      case "get-state": {
        const state: DaemonState = {
          pi: {
            isStreaming: pi.isStreaming,
            isCompacting: pi.isCompacting,
            isIdle: pi.isIdle,
          },
        };
        // Augment with pi's own get_state if pi is reachable
        try {
          const piState = await pi.send({ type: "get_state" });
          state.pi.rpc = {
            sessionId: piState.data?.sessionId,
            sessionFile: piState.data?.sessionFile,
            messageCount: piState.data?.messageCount,
            pendingMessageCount: piState.data?.pendingMessageCount,
          };
        } catch (err) {
          // Non-fatal — pi may have just exited
        }
        return { req_id: req.req_id, ok: true, result: state };
      }

      case "prompt": {
        if (!pi.isIdle) {
          return {
            req_id: req.req_id,
            ok: false,
            error: `pi not idle (isStreaming=${pi.isStreaming} isCompacting=${pi.isCompacting}); slice 1 only handles idle prompts`,
          };
        }
        const resp = await pi.send({ type: "prompt", message: req.message });
        return { req_id: req.req_id, ok: true, result: { piResponse: resp } };
      }

      default: {
        const c: never = req;
        return { req_id: (c as any).req_id ?? "", ok: false, error: `unknown cmd: ${(c as any).cmd}` };
      }
    }
  };

  const ctl = new ControlServer(handler);
  await ctl.listen();
  log(`listening at ${SOCKET_PATH}`);

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
