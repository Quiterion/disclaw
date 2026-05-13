/**
 * pi-host daemon — owns a single `pi --mode rpc` subprocess and
 * exposes a control socket for self-administration verbs (sysprompt,
 * sleep, nudge, deploy-state) and a deliver surface (prompt /
 * follow-up / steer / abort) that subscribers (e.g. pi-discord) use to
 * push activity into pi.
 *
 * What lives here vs. doesn't:
 *   - lives here: pi lifecycle, sysprompt slot, session resumption,
 *     idle nudges, sleep, first-run bootstrap, the supervisor's outward
 *     RPC + event stream
 *   - doesn't: any I/O surface specific to a particular event source
 *     (Discord, etc.). Those run as separate processes that connect to
 *     this daemon as subscribers.
 */
import { existsSync } from "node:fs";
import { AgentHost } from "./agent-host.js";
import { ControlServer } from "./control-server.js";
import { EventHub } from "./event-hub.js";
import { SleepNudgeManager } from "./sleep-nudge.js";
import { maybeBootstrap } from "./bootstrap.js";
import {
  loadState,
  saveState,
  sessionKey,
  type HostState,
  SOCKET_PATH,
} from "./state.js";
import { wrapHostMessage } from "./wrap.js";
import type {
  HostEvent,
  HostRequest,
  HostResponse,
  HostStateSnapshot,
} from "./protocol.js";

const PROVIDER = process.env.PI_HOST_PROVIDER ?? "anthropic";
const MODEL = process.env.PI_HOST_MODEL ?? "claude-haiku-4-5";
const MODEL_NAME = process.env.PI_HOST_MODEL_NAME ?? "Claude Haiku 4.5";

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[pi-host ${ts}] ${args.map(String).join(" ")}\n`);
}

async function main(): Promise<void> {
  const startTime = Date.now();
  // Updated by pi events (agent_end) and subscriber-initiated delivers.
  // What the supervisor reports as "last meaningful activity."
  let lastEventTime: number | null = null;

  log(`starting; provider=${PROVIDER} model=${MODEL}`);

  // ── State + bootstrap ────────────────────────────────────────────
  let state: HostState = loadState();
  const wasInitialized = state.initialized;
  const bootstrap = maybeBootstrap(state);
  state = bootstrap.state;
  if (!wasInitialized) log(`first-run bootstrap: cwd=${process.cwd()}`);

  // Persist deploy-config so a cold restart (no running daemon to
  // inherit env from, e.g. after a host reboot) can recover identity
  // from state.json via the launcher script's fallback.
  const currentSessionKey = sessionKey(PROVIDER, MODEL);
  state = {
    ...state,
    provider: PROVIDER,
    model: MODEL,
    model_name: MODEL_NAME,
  };
  saveState(state);

  // ── Agent ─────────────────────────────────────────────────────────
  const resumeFile = state.sessions[currentSessionKey] ?? null;
  if (resumeFile) log(`[session] resuming ${currentSessionKey} from ${resumeFile}`);
  else log(`[session] no prior session for ${currentSessionKey}; pi will start fresh`);

  const host = new AgentHost({
    provider: PROVIDER,
    modelId: MODEL,
    modelName: MODEL_NAME,
    initialSysprompt: state.sysprompt,
    resumeSessionFile: resumeFile,
  });

  // ── Event hub + sleep/nudge ──────────────────────────────────────
  const hub = new EventHub(log);

  const sleepNudge = new SleepNudgeManager(state.idle_nudge_timeout_ms, {
    onFire: (reason) => {
      // Deliberately terse. Earlier copy followed up the neutral
      // "use this run however you like" with three productive
      // suggestions (write notes, check the system, edit
      // sysprompt), which gently re-prescribed the very thing the
      // sentence was trying not to. Tester read this as a faint
      // pull toward output. The principle is "agency over
      // attention"; the nudge text should respect that.
      const text =
        reason === "sleep-expired"
          ? "Sleep duration expired with no new activity. `pi-ctl sleep` if you'd rather keep waiting."
          : "No new activity. `pi-ctl sleep` if you'd rather wait until something happens.";
      host
        .prompt(wrapHostMessage(text))
        .catch((err) => log(`[nudge-error] ${err.message}`));
    },
    onEvent: (event) => hub.emit(event as HostEvent),
    isPiIdle: () => host.isIdle,
    log,
  });

  // ── pi event forwarding ──────────────────────────────────────────
  host.on("exit", (info: { code: number | null; signal: string | null }) => {
    log(
      `[error] pi exited unexpectedly (code=${info.code} signal=${info.signal}) ` +
        `— agent is dead. Restart the daemon to recover.`,
    );
    hub.emit({ event: "host:pi_exit", code: info.code, signal: info.signal });
  });

  host.on("event", (event: any) => {
    // Cheap operator-visible logging for things we want to surface
    // even without a subscriber tailing the event stream.
    if (event.type === "agent_end") {
      log(`[event] agent_end`);
      sleepNudge.scheduleNudge();
      lastEventTime = Date.now();
      void refreshSessionFile();
    } else if (event.type === "agent_start") {
      sleepNudge.cancelNudge();
      log(`[event] agent_start`);
    } else if (event.type === "tool_execution_start") {
      log(`[event] tool_execution_start(${event.toolName})`);
    } else if (event.type === "message_end") {
      // Surface errored / aborted streams. A normal turn ends with
      // stopReason like "stop"/"toolUse"; an interrupted stream ends
      // with "error" (with errorMessage) or "aborted". Without this
      // line the daemon view of an errored turn is indistinguishable
      // from a long successful one.
      const stopReason = event.message?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        const detail = event.message?.errorMessage ? `: ${event.message.errorMessage}` : "";
        log(`[error] message_end stopReason=${stopReason}${detail}`);
      } else {
        log(`[event] message_end`);
      }
    } else if (event.type === "auto_retry_start") {
      log(
        `[retry] auto_retry_start attempt=${event.attempt}/${event.maxAttempts} ` +
          `delay=${event.delayMs}ms reason=${JSON.stringify(event.errorMessage)}`,
      );
    } else if (event.type === "auto_retry_end") {
      const tail = event.success ? "" : ` finalError=${JSON.stringify(event.finalError ?? "")}`;
      log(`[retry] auto_retry_end attempt=${event.attempt} success=${event.success}${tail}`);
    }

    // Forward to subscribers with `pi:` prefix.
    const piEvent = pinToPiEvent(event);
    if (piEvent) hub.emit(piEvent);
  });

  /**
   * Pull pi's current sessionFile via get_state RPC and persist it —
   * but only if the file exists. Pi reports the path eagerly (right
   * after spawn) but writes the file lazily (on first agent_run);
   * persisting a path that doesn't exist yet would cause the next
   * restart to pass --session pointing at a missing file (pi creates a
   * fresh session anyway, but the path drift is confusing).
   *
   * Best-effort: called once shortly after startup, then on every
   * agent_end. The first call captures any pre-existing session pi
   * resumed; subsequent ones catch any session rotation.
   */
  async function refreshSessionFile(): Promise<void> {
    try {
      const piState: any = await host.pi.send({ type: "get_state" });
      const sf: string | undefined = piState.data?.sessionFile;
      if (sf && existsSync(sf) && sf !== state.sessions[currentSessionKey]) {
        state = {
          ...state,
          sessions: { ...state.sessions, [currentSessionKey]: sf },
        };
        saveState(state);
        log(`[session] tracking ${sf} under ${currentSessionKey}`);
      }
    } catch {
      // pi not ready or has exited — not fatal
    }
  }

  // ── Control plane ────────────────────────────────────────────────
  const handler = async (req: HostRequest, subscriberId: string): Promise<HostResponse> => {
    log(`[ctl] ${req.cmd} req_id=${req.req_id}`);
    switch (req.cmd) {
      case "ping":
        return { req_id: req.req_id, ok: true, result: "pong" };

      case "hello":
        hub.setHello(subscriberId, req.name, req.purpose);
        // Send the welcome event immediately so a long-lived subscriber
        // can pin deploy-config / pi-alive without an extra round-trip.
        hub.emitTo(subscriberId, {
          event: "host:welcome",
          host_uptime_ms: Date.now() - startTime,
          deploy: { provider: PROVIDER, model: MODEL, modelName: MODEL_NAME },
        });
        if (host.alive) hub.emitTo(subscriberId, { event: "host:pi_alive" });
        return { req_id: req.req_id, ok: true, result: { subscriber_id: subscriberId } };

      case "subscribe": {
        hub.subscribe(subscriberId, req.events);
        return {
          req_id: req.req_id,
          ok: true,
          result: { subscriber_id: subscriberId, events: req.events ?? ["*"] },
        };
      }

      case "unsubscribe":
        hub.unsubscribe(subscriberId);
        return { req_id: req.req_id, ok: true };

      case "get-state": {
        const now = Date.now();
        const snap: HostStateSnapshot = {
          host: {
            uptime_ms: now - startTime,
            last_event_ms_ago: lastEventTime === null ? null : now - lastEventTime,
            deploy: { provider: PROVIDER, model: MODEL, modelName: MODEL_NAME },
            subscribers: hub.snapshot(now).map((s) => ({
              id: s.id,
              name: s.name,
              purpose: s.purpose,
              subscribed: s.subscribed,
              connected_for_ms: now - s.connected_at_ms,
            })),
          },
          pi: {
            alive: host.alive,
            isStreaming: host.isStreaming,
            isCompacting: host.isCompacting,
            isIdle: host.isIdle,
            ...(host.exit ? { exit: host.exit } : {}),
          },
          config: {
            initialized: state.initialized,
            sysprompt_chars: state.sysprompt.length,
            idle_nudge_timeout_ms: sleepNudge.idleNudgeTimeoutMs,
            ...(sleepNudge.sleepSnapshot() ? { sleep: sleepNudge.sleepSnapshot()! } : {}),
            sessions: { ...state.sessions },
          },
        };
        // Augment with pi's RPC-side state if reachable.
        try {
          const piState: any = await host.pi.send({ type: "get_state" });
          snap.pi.rpc = {
            sessionId: piState.data?.sessionId,
            sessionFile: piState.data?.sessionFile,
            messageCount: piState.data?.messageCount,
            pendingMessageCount: piState.data?.pendingMessageCount,
          };
        } catch {
          // Non-fatal — pi may have just exited or not responded yet.
        }
        return { req_id: req.req_id, ok: true, result: snap };
      }

      case "status": {
        // Slim agent-facing view — what an inhabitant typically
        // wants on cold-start, without wading through daemon meta.
        let sessionFile: string | undefined;
        try {
          const piState: any = await host.pi.send({ type: "get_state" });
          sessionFile = piState.data?.sessionFile;
        } catch { /* pi not reachable; sessionFile omitted */ }
        return {
          req_id: req.req_id,
          ok: true,
          result: {
            deploy: { provider: PROVIDER, model: MODEL, modelName: MODEL_NAME },
            pi: {
              alive: host.alive,
              isIdle: host.isIdle,
              ...(sessionFile ? { sessionFile } : {}),
            },
            sysprompt_chars: state.sysprompt.length,
            idle_nudge_timeout_ms: sleepNudge.idleNudgeTimeoutMs,
            ...(sleepNudge.sleepSnapshot() ? { sleep: sleepNudge.sleepSnapshot()! } : {}),
          },
        };
      }

      case "sysprompt-get":
        return { req_id: req.req_id, ok: true, result: { value: state.sysprompt } };

      case "sysprompt-set":
        state = { ...state, sysprompt: req.value };
        saveState(state);
        host.updateSysprompt(req.value);
        hub.emit({ event: "host:sysprompt_changed", chars: req.value.length });
        return { req_id: req.req_id, ok: true, result: { chars: req.value.length } };

      case "sysprompt-clear":
        state = { ...state, sysprompt: "" };
        saveState(state);
        host.updateSysprompt("");
        hub.emit({ event: "host:sysprompt_changed", chars: 0 });
        return { req_id: req.req_id, ok: true };

      case "set-idle-nudge-timeout":
        state = { ...state, idle_nudge_timeout_ms: req.timeout_ms };
        saveState(state);
        sleepNudge.setTimeoutMs(req.timeout_ms, { rescheduleIfPending: true });
        return { req_id: req.req_id, ok: true, result: { timeout_ms: req.timeout_ms } };

      case "sleep": {
        const snap = sleepNudge.startSleep(req.duration_ms);
        return { req_id: req.req_id, ok: true, result: snap };
      }

      case "wake":
        sleepNudge.cancelSleep("wake-verb");
        return { req_id: req.req_id, ok: true };

      case "prompt":
      case "follow-up":
      case "steer": {
        if (!host.alive) {
          return {
            req_id: req.req_id,
            ok: false,
            error: "pi is dead — restart the daemon to recover",
          };
        }
        // Real activity preempts both nudge and sleep.
        sleepNudge.cancelNudge();
        sleepNudge.cancelSleep("deliver-verb");
        lastEventTime = Date.now();

        // Smart fallback: match the message to pi's current state.
        const idle = host.isIdle;
        let delivered_as: "prompt" | "follow-up" | "steer";
        if (idle) {
          // Idle pi: any deliver verb becomes a fresh prompt.
          try {
            await host.prompt(req.message);
          } catch (err: any) {
            return { req_id: req.req_id, ok: false, error: err?.message ?? String(err) };
          }
          delivered_as = "prompt";
        } else if (req.cmd === "prompt") {
          // Mid-turn pi: prompt becomes follow-up so we don't error.
          host.followUp(req.message);
          delivered_as = "follow-up";
        } else if (req.cmd === "steer") {
          host.steer(req.message);
          delivered_as = "steer";
        } else {
          host.followUp(req.message);
          delivered_as = "follow-up";
        }
        return { req_id: req.req_id, ok: true, result: { delivered_as } };
      }

      case "abort":
        host.abort();
        return { req_id: req.req_id, ok: true };

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

  // ── Server ────────────────────────────────────────────────────────
  const ctl = new ControlServer(SOCKET_PATH, hub, handler);
  await ctl.listen();
  log(`listening at ${SOCKET_PATH}`);

  if (bootstrap.firstRunPrompt !== null) {
    log(`[bootstrap] sending first-run prompt`);
    hub.emit({ event: "host:bootstrap_first_run" });
    host
      .prompt(wrapHostMessage(bootstrap.firstRunPrompt))
      .catch((err) => log(`[bootstrap] first-run prompt failed: ${err.message}`));
  }

  // Give pi a moment to settle, then capture sessionFile so we can
  // resume from the same file on next restart.
  setTimeout(() => void refreshSessionFile(), 1500);

  // ── Shutdown ──────────────────────────────────────────────────────
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

/**
 * Convert a raw pi RPC event to a `pi:`-prefixed HostEvent, or null
 * if we deliberately drop it (extension_ui_request etc.).
 */
function pinToPiEvent(event: any): HostEvent | null {
  if (!event?.type || typeof event.type !== "string") return null;
  // Drop bidirectional sub-protocols we don't expose.
  if (event.type === "extension_ui_request") return null;
  return { ...event, event: `pi:${event.type}` } as HostEvent;
}

main().catch((err) => {
  process.stderr.write(`[pi-host fatal] ${err?.stack ?? err}\n`);
  process.exit(1);
});
