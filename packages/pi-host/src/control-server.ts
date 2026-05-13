/**
 * pi-host control server — Unix socket, JSONL framing, supports both
 * short-lived request/response calls and long-lived subscribers.
 *
 * Connection lifecycle:
 *   1. Client connects.
 *   2. Hub registers it (assigns a subscriber id, kept whether or not
 *      it later actually subscribes).
 *   3. Client sends one or more requests; server replies with one
 *      response per request, correlated by req_id.
 *   4. If the client sent `subscribe`, the server begins pushing
 *      events on the same socket. The client can still submit further
 *      requests; their responses interleave with events on stdout.
 *   5. Either side may close.
 *
 * Socket-file lifecycle: cleaned at startup (existsSync check before
 * listen), never at shutdown. Shutdown-time unlink is unsafe: if two
 * daemons race on the same path (operator bungles a restart), the first
 * to die unlinks the socket out from under the second — alive but
 * unreachable. The startup-only cleanup pattern leaves a dead socket
 * file after a clean shutdown, which is harmless (next daemon unlinks
 * it before binding).
 */
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "pi-shared/jsonl";
import type { HostRequest, HostResponse } from "./protocol.js";
import type { EventHub } from "./event-hub.js";

export type RequestHandler = (
  req: HostRequest,
  subscriberId: string,
) => Promise<HostResponse> | HostResponse;

export class ControlServer {
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly hub: EventHub,
    private readonly handler: RequestHandler,
  ) {
    this.server = createServer((sock) => this.onConnection(sock));
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) await unlink(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Intentionally NOT unlinking the socket — see file-level comment.
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => this.sockets.delete(sock));

    const subscriberId = this.hub.register(sock);

    attachJsonlLineReader(sock, async (line) => {
      let req: HostRequest;
      try {
        req = JSON.parse(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sock.write(serializeJsonLine({ req_id: "", ok: false, error: `parse: ${msg}` }));
        return;
      }
      const reqId = (req as any).req_id ?? "";
      try {
        const resp = await this.handler(req, subscriberId);
        sock.write(serializeJsonLine(resp));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sock.write(serializeJsonLine({ req_id: reqId, ok: false, error: msg }));
      }
    });
  }
}
