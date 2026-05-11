/**
 * disclaw-ctl — CLI client for the disclaw daemon.
 *
 * Each invocation opens a fresh connection, sends one request, prints
 * the response (pretty-printed JSON), and exits. Exit code 0 on
 * { ok: true }, 1 on { ok: false } or any client-side error.
 *
 * Slice 2 commands:
 *   disclaw-ctl ping
 *   disclaw-ctl get-state
 *   disclaw-ctl prompt "<message>"
 *   disclaw-ctl sysprompt              (alias: sysprompt show)
 *   disclaw-ctl sysprompt set "<text>"
 *   disclaw-ctl sysprompt set --stdin
 *   disclaw-ctl sysprompt clear
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { SOCKET_PATH } from "./control.js";
import type { CtlRequest, CtlResponse } from "./protocol.js";

function readStdinSync(): string {
  // process.stdin.fd === 0 — readFileSync handles it across platforms.
  try {
    return readFileSync(0, "utf-8");
  } catch (err: any) {
    die(`failed to read stdin: ${err?.message ?? err}`);
  }
}

function parseArgs(argv: string[]): CtlRequest {
  const reqId = randomUUID();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "ping":
      return { cmd: "ping", req_id: reqId };

    case "get-state":
      return { cmd: "get-state", req_id: reqId };

    case "prompt": {
      const message = rest.join(" ").trim();
      if (!message) die('usage: disclaw-ctl prompt "<message>"');
      return { cmd: "prompt", req_id: reqId, message };
    }

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
      // disclaw-ctl set <key> <value>
      // Currently supported keys: ping-mode
      const key = rest[0];
      const value = rest[1];
      if (!key) die("usage: disclaw-ctl set <key> <value>");
      if (key === "ping-mode") {
        if (value !== "push" && value !== "follow_up" && value !== "none") {
          die("ping-mode must be one of: push, follow_up, none");
        }
        return { cmd: "set-ping-mode", req_id: reqId, mode: value };
      }
      die(`unknown setting: ${key}`);
      break;
    }

    default:
      die(
        cmd
          ? `unknown command: ${cmd}`
          : "usage: disclaw-ctl {ping|get-state|prompt <msg>|sysprompt [show|set|clear]" +
              "|subscribe <ch>|unsubscribe <ch>|list|set ping-mode <mode>}",
      );
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
