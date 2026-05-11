/**
 * Unix socket control plane.
 *
 * Listens at SOCKET_PATH, accepts JSONL connections, dispatches each
 * request to the supplied handler. Multiple concurrent clients OK
 * (each is a fresh JSONL session). Cleans up the socket file on
 * shutdown.
 */
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { CtlRequest, CtlResponse } from "./protocol.js";

export const RUNTIME_DIR = join(homedir(), ".disclaw");
export const SOCKET_PATH = join(RUNTIME_DIR, "disclaw.sock");

export type RequestHandler = (
  req: CtlRequest,
) => Promise<CtlResponse> | CtlResponse;

export class ControlServer {
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(private handler: RequestHandler) {
    this.server = createServer((sock) => this.onConnection(sock));
  }

  async listen(): Promise<void> {
    await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    if (existsSync(SOCKET_PATH)) {
      // Stale socket from a crashed previous run
      await unlink(SOCKET_PATH);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(SOCKET_PATH, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (existsSync(SOCKET_PATH)) {
      try {
        await unlink(SOCKET_PATH);
      } catch {
        // Best effort
      }
    }
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => this.sockets.delete(sock));

    attachJsonlLineReader(sock, async (line) => {
      let req: CtlRequest;
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
