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

import type { PingMode } from "./protocol.js";

export interface RouterState {
  initialized: boolean;
  sysprompt: string;
  /** Set of Discord channel IDs the agent has subscribed to. */
  subscriptions: string[];
  /** How pings (mentions/DMs) are delivered. Opt-in: defaults to "none". */
  ping_mode: PingMode;
  /**
   * How long after an agent_run ends before the daemon sends a quiet
   * idle nudge ("no new activity, you can sleep or do whatever").
   * Persisted; agent's preference. null = nudges off entirely.
   * Default: 60000 (60s).
   */
  idle_nudge_timeout_ms: number | null;
}

const DEFAULT_STATE: RouterState = {
  initialized: false,
  sysprompt: "",
  subscriptions: [],
  ping_mode: "none",
  idle_nudge_timeout_ms: 60_000,
};

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
