/**
 * Persistent router state.
 *
 * Slice 2 schema is small: { initialized, sysprompt }. Future slices
 * will add subscriptions, mode configs, etc.
 *
 * State lives in ~/.disclaw/state.json. Sysprompt is also mirror-written
 * to ~/.disclaw/sysprompt.txt (atomic) so the pi extension can read it
 * directly without going through the socket.
 *
 * Atomic writes: write to ${path}.tmp, fsync, rename. Renames within a
 * filesystem are atomic per POSIX, so a reader either sees the previous
 * version or the new one — never a partial.
 */
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const RUNTIME_DIR = process.env.DISCLAW_RUNTIME_DIR ?? join(homedir(), ".disclaw");
export const STATE_FILE = join(RUNTIME_DIR, "state.json");
export const SYSPROMPT_FILE = process.env.DISCLAW_SYSPROMPT_FILE ?? join(RUNTIME_DIR, "sysprompt.txt");
export const MISSED_PINGS_FILE = join(RUNTIME_DIR, "missed-pings.log");

import type { DigestMode, PingMode } from "./protocol.js";

export interface RouterState {
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
  /** Set of Discord channel IDs the agent has subscribed to. */
  subscriptions: string[];
  /** How pings (mentions/DMs) are delivered. Opt-in: defaults to "none". */
  ping_mode: PingMode;
  /**
   * How the activity digest is delivered. Opt-in: defaults to "none"
   * (agent can still query it on demand via `disclaw-ctl digest`).
   */
  digest_mode: DigestMode;
  /**
   * How long after an agent_run ends before the daemon sends a quiet
   * idle nudge ("no new activity, you can sleep or do whatever").
   * Persisted; agent's preference. null = nudges off entirely.
   * Default: 60000 (60s).
   */
  idle_nudge_timeout_ms: number | null;
  /**
   * Pi session files keyed by `<provider>:<model>` (see {@link sessionKey}).
   * Each entry is the most recent session-file path the daemon observed
   * while running that provider/model. On daemon startup, the entry for
   * the current provider/model is passed as `--session <path>` to pi so
   * the transcript continues across restarts. Switching models with
   * `DISCLAW_MODEL=…` parks the old model's session under its key rather
   * than overwriting it, so swapping back later resumes where you left
   * off.
   */
  sessions: Record<string, string>;
  /**
   * @deprecated Legacy single-session field, superseded by {@link sessions}.
   * Migrated into `sessions[<provider>:<model>]` by the daemon on first
   * startup with this schema (only when the recorded provider/model
   * matches the running one — otherwise left in place until the matching
   * model runs again). Never written by current code; read for migration.
   */
  last_session_file?: string | null;
}

const DEFAULT_STATE: RouterState = {
  initialized: false,
  sysprompt: "",
  subscriptions: [],
  ping_mode: "none",
  digest_mode: "none",
  idle_nudge_timeout_ms: 60_000,
  sessions: {},
};

/** Registry key for per-model session tracking. */
export function sessionKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = path + ".tmp";
  // openSync to get an fd we can fsync before rename
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
  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RouterState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    throw new Error(
      `Failed to parse ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Move the file aside or delete it to start fresh.`,
    );
  }
}

export function saveState(state: RouterState): void {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  // Mirror sysprompt to a separate file the pi extension reads.
  // Empty string → still write an empty file (consistent with cleared state).
  atomicWrite(SYSPROMPT_FILE, state.sysprompt);
}
