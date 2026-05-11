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

Discord — talk:
  disclaw-ctl send <channel_id> <content>   send a message to a channel
  disclaw-ctl history <channel_id> [limit]  read recent messages from a channel
  disclaw-ctl channels                      list channels visible to the bot

Idle nudges + sleep (your relationship with your own attention):
  disclaw-ctl set idle-nudge-timeout <dur>  e.g. 30s, 5m, 1h, off — how long after
                                            you finish a run before a quiet "anything
                                            else?" nudge fires. Default: 60s.
  disclaw-ctl sleep                         go quiet until next real event
  disclaw-ctl sleep <duration>              go quiet for at least <duration>, or until
                                            next real event, whichever comes first
  disclaw-ctl wake                          cancel an active sleep manually

Use \`channels\` to find channel IDs. They're long numbers like 1503391358076059762.
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

    case "send": {
      const channel_id = rest[0];
      const content = rest.slice(1).join(" ");
      if (!channel_id || !content) {
        die("usage: disclaw-ctl send <channel_id> <content...>");
      }
      return { cmd: "discord-send", req_id: reqId, channel_id, content };
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

  process.stdout.write(JSON.stringify(resp, null, 2) + "\n");
  process.exit(resp.ok ? 0 : 1);
}

main();
