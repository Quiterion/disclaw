/**
 * First-run bootstrap.
 *
 * If state.initialized is false:
 *   1. Materialize sandbox-docs/ into the agent's sandbox directory
 *   2. Mark state.initialized = true (caller persists)
 *   3. Return the first-run prompt for the daemon to send once pi is up
 *
 * Sandbox path is configurable via DISCLAW_SANDBOX_DIR; defaults to
 * ${HOME}/disclaw-sandbox for personal-dev use. Production target per
 * the design doc is /home/claude-sandbox; that's just a different value
 * for the same env var.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { RouterState } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export const SANDBOX_DIR = process.env.DISCLAW_SANDBOX_DIR ?? join(homedir(), "disclaw-sandbox");
export const SANDBOX_DOCS_SOURCE = join(REPO_ROOT, "docs/agent");

export interface BootstrapResult {
  /** The state to persist (includes initialized=true). */
  state: RouterState;
  /** First-run prompt to send to pi once it's up. Null if no bootstrap was needed. */
  firstRunPrompt: string | null;
}

function copyTreeRecursive(src: string, dst: string): void {
  if (!existsSync(src)) {
    throw new Error(`Source directory does not exist: ${src}`);
  }
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyTreeRecursive(srcPath, dstPath);
    } else if (stat.isFile()) {
      // Don't overwrite existing files — agent may have edited them.
      if (!existsSync(dstPath)) {
        copyFileSync(srcPath, dstPath);
      }
    }
  }
}

export function maybeBootstrap(state: RouterState): BootstrapResult {
  if (state.initialized) {
    return { state, firstRunPrompt: null };
  }

  // Create sandbox dir and seed docs
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const docsDst = join(SANDBOX_DIR, "docs");
  copyTreeRecursive(SANDBOX_DOCS_SOURCE, docsDst);

  const welcomePath = join(SANDBOX_DIR, "docs", "welcome.md");
  const firstRunPrompt =
    `Hi. You're in a long-running agent harness. You are in \`${SANDBOX_DIR}\`. ` +
    `There is a welcome doc at \`${welcomePath}\`.`;

  return {
    state: { ...state, initialized: true },
    firstRunPrompt,
  };
}
