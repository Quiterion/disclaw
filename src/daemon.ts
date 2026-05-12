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
import { BufferManager } from "./buffering.js";
import { wrapDisclaw } from "./formatting.js";
import { DigestAccumulator, formatDigest } from "./digest.js";
import { clearMissedPings, readMissedPings, recordMissedPing } from "./missed-pings.js";
import { MISSED_PINGS_FILE } from "./state.js";
import type { CtlRequest, CtlResponse, DaemonState, DigestMode, PingMode } from "./protocol.js";

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

  // Tier 1 pi-exit visibility. Pi is the agent; if it exits we're a
  // daemon with no agent to drive — surface loudly so the operator
  // (or the agent inspecting via ctl) sees it. No auto-respawn yet.
  host.on("exit", (info: { code: number | null; signal: string | null }) => {
    log(
      `[error] pi process exited unexpectedly (code=${info.code} signal=${info.signal}) ` +
        `— agent is dead. Restart the daemon to recover.`,
    );
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
    } else if (event.type === "message_end") {
      // Surface errored/aborted streams. A normal turn ends with stopReason
      // like "stop"/"toolUse"; an interrupted API stream ends with
      // stopReason="error" (with errorMessage) or "aborted". Without this
      // log line the daemon view of an errored turn is indistinguishable
      // from a long successful one — see 2026-05-12 09:11:17 incident
      // where a 5-min "terminated" turn looked like normal streaming.
      const msg = event.message;
      const stopReason = msg?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        const detail = msg?.errorMessage ? `: ${msg.errorMessage}` : "";
        log(`[error] message_end stopReason=${stopReason}${detail}`);
      } else {
        log(`[event] ${event.type}`);
      }
    } else if (event.type === "auto_retry_start") {
      log(
        `[retry] auto_retry_start attempt=${event.attempt}/${event.maxAttempts} ` +
          `delay=${event.delayMs}ms reason=${JSON.stringify(event.errorMessage)}`,
      );
    } else if (event.type === "auto_retry_end") {
      const tail = event.success ? "" : ` finalError=${JSON.stringify(event.finalError ?? "")}`;
      log(`[retry] auto_retry_end attempt=${event.attempt} success=${event.success}${tail}`);
    } else {
      log(`[event] ${event.type}`);
    }

    // Idle-nudge lifecycle: cancel pending nudge when a run starts;
    // schedule a fresh nudge after a run ends.
    if (event.type === "agent_start") cancelNudgeTimer();
    if (event.type === "agent_end") {
      // Flush any follow_up events that accumulated during the run.
      // (Push events flush on their own debounce; prompt events only
      // exist when pi was idle, so they're not relevant here.)
      buffer.flush("follow_up");
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
    host.prompt(composeAndWrap(text)).catch((err) => log(`[nudge-error] ${err.message}`));
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

  // ── Activity digest ─────────────────────────────────────────────────
  // Counts of unsubscribed-channel non-mention messages since the last
  // flush. Piggybacks on whatever flush fires next; resets on drain.
  // `composeAndWrap` is the single place that both buffered batches and
  // standalone messages (idle nudges, bootstrap) go through, so the
  // digest tail attaches uniformly without each call site re-deriving
  // it.
  const digest = new DigestAccumulator();

  function composeAndWrap(coreBody: string): string {
    if (state.digest_mode !== "follow_up" || digest.isEmpty()) {
      return wrapDisclaw(coreBody);
    }
    // Wrap the digest tail in <digest>...</digest> for a parser-
    // unambiguous boundary (otherwise a literal "[unread] ..." in a
    // user message would be indistinguishable from the daemon-injected
    // tail).
    const tail = formatDigest(digest.drain());
    if (!tail) return wrapDisclaw(coreBody);
    const tailWrapped = `<digest>${tail}</digest>`;
    return wrapDisclaw(coreBody ? `${coreBody}\n\n${tailWrapped}` : tailWrapped);
  }

  // ── Buffering layer ─────────────────────────────────────────────────
  // Per-mode event buffers + flush triggers. Routing classifies an
  // arriving Discord event; the daemon enqueues into the appropriate
  // buffer depending on pi's current state (idle → prompt; streaming →
  // the routed mode). Flushes:
  //   - follow_up: triggered explicitly on agent_end below
  //   - push, prompt: short debounce window (default 500ms from first
  //     event in the buffer), then flush automatically
  // At flush time the buffer drains into a formatted user-message body
  // (formatting.ts), gets wrapped in `<disclaw>...</disclaw>`, and
  // dispatches via the appropriate AgentHost method.
  const buffer = new BufferManager({
    dispatch: (kind, body) => {
      // Tier 1 dead-pi check: avoid silently routing into a black hole
      // (host.followUp/.steer swallow "pi has exited" via .catch).
      // Surface clearly instead so the operator sees what's being lost.
      if (!host.alive) {
        log(
          `[drop] pi is dead — dropping ${kind} delivery (${body.length} chars). ` +
            `Restart the daemon to recover.`,
        );
        return;
      }
      const wrapped = composeAndWrap(body);
      // Re-check pi state at dispatch time. The "prompt" buffer might
      // have been queued while pi was idle but pi could have started
      // streaming during the debounce — in that case route as follow_up.
      if (kind === "prompt" && !host.isIdle) {
        host.followUp(wrapped);
        return;
      }
      // Symmetric: if a "push"/"follow_up" buffer flushes and pi is
      // somehow idle (unusual but possible), deliver as prompt.
      if (kind !== "prompt" && host.isIdle) {
        host.prompt(wrapped).catch((err) => log(`[deliver-error] ${err.message}`));
        return;
      }
      if (kind === "push") host.steer(wrapped);
      else if (kind === "follow_up") host.followUp(wrapped);
      else host.prompt(wrapped).catch((err) => log(`[deliver-error] ${err.message}`));
    },
  });

  // ── Typing indicators ───────────────────────────────────────────────
  // Per-channel auto-stop timers. Discli's typing_start kicks off a
  // background loop that refreshes typing every ~5s; without us
  // calling typing_stop it runs forever. Default 60s auto-stop on
  // typing-start protects against the agent forgetting to clear, and
  // discord-send does an implicit clear for "they sent the message,
  // typing is now noise."
  const typingTimers = new Map<string, NodeJS.Timeout>();

  function clearTypingTimer(channel_id: string): void {
    const t = typingTimers.get(channel_id);
    if (t) {
      clearTimeout(t);
      typingTimers.delete(channel_id);
    }
  }

  async function stopTyping(channel_id: string): Promise<void> {
    clearTypingTimer(channel_id);
    if (!discli) return;
    await discli.sendAction({ action: "typing_stop", channel_id });
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
            alive: host.alive,
            ...(host.exit ? { exit: host.exit } : {}),
          },
          router: {
            initialized: state.initialized,
            sysprompt_set: state.sysprompt.length > 0,
            sysprompt_chars: state.sysprompt.length,
            subscriptions: [...state.subscriptions],
            ping_mode: state.ping_mode,
            digest_mode: state.digest_mode,
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

      case "set-digest-mode": {
        const valid: DigestMode[] = ["follow_up", "none"];
        if (!valid.includes(req.mode)) {
          return {
            req_id: req.req_id,
            ok: false,
            error: `digest-mode must be one of: ${valid.join(", ")}`,
          };
        }
        state = { ...state, digest_mode: req.mode };
        saveState(state);
        return { req_id: req.req_id, ok: true, result: { digest_mode: req.mode } };
      }

      case "digest": {
        // Peek (non-destructive). The agent inspecting the digest
        // doesn't reset the counter — only a flush dispatch (or absent
        // it, the next idle nudge with digest_mode=follow_up) drains.
        return {
          req_id: req.req_id,
          ok: true,
          result: { entries: digest.peek(), mode: state.digest_mode },
        };
      }

      case "digest-ack": {
        // Explicit "I've read this" — the agent can dismiss the
        // accumulated count for one channel (or all) without waiting
        // for a flush to drain it. Decoupled from `history` and
        // `digest` (peek) so inspection has no side effects.
        const cleared = digest.clear(req.channel_id);
        return {
          req_id: req.req_id,
          ok: true,
          result: { cleared, scope: req.channel_id ?? "all" },
        };
      }

      case "missed-pings": {
        const all = readMissedPings(MISSED_PINGS_FILE);
        const limit = req.limit;
        const entries = limit !== undefined && limit > 0 ? all.slice(-limit) : all;
        return {
          req_id: req.req_id,
          ok: true,
          result: { entries, total: all.length, file: MISSED_PINGS_FILE },
        };
      }

      case "missed-pings-clear": {
        const before = readMissedPings(MISSED_PINGS_FILE).length;
        clearMissedPings(MISSED_PINGS_FILE);
        return {
          req_id: req.req_id,
          ok: true,
          result: { cleared: before },
        };
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
        // Implicit typing-stop: if the agent had typing active for this
        // channel, sending makes it redundant (and the agent shouldn't
        // have to remember to clear it). Clears any auto-stop timer too.
        stopTyping(req.channel_id).catch(() => { /* best effort */ });
        return { req_id: req.req_id, ok: true, result };
      }

      case "discord-typing-start": {
        if (!discli) return discordUnavailable(req.req_id);
        await discli.sendAction({
          action: "typing_start",
          channel_id: req.channel_id,
        });
        // Schedule auto-stop. Default 60s if duration not specified.
        // Replace any existing timer (latest call wins).
        const ms = req.duration_ms ?? 60_000;
        clearTypingTimer(req.channel_id);
        typingTimers.set(
          req.channel_id,
          setTimeout(() => {
            typingTimers.delete(req.channel_id);
            stopTyping(req.channel_id).catch(() => {});
          }, ms),
        );
        return { req_id: req.req_id, ok: true, result: { duration_ms: ms } };
      }

      case "discord-typing-stop": {
        if (!discli) return discordUnavailable(req.req_id);
        await stopTyping(req.channel_id);
        return { req_id: req.req_id, ok: true };
      }

      case "discord-whois": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "member_search",
          name: req.name,
          ...(req.guild_id ? { guild_id: req.guild_id } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "discord-react": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "reaction_add",
          channel_id: req.channel_id,
          message_id: req.message_id,
          emoji: req.emoji,
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "discord-unreact": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "reaction_remove",
          channel_id: req.channel_id,
          message_id: req.message_id,
          emoji: req.emoji,
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
            // Unsubscribed-channel non-mentions feed the activity digest.
            // Pings dropped because ping_mode=none get appended to the
            // missed-pings log so the agent can review on demand without
            // having taken the interruption. (Self-messages — bot's own
            // echo — are neither.)
            if (decision.reason === "unsubscribed channel, no mention") {
              digest.note(msgEvent);
            } else if (decision.reason.startsWith("ping-mode is none")) {
              try {
                recordMissedPing(MISSED_PINGS_FILE, msgEvent);
              } catch (err: any) {
                log(`[missed-pings-error] ${err?.message ?? err}`);
              }
            }
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
          // Enqueue into the appropriate buffer. If pi is idle, the
          // event goes to the prompt buffer (debounce → flush as
          // prompt). Otherwise it goes to the routed mode (push or
          // follow_up). Buffering coalesces bursts; formatting (and
          // the <disclaw> wrap) happens at flush time.
          const bufferKind = host.isIdle ? "prompt" : decision.mode;
          buffer.add(bufferKind, {
            ev: msgEvent,
            class: decision.class,
            arrivedAt: Date.now(),
          });
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
    host.prompt(composeAndWrap(bootstrap.firstRunPrompt)).catch((err) => {
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
