/**
 * disclaw-ctl — CLI client for the disclaw daemon.
 *
 * Slice 1 commands:
 *   disclaw-ctl ping
 *   disclaw-ctl get-state
 *   disclaw-ctl prompt "<message>"
 *
 * Each invocation opens a fresh connection, sends one request, prints
 * the response (pretty-printed JSON), and exits. Exit code 0 on
 * { ok: true }, 1 on { ok: false } or any client-side error.
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { SOCKET_PATH } from "./control.js";
import type { CtlRequest, CtlResponse } from "./protocol.js";

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
      if (!message) {
        die("usage: disclaw-ctl prompt \"<message>\"");
      }
      return { cmd: "prompt", req_id: reqId, message };
    }
    default:
      die(
        cmd
          ? `unknown command: ${cmd}`
          : "usage: disclaw-ctl {ping|get-state|prompt <message>}",
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
