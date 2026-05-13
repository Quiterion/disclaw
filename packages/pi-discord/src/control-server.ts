/**
 * pi-discord control server — Unix socket, JSONL framing, strict
 * request/response. No event stream surface (pi-discord doesn't push
 * events; it consumes pi-host's stream as a subscriber on the other
 * side).
 */
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "pi-shared/jsonl";
import type { DiscordCtlRequest, DiscordCtlResponse } from "./protocol.js";

export type RequestHandler = (
  req: DiscordCtlRequest,
) => Promise<DiscordCtlResponse> | DiscordCtlResponse;

export class ControlServer {
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(
    private readonly socketPath: string,
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
    // Intentionally NOT unlinking — see pi-host's control-server.ts for the rationale.
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => this.sockets.delete(sock));

    attachJsonlLineReader(sock, async (line) => {
      let req: DiscordCtlRequest;
      try {
        req = JSON.parse(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sock.write(serializeJsonLine({ req_id: "", ok: false, error: `parse: ${msg}` }));
        return;
      }
      const reqId = (req as any).req_id ?? "";
      try {
        const resp = await this.handler(req);
        sock.write(serializeJsonLine(resp));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sock.write(serializeJsonLine({ req_id: reqId, ok: false, error: msg }));
      }
    });
  }
}
