/**
 * disclaw daemon — slice 3.5 (post pi-coding-agent revert).
 *
 * Spawns pi-coding-agent as a subprocess via AgentHost (which wraps
 * PiProcess). Owns persistent router state (sysprompt slot,
 * subscriptions, ping mode), runs first-run bootstrap, accepts ctl
 * commands over a Unix socket, and routes incoming Discord events to
 * the agent based on subscriptions + ping mode.
 *
 * Pi-side gives us: session persistence (transcript on disk),
 * pi-acm-compatible context management, the full pi tool catalog
 * (read/write/edit/grep/bash). Our `.pi/extensions/sysprompt/`
 * REPLACES pi's default coding-assistant sysprompt with our own
 * model-derived floor + agent-managed slot.
 *
 * Usage:
 *   npm run daemon
 */
import { existsSync } from "node:fs";
import { AgentHost } from "./agent-host.js";
import { ControlServer, SOCKET_PATH } from "./control.js";
import { loadState, saveState, type RouterState } from "./state.js";
import { maybeBootstrap } from "./bootstrap.js";
import { DiscliProcess } from "./discli-io.js";
import { routeDiscordEvent, type DiscliMessageEvent } from "./routing.js";
import type { CtlRequest, CtlResponse, DaemonState, PingMode } from "./protocol.js";

const PROVIDER = process.env.DISCLAW_PROVIDER ?? "anthropic";
const MODEL = process.env.DISCLAW_MODEL ?? "claude-haiku-4-5";
const MODEL_NAME = process.env.DISCLAW_MODEL_NAME ?? "Claude Haiku 4.5";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[disclaw ${ts}] ${args.map(String).join(" ")}\n`);
}

function discordUnavailable(req_id: string): CtlResponse {
  return {
    req_id,
    ok: false,
    error: "Discord side disabled (DISCORD_TOKEN not set or discli failed to spawn)",
  };
}

async function main(): Promise<void> {
  const daemonStartTime = Date.now();
  // Updated by both the agent's event stream (on agent_end) and discli's
  // inbound events (on any Discord message). "Last time something happened"
  // is what the agent often wants to know — not "last keystroke" but
  // "last meaningful event."
  let lastEventTime: number | null = null;

  log(`starting; provider=${PROVIDER} model=${MODEL}`);

  // ── State + first-run bootstrap ─────────────────────────────────────
  // The daemon doesn't materialize a sandbox dir; deployment does that
  // (Dockerfile / setup script cd's into $HOME before exec'ing us). For
  // dev, run from a scratch dir. Bootstrap here is just the
  // initialized-flag + first-run prompt.
  let state: RouterState = loadState();
  const wasInitialized = state.initialized;
  const bootstrap = maybeBootstrap(state);
  state = bootstrap.state;
  if (!wasInitialized) log(`first-run bootstrap: cwd=${process.cwd()}`);
  saveState(state);

  // ── Build the agent ────────────────────────────────────────────────
  // Pi inherits this process's cwd. Extensions (our sysprompt + pi-acm)
  // are loaded by absolute path in AgentHost so they don't depend on
  // cwd. Session resumption: if we have a recorded session file from a
  // previous daemon run, pass it so pi continues that transcript.
  if (state.last_session_file) {
    log(`[session] resuming from ${state.last_session_file}`);
  }
  const host = new AgentHost({
    provider: PROVIDER,
    modelId: MODEL,
    modelName: MODEL_NAME,
    initialSysprompt: state.sysprompt,
    resumeSessionFile: state.last_session_file,
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
    } else {
      log(`[event] ${event.type}`);
    }

    // Idle-nudge lifecycle: cancel pending nudge when a run starts;
    // schedule a fresh nudge after a run ends.
    if (event.type === "agent_start") cancelNudgeTimer();
    if (event.type === "agent_end") {
      scheduleNudgeTimer();
      lastEventTime = Date.now();
      // Refresh tracked sessionFile in case pi rotated sessions.
      // Fire-and-forget; not worth blocking on.
      void refreshSessionFile();
    }
  });

  /**
   * Pull pi's current sessionFile via get_state RPC and persist it to
   * router state — but only if the file actually exists on disk. Pi
   * reports the sessionFile path eagerly (right after spawn) but only
   * writes the file lazily (on first agent_run). Persisting a path that
   * doesn't exist yet would mean passing --session on next restart for
   * a missing file, and pi would create a fresh session anyway. So we
   * wait until pi has actually committed content.
   *
   * Best-effort: called once shortly after startup, then on every
   * agent_end. The first call captures any pre-existing session pi
   * resumed; subsequent calls catch any session rotation.
   */
  async function refreshSessionFile(): Promise<void> {
    try {
      const piState: any = await host.pi.send({ type: "get_state" });
      const sf: string | undefined = piState.data?.sessionFile;
      if (sf && existsSync(sf) && sf !== state.last_session_file) {
        state = { ...state, last_session_file: sf };
        saveState(state);
        log(`[session] tracking ${sf}`);
      }
    } catch {
      // pi not ready or has exited — not fatal
    }
  }

  // ── Idle nudges + sleep state ───────────────────────────────────────
  // Both are in-memory only — daemon restart wakes any sleeping agent
  // and clears any pending nudge timer (which is fine: there's no
  // recent agent_end on startup to schedule from).
  let nudgeTimer: NodeJS.Timeout | null = null;
  let sleep: { until_ms: number | null; expiryTimer: NodeJS.Timeout | null } | null = null;

  function scheduleNudgeTimer(): void {
    cancelNudgeTimer();
    if (sleep) return; // sleeping suppresses nudges
    if (state.idle_nudge_timeout_ms === null) return; // off
    const ms = state.idle_nudge_timeout_ms;
    log(`[nudge] scheduled in ${ms}ms`);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      fireNudge("scheduled");
    }, ms);
  }

  function cancelNudgeTimer(): void {
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
      log(`[nudge] cancelled`);
    }
  }

  function fireNudge(reason: "scheduled" | "sleep-expired"): void {
    if (!host.isIdle) {
      log(`[nudge] skipped — pi not idle`);
      return;
    }
    log(`[nudge] firing (${reason})`);
    const text = reason === "sleep-expired"
      ? "Your sleep duration expired and no new activity arrived. " +
        "Use `disclaw-ctl sleep` again to wait some more, or use this run however you like."
      : "No new Discord activity since you last responded. " +
        "Use `disclaw-ctl sleep` to wait until something happens, or use this run however you " +
        "like — write notes, check the system, edit your sysprompt.";
    host.prompt(text).catch((err) => log(`[nudge-error] ${err.message}`));
  }

  function requestSleep(durationMs?: number): void {
    cancelNudgeTimer();
    cancelSleep(); // belt-and-braces
    const until_ms = durationMs !== undefined ? Date.now() + durationMs : null;
    const newSleep: { until_ms: number | null; expiryTimer: NodeJS.Timeout | null } = {
      until_ms,
      expiryTimer: null,
    };
    sleep = newSleep;
    if (durationMs !== undefined) {
      newSleep.expiryTimer = setTimeout(() => {
        sleep = null;
        log(`[sleep] expired`);
        fireNudge("sleep-expired");
      }, durationMs);
      log(`[sleep] starting (until ${new Date(until_ms!).toISOString()})`);
    } else {
      log(`[sleep] starting (until next event)`);
    }
  }

  function cancelSleep(): void {
    if (sleep?.expiryTimer) clearTimeout(sleep.expiryTimer);
    if (sleep) log(`[sleep] cancelled`);
    sleep = null;
  }

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
        const now = Date.now();
        const out: DaemonState = {
          daemon: {
            uptime_ms: now - daemonStartTime,
            last_event_ms_ago: lastEventTime === null ? null : now - lastEventTime,
          },
          pi: {
            isStreaming: host.isStreaming,
            isCompacting: host.isCompacting,
            isIdle: host.isIdle,
          },
          router: {
            initialized: state.initialized,
            sysprompt_set: state.sysprompt.length > 0,
            sysprompt_chars: state.sysprompt.length,
            subscriptions: [...state.subscriptions],
            ping_mode: state.ping_mode,
            idle_nudge_timeout_ms: state.idle_nudge_timeout_ms,
            ...(sleep ? { sleep: { until_ms: sleep.until_ms } } : {}),
          },
        };
        // Augment with pi's RPC-side state if reachable.
        try {
          const piState: any = await host.pi.send({ type: "get_state" });
          out.pi.rpc = {
            sessionId: piState.data?.sessionId,
            sessionFile: piState.data?.sessionFile,
            messageCount: piState.data?.messageCount,
            pendingMessageCount: piState.data?.pendingMessageCount,
          };
        } catch {
          // Non-fatal — pi may have just exited or not responded yet.
        }
        return { req_id: req.req_id, ok: true, result: out };
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

      case "set-idle-nudge-timeout": {
        state = { ...state, idle_nudge_timeout_ms: req.timeout_ms };
        saveState(state);
        // If pi is currently idle, reschedule (or cancel) the timer to
        // reflect the new value immediately. (No-op if nothing pending.)
        if (host.isIdle && nudgeTimer !== null) {
          scheduleNudgeTimer();
        }
        return {
          req_id: req.req_id,
          ok: true,
          result: { idle_nudge_timeout_ms: req.timeout_ms },
        };
      }

      case "sleep":
        requestSleep(req.duration_ms);
        return {
          req_id: req.req_id,
          ok: true,
          result: sleep
            ? { until_ms: sleep.until_ms ?? null }
            : { until_ms: null },
        };

      case "wake":
        cancelSleep();
        // After a manual wake, don't auto-fire a nudge — the agent woke
        // by their own action and gets to wait for events / next agent_end.
        return { req_id: req.req_id, ok: true };

      case "discord-send": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "send",
          channel_id: req.channel_id,
          content: req.content,
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "discord-history": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "message_list",
          channel_id: req.channel_id,
          ...(req.limit ? { limit: req.limit } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "discord-channels": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "channel_list",
          ...(req.guild_id ? { guild_id: req.guild_id } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
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
            bot_id: discli?.botId,
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
          // A real event preempts both pending nudge and active sleep.
          // (Nudge will be re-scheduled at the next agent_end via the
          // host event handler; sleep just clears.)
          cancelNudgeTimer();
          if (sleep) cancelSleep();
          lastEventTime = Date.now();
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

  // Give pi a moment to settle, then capture its sessionFile path so
  // we can resume from the same file on next restart. (pi populates
  // sessionFile lazily but typically very early; this catches it.)
  setTimeout(() => void refreshSessionFile(), 1500);

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
