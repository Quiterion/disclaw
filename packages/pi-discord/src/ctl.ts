/**
 * pdc — CLI client for the pi-discord daemon.
 *
 * Each invocation opens a fresh socket connection, sends one request,
 * prints the response, and exits. Exit 0 on ok=true, 1 otherwise.
 *
 * Pi-discord-ctl handles Discord verbs only — subscriptions, ping/
 * digest modes, send/history/channels/whois, typing, reactions,
 * missed-pings inspection. Agent self-administration (sysprompt,
 * sleep, idle nudges, deploy state) lives in pi-ctl, talking to
 * pi-host's separate socket.
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attachJsonlLineReader, serializeJsonLine, parseDuration } from "pi-shared";
import { SOCKET_PATH } from "./state.js";
import type { DiscordCtlRequest, DiscordCtlResponse } from "./protocol.js";

/**
 * Resolve the socket to connect to. See pi-host/src/ctl.ts for the
 * full rationale; same layered fallback as pi-ctl, looking at
 * `$PWD/.pi-discord/pi-discord.sock` as the cwd-local override.
 */
function resolveSocketPath(): string {
  if (process.env.PI_DISCORD_RUNTIME_DIR) return SOCKET_PATH;
  if (existsSync(SOCKET_PATH)) return SOCKET_PATH;
  const cwdSocket = join(process.cwd(), ".pi-discord", "pi-discord.sock");
  if (existsSync(cwdSocket)) return cwdSocket;
  return SOCKET_PATH;
}

const HELP_TEXT = `pdc — your interface to the pi-discord daemon.

Health & state:
  pdc ping                           health check
  pdc status                         slim view: subscriptions,
                                                ping-mode, digest-mode,
                                                digest count, missed-pings
                                                count, pi-host connection.
                                                What you usually want on
                                                cold-start.
  pdc get-state                      full snapshot (daemon meta +
                                                pi-host link state too)

Discord — finding channels:
  pdc channels                       list channels visible to the bot

Discord — subscriptions (which channels you see ambient messages from):
  pdc subscribe <channel_id>         see ambient messages from this channel
  pdc unsubscribe <channel_id>       stop seeing them
  pdc list                           list current subscriptions

Discord — ping mode (how mentions/DMs reach you):
  pdc set ping-mode push             interrupt next tool result with brief marker
  pdc set ping-mode follow_up        deliver after current run finishes
  pdc set ping-mode none             mute pings entirely

Discord — activity digest (sidebar-like unread counts for unsubscribed channels):
  pdc set digest-mode follow_up      piggyback digest on next flush
  pdc set digest-mode none           no auto-delivery; query on demand
  pdc digest                         show currently-accumulated digest (peek)
  pdc digest ack                     mark all unread channels as read
  pdc digest ack <channel_id>        mark just one channel as read

Discord — missed pings (review pings dropped while ping-mode = none):
  pdc missed-pings                   show all missed pings (most recent last)
  pdc missed-pings <N>               show only the last N entries
  pdc missed-pings clear             wipe the missed-pings log

Discord — reading + writing:
  pdc history <channel_id> [limit]   read recent messages from a channel
  pdc send <channel_id> <content>           send a message
  pdc send --quiet <channel_id> <content>   ditto, print just the jump URL
  pdc send <channel_id> --stdin             read content from stdin
                                                       (heredoc / pipe — sidesteps
                                                        shell-quoting issues for
                                                        multi-line, backticks, $vars)
  pdc typing <channel_id> [dur]      show "is typing…" in a channel
                                                (auto-stops after dur, default 60s;
                                                 implicitly stops on send)
  pdc typing stop <channel_id>       explicit stop
  pdc whois <name>                   resolve a username/nickname to user_id(s)
                                                so you can construct a <@user_id> mention
  pdc whois <name> --guild <id>      scope the search to one guild
  pdc react   <channel_id> <message_id> <emoji>
                                                add an emoji reaction (lighter than a reply;
                                                 emoji = unicode 👍 or :name: for custom)
  pdc unreact <channel_id> <message_id> <emoji>
                                                retract a reaction

For agent self-admin (sysprompt, sleep, idle-nudge timeout), use \`pi-ctl\`.

For most <channel_id> args you can use #name (e.g. #general); subscribe /
unsubscribe require numeric ids (a cross-guild #name collision would
silently subscribe the wrong channel — a recurring footgun).
`;

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (err: any) {
    die(`failed to read stdin: ${err?.message ?? err}`);
  }
}

function parseArgs(argv: string[]): DiscordCtlRequest & { _quiet?: boolean } {
  const reqId = randomUUID();
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  switch (cmd) {
    case "ping":
      return { cmd: "ping", req_id: reqId };

    case "get-state":
      return { cmd: "get-state", req_id: reqId };

    case "status":
      return { cmd: "status", req_id: reqId };

    case "subscribe": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: pdc subscribe <channel_id>");
      return { cmd: "subscribe", req_id: reqId, channel_id };
    }

    case "unsubscribe": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: pdc unsubscribe <channel_id>");
      return { cmd: "unsubscribe", req_id: reqId, channel_id };
    }

    case "list-subscriptions":
    case "list":
      return { cmd: "list-subscriptions", req_id: reqId };

    case "set": {
      const key = rest[0];
      const value = rest[1];
      if (!key) die("usage: pdc set <key> <value>  (try --help)");
      if (key === "ping-mode") {
        if (value !== "push" && value !== "follow_up" && value !== "none") {
          die("ping-mode must be one of: push, follow_up, none");
        }
        return { cmd: "set-ping-mode", req_id: reqId, mode: value };
      }
      if (key === "digest-mode") {
        if (value !== "follow_up" && value !== "none") {
          die("digest-mode must be one of: follow_up, none");
        }
        return { cmd: "set-digest-mode", req_id: reqId, mode: value };
      }
      die(`unknown setting: ${key}  (try --help)`);
      break;
    }

    case "digest": {
      if (rest[0] === "ack") {
        const channel_id = rest[1];
        if (channel_id) return { cmd: "digest-ack", req_id: reqId, channel_id };
        return { cmd: "digest-ack", req_id: reqId };
      }
      return { cmd: "digest", req_id: reqId };
    }

    case "missed-pings": {
      if (rest[0] === "clear") return { cmd: "missed-pings-clear", req_id: reqId };
      if (rest.length === 0) return { cmd: "missed-pings", req_id: reqId };
      const limit = parseInt(rest[0]!, 10);
      if (Number.isNaN(limit) || limit < 1) {
        die("usage: pdc missed-pings [<N> | clear]");
      }
      return { cmd: "missed-pings", req_id: reqId, limit };
    }

    case "send": {
      const args = rest.slice();
      const quietIdx = args.indexOf("--quiet");
      if (quietIdx !== -1) args.splice(quietIdx, 1);
      const stdinIdx = args.indexOf("--stdin");
      const useStdin = stdinIdx !== -1;
      if (useStdin) args.splice(stdinIdx, 1);

      const channel_id = args[0];
      const content = useStdin ? readStdinSync() : args.slice(1).join(" ");

      if (!channel_id || !content) {
        die(
          "usage: pdc send [--quiet] <channel_id> <content...>\n" +
            "       pdc send [--quiet] <channel_id> --stdin    (heredoc / pipe)",
        );
      }
      return {
        cmd: "send",
        req_id: reqId,
        channel_id,
        content,
        _quiet: quietIdx !== -1,
      };
    }

    case "history": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: pdc history <channel_id> [limit]");
      const limit = rest[1] ? parseInt(rest[1], 10) : undefined;
      if (limit !== undefined && Number.isNaN(limit)) {
        die("history limit must be an integer");
      }
      return { cmd: "history", req_id: reqId, channel_id, limit };
    }

    case "channels": {
      const guild_id = rest[0];
      return { cmd: "channels", req_id: reqId, guild_id };
    }

    case "react":
    case "unreact": {
      const channel_id = rest[0];
      const message_id = rest[1];
      const emoji = rest[2];
      if (!channel_id || !message_id || !emoji) {
        die(`usage: pdc ${cmd} <channel_id> <message_id> <emoji>`);
      }
      return { cmd, req_id: reqId, channel_id, message_id, emoji };
    }

    case "whois": {
      const args = rest.slice();
      let guild_id: string | undefined;
      const gIdx = args.indexOf("--guild");
      if (gIdx !== -1) {
        if (gIdx + 1 >= args.length) die("--guild requires a value");
        guild_id = args[gIdx + 1];
        args.splice(gIdx, 2);
      }
      const name = args[0];
      if (!name) die("usage: pdc whois <name> [--guild <guild_id>]");
      return { cmd: "whois", req_id: reqId, name, ...(guild_id ? { guild_id } : {}) };
    }

    case "typing": {
      if (rest[0] === "stop") {
        const channel_id = rest[1];
        if (!channel_id) die("usage: pdc typing stop <channel_id>");
        return { cmd: "typing-stop", req_id: reqId, channel_id };
      }
      const channel_id = rest[0];
      if (!channel_id) {
        die(
          "usage: pdc typing <channel_id> [duration]  OR  pdc typing stop <channel_id>",
        );
      }
      const durArg = rest[1];
      let duration_ms: number | undefined;
      if (durArg !== undefined) {
        try {
          const parsed = parseDuration(durArg);
          if (parsed === null) {
            die("typing duration cannot be 'off' — use `pdc typing stop <channel_id>` instead");
          }
          duration_ms = parsed;
        } catch (err: any) {
          die(err?.message ?? String(err));
        }
      }
      return {
        cmd: "typing-start",
        req_id: reqId,
        channel_id,
        ...(duration_ms !== undefined ? { duration_ms } : {}),
      };
    }

    default:
      die(`unknown command: ${cmd}  (try --help for the command list)`);
  }
}

function die(msg: string): never {
  process.stderr.write(`pdc: ${msg}\n`);
  process.exit(1);
}

async function sendReq(req: DiscordCtlRequest, socketPath: string): Promise<DiscordCtlResponse> {
  return await new Promise<DiscordCtlResponse>((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let resolved = false;
    sock.on("error", (err) => {
      if (!resolved) reject(err);
    });
    attachJsonlLineReader(sock, (line) => {
      if (resolved) return;
      try {
        const resp = JSON.parse(line) as DiscordCtlResponse;
        resolved = true;
        sock.end();
        resolve(resp);
      } catch (err) {
        resolved = true;
        sock.end();
        reject(err);
      }
    });
    sock.on("connect", () => {
      sock.write(serializeJsonLine(req));
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const quiet = (parsed as any)._quiet === true;
  delete (parsed as any)._quiet;
  const req = parsed as DiscordCtlRequest;

  const socketPath = resolveSocketPath();
  let resp: DiscordCtlResponse;
  try {
    resp = await sendReq(req, socketPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      const cwdHint =
        socketPath === SOCKET_PATH && !process.env.PI_DISCORD_RUNTIME_DIR
          ? ` (also looked for $PWD/.pi-discord/pi-discord.sock; set PI_DISCORD_RUNTIME_DIR to point elsewhere)`
          : "";
      die(`socket not found at ${socketPath}${cwdHint} — is pi-discord running?`);
    }
    if (err?.code === "ECONNREFUSED") {
      die(`connection refused at ${socketPath} — pi-discord not accepting connections`);
    }
    die(err?.message ?? String(err));
  }

  // --quiet path for send: just print the jump URL on success.
  if (quiet && req.cmd === "send" && resp.ok) {
    const jumpUrl = (resp as any)?.result?.jump_url;
    const messageId = (resp as any)?.result?.message_id;
    if (jumpUrl) process.stdout.write(jumpUrl + "\n");
    else if (messageId) process.stdout.write(messageId + "\n");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(resp, null, 2) + "\n");
  process.exit(resp.ok ? 0 : 1);
}

main();
