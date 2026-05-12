/**
 * disclaw-ctl — CLI client for the disclaw daemon.
 *
 * Each invocation opens a fresh connection, sends one request, prints
 * the response (pretty-printed JSON), and exits. Exit code 0 on
 * { ok: true }, 1 on { ok: false } or any client-side error.
 *
 * For the full command list, run: disclaw-ctl --help
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { SOCKET_PATH } from "./control.js";
import { parseDuration } from "./duration.js";
import type { CtlRequest, CtlResponse } from "./protocol.js";

const HELP_TEXT = `disclaw-ctl — your interface to the disclaw daemon.

Health & state:
  disclaw-ctl ping                          health check
  disclaw-ctl get-state                     show agent + Discord-side state

Sysprompt slot (prepended to your system prompt every agent run):
  disclaw-ctl sysprompt                     show current value
  disclaw-ctl sysprompt set "<text>"        set inline
  disclaw-ctl sysprompt set --stdin         set from stdin (cat file | ...)
  disclaw-ctl sysprompt clear               remove

Discord — subscriptions (which channels you see ambient messages from):
  disclaw-ctl subscribe <channel_id>
  disclaw-ctl unsubscribe <channel_id>
  disclaw-ctl list                          list current subscriptions

Discord — ping mode (how mentions/DMs reach you):
  disclaw-ctl set ping-mode push            interrupt next tool result with brief marker
  disclaw-ctl set ping-mode follow_up       deliver after current run finishes
  disclaw-ctl set ping-mode none            mute pings entirely

Discord — activity digest (sidebar-like unread counts for unsubscribed channels):
  disclaw-ctl set digest-mode follow_up     piggyback digest on next flush / nudge
  disclaw-ctl set digest-mode none          no auto-delivery; query on demand
  disclaw-ctl digest                        show current accumulated digest (peek)
  disclaw-ctl digest ack                    mark all unread channels as read
  disclaw-ctl digest ack <channel_id>       mark just one channel as read

Discord — missed pings (review pings that were dropped while ping-mode = none):
  disclaw-ctl missed-pings                  show all missed pings (most recent last)
  disclaw-ctl missed-pings <N>              show only the last N entries
  disclaw-ctl missed-pings clear            wipe the missed-pings log

Discord — talk:
  disclaw-ctl send <channel_id> <content>           send a message
  disclaw-ctl send --quiet <channel_id> <content>   ditto, but print just
                                                    the jump URL on success
                                                    (lighter for conversational use)
  disclaw-ctl send <channel_id> --stdin             read content from stdin
                                                    (heredoc / pipe — sidesteps
                                                     shell-quoting issues for
                                                     multi-line, backticks, $vars)
  disclaw-ctl history <channel_id> [limit]  read recent messages from a channel
  disclaw-ctl channels                      list channels visible to the bot
  disclaw-ctl typing <channel_id> [dur]     show "is typing…" in a channel
                                            (auto-stops after dur, default 60s;
                                             also implicitly stops on send)
  disclaw-ctl typing stop <channel_id>      explicit stop
  disclaw-ctl whois <name>                  resolve a username/nickname to user_id(s)
                                            so you can construct a <@user_id> mention
  disclaw-ctl whois <name> --guild <id>     scope the search to one guild
  disclaw-ctl react   <channel_id> <message_id> <emoji>
                                            add an emoji reaction (lighter than a reply;
                                             emoji = unicode 👍 or :name: for custom)
  disclaw-ctl unreact <channel_id> <message_id> <emoji>
                                            retract a reaction

Idle nudges + sleep (your relationship with your own attention):
  disclaw-ctl set idle-nudge-timeout <dur>  e.g. 30s, 5m, 1h, off — how long after
                                            you finish a run before a quiet "anything
                                            else?" nudge fires. Default: 60s.
  disclaw-ctl sleep                         go quiet until next real event
  disclaw-ctl sleep <duration>              go quiet for at least <duration>, or until
                                            next real event, whichever comes first
  disclaw-ctl wake                          cancel an active sleep manually

Use \`channels\` to find channel IDs. They're long numbers like 1503391358076059762.

For most <channel_id> args you can use #name (e.g. #general) instead of the
numeric id. Numeric is unambiguous; name form scans all guilds and takes the
first match.

Exception: subscribe / unsubscribe require numeric ids — name resolution at
subscribe-time on a cross-guild collision would silently subscribe the wrong
channel, which is a recurring footgun (every message in the wrong channel
becomes a follow_up forever).
`;

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (err: any) {
    die(`failed to read stdin: ${err?.message ?? err}`);
  }
}

function parseArgs(argv: string[]): CtlRequest {
  const reqId = randomUUID();
  const [cmd, ...rest] = argv;

  // --help, -h, help: print HELP_TEXT and exit 0.
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  switch (cmd) {
    case "ping":
      return { cmd: "ping", req_id: reqId };

    case "get-state":
      return { cmd: "get-state", req_id: reqId };

    case "sysprompt": {
      const sub = rest[0];
      if (!sub || sub === "show") {
        return { cmd: "sysprompt-show", req_id: reqId };
      }
      if (sub === "clear") {
        return { cmd: "sysprompt-clear", req_id: reqId };
      }
      if (sub === "set") {
        const tail = rest.slice(1);
        let value: string;
        if (tail.length === 1 && tail[0] === "--stdin") {
          value = readStdinSync();
        } else if (tail.length > 0) {
          value = tail.join(" ");
        } else {
          die('usage: disclaw-ctl sysprompt set "<text>"  OR  disclaw-ctl sysprompt set --stdin');
        }
        return { cmd: "sysprompt-set", req_id: reqId, value };
      }
      die(`unknown sysprompt subcommand: ${sub}`);
      break;
    }

    case "subscribe": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: disclaw-ctl subscribe <channel_id>");
      return { cmd: "subscribe", req_id: reqId, channel_id };
    }

    case "unsubscribe": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: disclaw-ctl unsubscribe <channel_id>");
      return { cmd: "unsubscribe", req_id: reqId, channel_id };
    }

    case "list-subscriptions":
    case "list":
      return { cmd: "list-subscriptions", req_id: reqId };

    case "set": {
      const key = rest[0];
      const value = rest[1];
      if (!key) die("usage: disclaw-ctl set <key> <value>  (try --help)");
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
      if (key === "idle-nudge-timeout") {
        if (!value) die('usage: disclaw-ctl set idle-nudge-timeout <duration|off>');
        let timeout_ms: number | null;
        try {
          timeout_ms = parseDuration(value);
        } catch (err: any) {
          die(err?.message ?? String(err));
        }
        return { cmd: "set-idle-nudge-timeout", req_id: reqId, timeout_ms };
      }
      die(`unknown setting: ${key}  (try --help)`);
      break;
    }

    case "sleep": {
      // disclaw-ctl sleep [duration]
      if (rest.length === 0) {
        return { cmd: "sleep", req_id: reqId };
      }
      let duration_ms: number | null;
      try {
        duration_ms = parseDuration(rest.join(" "));
      } catch (err: any) {
        die(err?.message ?? String(err));
      }
      if (duration_ms === null) {
        die("`disclaw-ctl sleep off` is not a thing — use `disclaw-ctl wake` to cancel an active sleep");
      }
      return { cmd: "sleep", req_id: reqId, duration_ms };
    }

    case "wake":
      return { cmd: "wake", req_id: reqId };

    case "digest": {
      // disclaw-ctl digest                  → peek
      // disclaw-ctl digest ack              → drain all channels
      // disclaw-ctl digest ack <channel>    → drain just that channel
      if (rest[0] === "ack") {
        const channel_id = rest[1];
        if (channel_id) {
          return { cmd: "digest-ack", req_id: reqId, channel_id };
        }
        return { cmd: "digest-ack", req_id: reqId };
      }
      return { cmd: "digest", req_id: reqId };
    }

    case "missed-pings": {
      // disclaw-ctl missed-pings           → all
      // disclaw-ctl missed-pings <N>       → last N
      // disclaw-ctl missed-pings clear     → wipe
      if (rest[0] === "clear") {
        return { cmd: "missed-pings-clear", req_id: reqId };
      }
      if (rest.length === 0) {
        return { cmd: "missed-pings", req_id: reqId };
      }
      const limit = parseInt(rest[0]!, 10);
      if (Number.isNaN(limit) || limit < 1) {
        die("usage: disclaw-ctl missed-pings [<N> | clear]");
      }
      return { cmd: "missed-pings", req_id: reqId, limit };
    }

    case "send": {
      // Flags (any position, before or after the channel_id):
      //   --quiet  → on success, print just the jump URL (no JSON)
      //   --stdin  → read content from stdin instead of trailing args
      //              (avoids shell quoting hell for multi-line, $vars,
      //               backticks, embedded quotes)
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
          "usage: disclaw-ctl send [--quiet] <channel_id> <content...>\n" +
            "       disclaw-ctl send [--quiet] <channel_id> --stdin    (heredoc / pipe)",
        );
      }
      return {
        _quiet: quietIdx !== -1,
        cmd: "discord-send",
        req_id: reqId,
        channel_id,
        content,
      } as any;
    }

    case "history": {
      const channel_id = rest[0];
      if (!channel_id) die("usage: disclaw-ctl history <channel_id> [limit]");
      const limit = rest[1] ? parseInt(rest[1], 10) : undefined;
      if (limit !== undefined && Number.isNaN(limit)) {
        die("history limit must be an integer");
      }
      return { cmd: "discord-history", req_id: reqId, channel_id, limit };
    }

    case "channels": {
      const guild_id = rest[0];
      return { cmd: "discord-channels", req_id: reqId, guild_id };
    }

    case "react":
    case "unreact": {
      // disclaw-ctl react   <channel_id> <message_id> <emoji>
      // disclaw-ctl unreact <channel_id> <message_id> <emoji>
      // emoji: unicode (👍) or custom-guild-emoji shortcode (:thumbsup:)
      const channel_id = rest[0];
      const message_id = rest[1];
      const emoji = rest[2];
      if (!channel_id || !message_id || !emoji) {
        die(`usage: disclaw-ctl ${cmd} <channel_id> <message_id> <emoji>`);
      }
      return {
        cmd: cmd === "react" ? "discord-react" : "discord-unreact",
        req_id: reqId,
        channel_id,
        message_id,
        emoji,
      };
    }

    case "whois": {
      // disclaw-ctl whois <name> [--guild <guild_id>]
      const args = rest.slice();
      let guild_id: string | undefined;
      const gIdx = args.indexOf("--guild");
      if (gIdx !== -1) {
        if (gIdx + 1 >= args.length) die("--guild requires a value");
        guild_id = args[gIdx + 1];
        args.splice(gIdx, 2);
      }
      const name = args[0];
      if (!name) die("usage: disclaw-ctl whois <name> [--guild <guild_id>]");
      return { cmd: "discord-whois", req_id: reqId, name, ...(guild_id ? { guild_id } : {}) };
    }

    case "typing": {
      // disclaw-ctl typing <channel_id>             → start, default auto-stop
      // disclaw-ctl typing <channel_id> <duration>  → start, auto-stop after duration
      // disclaw-ctl typing stop <channel_id>        → explicit stop
      if (rest[0] === "stop") {
        const channel_id = rest[1];
        if (!channel_id) die("usage: disclaw-ctl typing stop <channel_id>");
        return { cmd: "discord-typing-stop", req_id: reqId, channel_id };
      }
      const channel_id = rest[0];
      if (!channel_id) {
        die("usage: disclaw-ctl typing <channel_id> [duration]  OR  disclaw-ctl typing stop <channel_id>");
      }
      const durArg = rest[1];
      let duration_ms: number | undefined;
      if (durArg !== undefined) {
        try {
          const parsed = parseDuration(durArg);
          if (parsed === null) die("typing duration cannot be 'off' — use `disclaw-ctl typing stop <channel_id>` instead");
          duration_ms = parsed;
        } catch (err: any) {
          die(err?.message ?? String(err));
        }
      }
      return { cmd: "discord-typing-start", req_id: reqId, channel_id, ...(duration_ms !== undefined ? { duration_ms } : {}) };
    }

    case "prompt":
      die(
        "`prompt` is not a disclaw-ctl command. To send a message to a Discord channel, " +
          "use `disclaw-ctl send <channel_id> <content>`.",
      );

    default:
      die(`unknown command: ${cmd}  (try --help for the command list)`);
  }
}

function die(msg: string): never {
  process.stderr.write(`disclaw-ctl: ${msg}\n`);
  process.exit(1);
}

async function send(req: CtlRequest): Promise<CtlResponse> {
  return await new Promise<CtlResponse>((resolve, reject) => {
    const sock: Socket = connect(SOCKET_PATH);
    let resolved = false;
    sock.on("error", (err) => {
      if (!resolved) reject(err);
    });
    attachJsonlLineReader(sock, (line) => {
      if (resolved) return;
      try {
        const resp = JSON.parse(line) as CtlResponse;
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
  const argv = process.argv.slice(2);
  const req = parseArgs(argv);

  let resp: CtlResponse;
  try {
    resp = await send(req);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      die(`socket not found at ${SOCKET_PATH} — is the daemon running?`);
    }
    if (err?.code === "ECONNREFUSED") {
      die(`connection refused at ${SOCKET_PATH} — daemon not accepting connections`);
    }
    die(err?.message ?? String(err));
  }

  // --quiet path for send: just print the jump URL on success.
  // Strip the internal _quiet marker before serializing if we ever
  // emitted the full response.
  const quiet = (req as any)._quiet === true;
  delete (req as any)._quiet;

  if (quiet && req.cmd === "discord-send" && resp.ok) {
    const jumpUrl = (resp as any)?.result?.result?.jump_url;
    const messageId = (resp as any)?.result?.result?.message_id;
    if (jumpUrl) {
      process.stdout.write(jumpUrl + "\n");
    } else if (messageId) {
      process.stdout.write(messageId + "\n");
    }
    // else: silent on success with no useful identifier
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(resp, null, 2) + "\n");
  process.exit(resp.ok ? 0 : 1);
}

main();
