/**
 * pi-host's persistent state — sysprompt slot, per-(provider,model)
 * session registry, idle-nudge timeout, deploy-config (for cold-restart
 * recovery without a running daemon to inherit env from), and the
 * initialized flag.
 *
 * Lives at $PI_HOST_RUNTIME_DIR/state.json (default
 * ~/.local/state/pi-host/). Sysprompt is also mirror-written to
 * $PI_HOST_SYSPROMPT_FILE (default ~/.local/state/pi-host/sysprompt.txt)
 * so the pi sysprompt-extension can read it directly without going
 * through the socket.
 *
 * Atomic writes: write to ${path}.tmp, fsync, rename. Renames within
 * a filesystem are atomic per POSIX, so a reader sees either the
 * previous version or the new one — never a partial.
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

const DEFAULT_RUNTIME_DIR = join(homedir(), ".local", "state", "pi-host");

export const RUNTIME_DIR =
  process.env.PI_HOST_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;
export const STATE_FILE = join(RUNTIME_DIR, "state.json");
export const SYSPROMPT_FILE =
  process.env.PI_HOST_SYSPROMPT_FILE ?? join(RUNTIME_DIR, "sysprompt.txt");
export const SOCKET_PATH = join(RUNTIME_DIR, "pi-host.sock");

export interface HostState {
  initialized: boolean;
  sysprompt: string;
  /**
   * Provider/model the daemon was last started with. Persisted on
   * startup so a cold restart (no running daemon to inherit env from,
   * e.g. after a host reboot) can recover the deploy-config from disk.
   * Optional — older state files may lack these.
   */
  provider?: string;
  model?: string;
  model_name?: string;
  /**
   * How long after an agent_run ends before the daemon sends a quiet
   * idle nudge. null = nudges off entirely. Default: 60_000 (60s).
   */
  idle_nudge_timeout_ms: number | null;
  /**
   * Pi session files keyed by `<provider>:<model>` (see {@link sessionKey}).
   * On daemon startup the entry matching the current provider/model is
   * passed as `--session <path>` to pi so the transcript continues
   * across restarts. Switching models parks the prior model's session
   * under its key rather than overwriting it.
   */
  sessions: Record<string, string>;
}

const DEFAULT_STATE: HostState = {
  initialized: false,
  sysprompt: "",
  idle_nudge_timeout_ms: 60_000,
  sessions: {},
};

export function sessionKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

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

export function loadState(): HostState {
  ensureDir(RUNTIME_DIR);
  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HostState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    throw new Error(
      `Failed to parse ${STATE_FILE}: ${
        err instanceof Error ? err.message : String(err)
      }. Move the file aside or delete it to start fresh.`,
    );
  }
}

export function saveState(state: HostState): void {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  atomicWrite(SYSPROMPT_FILE, state.sysprompt);
}
