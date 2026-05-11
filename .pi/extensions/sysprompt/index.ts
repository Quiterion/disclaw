/**
 * disclaw sysprompt extension.
 *
 * Reads the agent's self-managed system-prompt slot fresh on every
 * `before_agent_start` and appends it to pi's system prompt. The slot's
 * content is whatever the daemon last wrote to ~/.disclaw/sysprompt.txt
 * (via `disclaw-ctl sysprompt set`).
 *
 * If the file is missing or empty, this no-ops — pi runs with its
 * floor system prompt only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYSPROMPT_FILE =
  process.env.DISCLAW_SYSPROMPT_FILE ?? join(homedir(), ".disclaw", "sysprompt.txt");

// We type the API loosely (any) to avoid a hard dependency on the
// pi-coding-agent package types from this leaf extension. Pi's loader
// will inject the real ExtensionAPI at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionAPI = any;

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any) => {
    let body: string;
    try {
      body = readFileSync(SYSPROMPT_FILE, "utf-8").trim();
    } catch {
      return; // file missing — no addition
    }
    if (!body) return; // empty — no addition

    const prior: string | undefined = event.systemPrompt;
    return {
      systemPrompt: prior ? `${prior}\n\n${body}` : body,
    };
  });
}
