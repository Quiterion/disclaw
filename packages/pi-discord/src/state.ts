/**
 * pi-discord's persistent state — subscriptions, ping mode, digest
 * mode. Discord-shaped routing rules; nothing here applies to pi-host.
 *
 * Lives at $PI_DISCORD_RUNTIME_DIR/state.json (default
 * ~/.local/state/pi-discord/). Missed-pings log lives in the same
 * directory.
 *
 * Atomic writes via tmp+rename, same pattern as pi-host's state.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DigestMode, PingMode } from "./protocol.js";

const DEFAULT_RUNTIME_DIR = join(homedir(), ".local", "state", "pi-discord");

export const RUNTIME_DIR =
  process.env.PI_DISCORD_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;
export const STATE_FILE = join(RUNTIME_DIR, "state.json");
export const SOCKET_PATH = join(RUNTIME_DIR, "pi-discord.sock");
export const MISSED_PINGS_FILE = join(RUNTIME_DIR, "missed-pings.log");

/**
 * Default location of pi-host's socket. Override via
 * PI_HOST_SOCKET (explicit path) or PI_HOST_RUNTIME_DIR (containing dir).
 */
export const PI_HOST_SOCKET =
  process.env.PI_HOST_SOCKET ??
  join(
    process.env.PI_HOST_RUNTIME_DIR ?? join(homedir(), ".local", "state", "pi-host"),
    "pi-host.sock",
  );

export interface RouterState {
  subscriptions: string[];
  /** How pings (mentions/DMs) are delivered. Opt-in: defaults to "none". */
  ping_mode: PingMode;
  /** How the activity digest is delivered. Opt-in: defaults to "none". */
  digest_mode: DigestMode;
}

const DEFAULT_STATE: RouterState = {
  subscriptions: [],
  ping_mode: "none",
  digest_mode: "none",
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function loadState(): RouterState {
  ensureDir(RUNTIME_DIR);
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RouterState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    throw new Error(
      `Failed to parse ${STATE_FILE}: ${
        err instanceof Error ? err.message : String(err)
      }. Move the file aside or delete it to start fresh.`,
    );
  }
}

export function saveState(state: RouterState): void {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}
