/**
 * pi-discord daemon — bridge between Discord (via discli) and the
 * pi-host daemon.
 *
 * Owns:
 *   - the discli subprocess (Discord ↔ JSONL bridge)
 *   - routing state (subscriptions, ping_mode, digest_mode)
 *   - per-mode buffering + digest accumulator + missed-pings log
 *   - the pi-discord-ctl unix socket
 *   - a single subscriber connection to pi-host
 *
 * Does not own:
 *   - pi-coding-agent — pi-host's exclusive domain
 *   - sysprompt slot, idle nudges, sleep — pi-host's concerns
 *   - bootstrap / first-run prompt — pi-host owns the supervisor
 *     surface
 */
import { DiscliProcess } from "./discli-io.js";
import {
  loadState,
  saveState,
  SOCKET_PATH,
  PI_HOST_SOCKET,
  MISSED_PINGS_FILE,
  type RouterState,
} from "./state.js";
import { routeDiscordEvent, type DiscliMessageEvent } from "./routing.js";
import { BufferManager } from "./buffering.js";
import { wrapDiscord } from "./formatting.js";
import { DigestAccumulator, formatDigest } from "./digest.js";
import {
  clearMissedPings,
  readMissedPings,
  recordMissedPing,
} from "./missed-pings.js";
import { ControlServer } from "./control-server.js";
import { PiHostClient } from "./pi-host-client.js";
import type {
  DigestMode,
  DiscordCtlRequest,
  DiscordCtlResponse,
  DiscordDaemonState,
  PingMode,
} from "./protocol.js";

const DISCORD_TOKEN =
  process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[pi-discord ${ts}] ${args.map(String).join(" ")}\n`);
}

function discordUnavailable(req_id: string): DiscordCtlResponse {
  return {
    req_id,
    ok: false,
    error:
      "Discord side disabled (DISCORD_BOT_TOKEN not set or discli failed to spawn)",
  };
}

function piHostUnavailable(req_id: string): DiscordCtlResponse {
  return {
    req_id,
    ok: false,
    error:
      `pi-host not reachable at ${PI_HOST_SOCKET} — is pi-host running? ` +
      `Discord events are being buffered; they'll deliver when pi-host comes back.`,
  };
}

async function main(): Promise<void> {
  const startTime = Date.now();
  let lastEventTime: number | null = null;

  log(
    `starting; pi-host socket=${PI_HOST_SOCKET}, pi-discord socket=${SOCKET_PATH}`,
  );

  let state: RouterState = loadState();

  // ── pi-host client ──────────────────────────────────────────────
  // Tracks pi state from the event stream so we can pick the right
  // buffer kind at routing time. piIdle defaults to true (no agent run
  // assumed in flight until pi-host tells us otherwise).
  let piIdle = true;
  let deploy: { provider: string; model: string; modelName: string } | undefined;
  const piHost = new PiHostClient({
    socketPath: PI_HOST_SOCKET,
    name: "pi-discord",
    purpose: "discord-bridge",
    log,
  });

  piHost.on("event", (event: any) => {
    switch (event.event) {
      case "host:welcome":
        deploy = event.deploy;
        log(`[pi-host] welcome deploy=${event.deploy?.provider}/${event.deploy?.model}`);
        break;
      case "host:pi_alive":
        log(`[pi-host] pi_alive`);
        break;
      case "host:pi_exit":
        log(
          `[pi-host] pi_exit code=${event.code} signal=${event.signal} ` +
            `— deliveries will fail until pi-host respawns pi`,
        );
        piIdle = true; // reset
        break;
      case "host:bootstrap_first_run":
        log(`[pi-host] bootstrap_first_run`);
        break;
      case "pi:agent_start":
        piIdle = false;
        break;
      case "pi:agent_end":
        piIdle = true;
        // Flush any follow_up events accumulated during the run.
        buffer.flush("follow_up");
        lastEventTime = Date.now();
        break;
      case "pi:compaction_start":
        piIdle = false;
        break;
      case "pi:compaction_end":
        piIdle = true;
        break;
      case "host:sleep_started":
      case "host:sleep_expired":
      case "host:sleep_cancelled":
      case "host:nudge_fired":
        // Informational; we don't act on these directly. Could surface
        // in future as e.g. Discord presence status.
        break;
    }
  });

  piHost.on("disconnect", () => {
    log(`[pi-host] disconnect — buffers will accumulate until reconnect`);
  });

  // ── Activity digest + composeAndWrap ─────────────────────────────
  // Wraps a body in <discord>...</discord> and appends the digest tail
  // when digest_mode = follow_up. Identical to the previous flow; the
  // single composition path means every dispatch (buffered batches,
  // digest-only flushes, future supervisor-injected notes) gets the
  // tail attached uniformly.
  const digest = new DigestAccumulator();

  function composeAndWrap(coreBody: string): string {
    if (state.digest_mode !== "follow_up" || digest.isEmpty()) {
      return wrapDiscord(coreBody);
    }
    const tail = formatDigest(digest.drain());
    if (!tail) return wrapDiscord(coreBody);
    const tailWrapped = `<digest>${tail}</digest>`;
    return wrapDiscord(coreBody ? `${coreBody}\n\n${tailWrapped}` : tailWrapped);
  }

  // ── Buffering ────────────────────────────────────────────────────
  // Dispatch picks the matching pi-host verb:
  //   prompt buffer → cmd:"prompt"   (deliver as a fresh turn)
  //   push buffer   → cmd:"steer"    (interrupt between turns)
  //   follow_up     → cmd:"follow-up" (queue for after current turn)
  // pi-host applies smart-fallback if pi's state doesn't match the
  // verb (e.g. prompt while streaming → delivered as follow-up); the
  // bridge just sends its intent.
  const buffer = new BufferManager({
    dispatch: (kind, body) => {
      if (!piHost.connected) {
        log(
          `[drop] pi-host disconnected — dropping ${kind} delivery (${body.length} chars). ` +
            `Buffer is lost; events arriving after reconnect will accumulate fresh.`,
        );
        return;
      }
      const wrapped = composeAndWrap(body);
      const cmd =
        kind === "prompt" ? "prompt" : kind === "push" ? "steer" : "follow-up";
      piHost
        .send({ cmd, message: wrapped })
        .catch((err: Error) => log(`[deliver-error] ${err.message}`));
    },
  });

  // ── Typing indicators ────────────────────────────────────────────
  // Per-channel auto-stop timers. discli's typing_start kicks off a
  // background loop that refreshes typing every ~5s; without us
  // calling typing_stop it runs forever. Default 60s auto-stop on
  // typing-start protects against the agent forgetting to clear, and
  // an implicit clear on send is wired below.
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

  // ── Control plane ────────────────────────────────────────────────
  const handler = async (req: DiscordCtlRequest): Promise<DiscordCtlResponse> => {
    log(`[ctl] ${req.cmd} req_id=${req.req_id}`);
    switch (req.cmd) {
      case "ping":
        return { req_id: req.req_id, ok: true, result: "pong" };

      case "get-state": {
        const now = Date.now();
        const out: DiscordDaemonState = {
          daemon: {
            uptime_ms: now - startTime,
            last_event_ms_ago: lastEventTime === null ? null : now - lastEventTime,
          },
          discord: {
            connected: discli?.isRunning ?? false,
            bot_id: discli?.botId ?? null,
            bot_name: null, // discli exposes via ready event; not tracked yet
          },
          pi_host: {
            connected: piHost.connected,
            pi_idle: piIdle,
            ...(deploy ? { deploy } : {}),
          },
          router: {
            subscriptions: [...state.subscriptions],
            ping_mode: state.ping_mode,
            digest_mode: state.digest_mode,
          },
        };
        return { req_id: req.req_id, ok: true, result: out };
      }

      case "subscribe":
      case "unsubscribe": {
        // Reject `#name` form with a clear error rather than silently
        // storing a literal that won't match incoming routing decisions
        // (which compare against numeric channel_id from discli). Doc
        // + silent failure was the worst combination — agent would
        // "subscribe" then never see ambient channel traffic.
        const id = req.channel_id;
        if (!/^\d+$/.test(id)) {
          return {
            req_id: req.req_id,
            ok: false,
            error:
              `${req.cmd} requires a numeric channel_id, got: ${JSON.stringify(id)}. ` +
              `Use \`pi-discord-ctl channels\` to find the id; #name is not accepted ` +
              `here (cross-guild collisions would silently subscribe the wrong channel).`,
          };
        }
        if (req.cmd === "subscribe") {
          if (!state.subscriptions.includes(id)) {
            state = { ...state, subscriptions: [...state.subscriptions, id] };
            saveState(state);
          }
        } else {
          state = {
            ...state,
            subscriptions: state.subscriptions.filter((c) => c !== id),
          };
          saveState(state);
        }
        return {
          req_id: req.req_id,
          ok: true,
          result: { subscriptions: state.subscriptions },
        };
      }

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

      case "digest":
        return {
          req_id: req.req_id,
          ok: true,
          result: { entries: digest.peek(), mode: state.digest_mode },
        };

      case "digest-ack": {
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
        return { req_id: req.req_id, ok: true, result: { cleared: before } };
      }

      case "send": {
        if (!discli) return discordUnavailable(req.req_id);
        // Pre-check Discord's 2000-char message limit so we return a
        // structured error rather than discli's pass-through 400
        // from the API. The agent reads the error; surfacing the
        // count + the limit + the hint to split saves a head-scratch.
        if (req.content.length > 2000) {
          return {
            req_id: req.req_id,
            ok: false,
            error:
              `content is ${req.content.length} chars; Discord's per-message limit is 2000. ` +
              `Split into multiple \`send\` calls or trim. There's no auto-chunking flag yet.`,
          };
        }
        const result = await discli.sendAction({
          action: "send",
          channel_id: req.channel_id,
          content: req.content,
        });
        // Implicit typing-stop after send.
        stopTyping(req.channel_id).catch(() => {});
        return { req_id: req.req_id, ok: true, result };
      }

      case "history": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "message_list",
          channel_id: req.channel_id,
          ...(req.limit ? { limit: req.limit } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "channels": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "channel_list",
          ...(req.guild_id ? { guild_id: req.guild_id } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "typing-start": {
        if (!discli) return discordUnavailable(req.req_id);
        await discli.sendAction({
          action: "typing_start",
          channel_id: req.channel_id,
        });
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

      case "typing-stop": {
        if (!discli) return discordUnavailable(req.req_id);
        await stopTyping(req.channel_id);
        return { req_id: req.req_id, ok: true };
      }

      case "whois": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: "member_search",
          name: req.name,
          ...(req.guild_id ? { guild_id: req.guild_id } : {}),
        });
        return { req_id: req.req_id, ok: true, result };
      }

      case "react":
      case "unreact": {
        if (!discli) return discordUnavailable(req.req_id);
        const result = await discli.sendAction({
          action: req.cmd === "react" ? "reaction_add" : "reaction_remove",
          channel_id: req.channel_id,
          message_id: req.message_id,
          emoji: req.emoji,
        });
        return { req_id: req.req_id, ok: true, result };
      }

      default: {
        // Pacify TS exhaustiveness — piHostUnavailable kept here as a
        // touchpoint for a future verb that needs pi-host (currently
        // none on pi-discord's surface; all delivers are bridge-internal).
        void piHostUnavailable;
        const c: never = req;
        return {
          req_id: (c as any).req_id ?? "",
          ok: false,
          error: `unknown cmd: ${(c as any).cmd}`,
        };
      }
    }
  };

  // ── Discli ───────────────────────────────────────────────────────
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
            if (decision.reason === "unsubscribed channel, no mention") {
              digest.note(msgEvent);
            } else if (decision.reason.startsWith("ping-mode is none")) {
              try {
                recordMissedPing(MISSED_PINGS_FILE, msgEvent);
              } catch (err: any) {
                log(`[missed-pings-error] ${err?.message ?? err}`);
              }
            }
            log(`[drop] [#${msgEvent.channel}] ${msgEvent.author}: ${decision.reason}`);
            return;
          }
          log(
            `[deliver] mode=${decision.mode} class=${decision.class} ` +
              `from=${msgEvent.author} #${msgEvent.channel}`,
          );
          lastEventTime = Date.now();
          // Enqueue into the appropriate buffer. If pi is idle, the
          // event goes to the prompt buffer; otherwise to the routed
          // mode.
          const bufferKind = piIdle ? "prompt" : decision.mode;
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
    log(`[discli] DISCORD_BOT_TOKEN not set; Discord side disabled`);
  }

  // ── Control server + pi-host client ──────────────────────────────
  const ctl = new ControlServer(SOCKET_PATH, handler);
  await ctl.listen();
  log(`listening at ${SOCKET_PATH}`);

  piHost.start();

  // ── Shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (code=${code})`);
    await piHost.shutdown();
    await ctl.shutdown();
    if (discli) await discli.shutdown();
    process.exit(code);
  }

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

main().catch((err) => {
  process.stderr.write(`[pi-discord fatal] ${err?.stack ?? err}\n`);
  process.exit(1);
});
