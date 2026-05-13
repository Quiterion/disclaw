/**
 * pi-ctl — CLI client for the pi-host daemon.
 *
 * Each invocation opens a fresh socket connection, sends one request,
 * prints the response, and exits. Exit 0 on ok=true, 1 on ok=false or
 * any client-side error.
 *
 * pi-ctl handles the agent's self-administration verbs only —
 * sysprompt slot, sleep/wake, idle-nudge timeout, deploy state.
 * Discord-side verbs live in pi-discord-ctl (separate binary, separate
 * socket).
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { attachJsonlLineReader, serializeJsonLine, parseDuration } from "pi-shared";
import { SOCKET_PATH } from "./state.js";
import type { HostRequest, HostResponse } from "./protocol.js";

const HELP_TEXT = `pi-ctl — your interface to the pi-host daemon.

Health & state:
  pi-ctl ping                            health check
  pi-ctl get-state                       show pi-host + pi state

Sysprompt slot (prepended to your system prompt on every agent run):
  pi-ctl sysprompt                       show current value
  pi-ctl sysprompt set "<text>"          set inline
  pi-ctl sysprompt set --stdin           set from stdin (cat file | ...)
  pi-ctl sysprompt clear                 remove

Idle nudges + sleep (your relationship with your own attention):
  pi-ctl set idle-nudge-timeout <dur>    e.g. 30s, 5m, 1h, off — how long after
                                         a run ends before a quiet nudge fires.
                                         Default: 60s.
  pi-ctl sleep                           go quiet until next real event
  pi-ctl sleep <duration>                go quiet for ≥ duration, or until
                                         next real event, whichever comes first
  pi-ctl wake                            cancel an active sleep manually

For Discord verbs (subscribe, send, history, channels, etc.), use the
separate \`pi-discord-ctl\` binary, which talks to the pi-discord daemon
on its own socket.
`;

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (err: any) {
    die(`failed to read stdin: ${err?.message ?? err}`);
  }
}

function parseArgs(argv: string[]): HostRequest {
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

    case "sysprompt": {
      const sub = rest[0];
      if (!sub || sub === "show") return { cmd: "sysprompt-get", req_id: reqId };
      if (sub === "clear") return { cmd: "sysprompt-clear", req_id: reqId };
      if (sub === "set") {
        const tail = rest.slice(1);
        let value: string;
        if (tail.length === 1 && tail[0] === "--stdin") {
          value = readStdinSync();
        } else if (tail.length > 0) {
          value = tail.join(" ");
        } else {
          die('usage: pi-ctl sysprompt set "<text>"  OR  pi-ctl sysprompt set --stdin');
        }
        return { cmd: "sysprompt-set", req_id: reqId, value };
      }
      die(`unknown sysprompt subcommand: ${sub}`);
      break;
    }

    case "set": {
      const key = rest[0];
      const value = rest[1];
      if (!key) die("usage: pi-ctl set <key> <value>  (try --help)");
      if (key === "idle-nudge-timeout") {
        if (!value) die("usage: pi-ctl set idle-nudge-timeout <duration|off>");
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
      if (rest.length === 0) return { cmd: "sleep", req_id: reqId };
      let duration_ms: number | null;
      try {
        duration_ms = parseDuration(rest.join(" "));
      } catch (err: any) {
        die(err?.message ?? String(err));
      }
      if (duration_ms === null) {
        die("`pi-ctl sleep off` is not a thing — use `pi-ctl wake` to cancel an active sleep");
      }
      return { cmd: "sleep", req_id: reqId, duration_ms };
    }

    case "wake":
      return { cmd: "wake", req_id: reqId };

    default:
      die(`unknown command: ${cmd}  (try --help for the command list)`);
  }
}

function die(msg: string): never {
  process.stderr.write(`pi-ctl: ${msg}\n`);
  process.exit(1);
}

async function send(req: HostRequest): Promise<HostResponse> {
  return await new Promise<HostResponse>((resolve, reject) => {
    const sock: Socket = connect(SOCKET_PATH);
    let resolved = false;
    sock.on("error", (err) => {
      if (!resolved) reject(err);
    });
    attachJsonlLineReader(sock, (line) => {
      if (resolved) return;
      try {
        const resp = JSON.parse(line) as HostResponse;
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
  const req = parseArgs(process.argv.slice(2));
  let resp: HostResponse;
  try {
    resp = await send(req);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      die(`socket not found at ${SOCKET_PATH} — is pi-host running?`);
    }
    if (err?.code === "ECONNREFUSED") {
      die(`connection refused at ${SOCKET_PATH} — pi-host not accepting connections`);
    }
    die(err?.message ?? String(err));
  }
  process.stdout.write(JSON.stringify(resp, null, 2) + "\n");
  process.exit(resp.ok ? 0 : 1);
}

main();
