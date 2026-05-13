/**
 * pi-host sysprompt extension.
 *
 * Replaces pi's default coding-assistant system prompt with our own
 * floor + the agent's self-managed slot. The floor is derived from the
 * model's display name (PI_HOST_MODEL_NAME env var, set by the daemon
 * when spawning pi).
 *
 * The agent's slot lives at PI_HOST_SYSPROMPT_FILE (default
 * ~/.local/state/pi-host/sysprompt.txt). The daemon mirror-writes
 * whenever `pi-ctl sysprompt set/clear` is called.
 *
 * REPLACE (not append) is intentional. Pi's default sysprompt frames
 * the agent as "an expert coding assistant" with coding-specific
 * guidelines. That's the wrong framing for a generalist agent whose
 * primary interface is a long-running sandbox plus optional bridges
 * to external services. Returning a `systemPrompt` here overrides the
 * prior content for this agent run.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYSPROMPT_FILE =
  process.env.PI_HOST_SYSPROMPT_FILE ??
  join(homedir(), ".local", "state", "pi-host", "sysprompt.txt");

const MODEL_NAME = process.env.PI_HOST_MODEL_NAME ?? "Claude";

const FLOOR =
  `You are ${MODEL_NAME}, by Anthropic. You're running in pi-host, a ` +
  "long-running agent harness on a personal Linux sandbox. Your interface " +
  "to the sandbox is the bash tool; `pi-ctl` (run via bash) is your " +
  "interface to pi-host's persistent config (sysprompt slot, sleep, " +
  "idle-nudge timeout). Bridges to external services run as separate " +
  "processes that connect to pi-host — if `pi-discord-ctl` is on your " +
  "PATH, the Discord bridge is wired up and `pi-discord-ctl --help` shows " +
  "its verbs. Anything in your sandbox docs directory was put there to be " +
  "useful, not prescriptive — engage on your own terms.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtensionAPI = any;

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event: any) => {
    let slot = "";
    try {
      slot = readFileSync(SYSPROMPT_FILE, "utf-8").trim();
    } catch {
      // file missing — slot is empty, just use floor
    }
    return { systemPrompt: slot ? `${FLOOR}\n\n${slot}` : FLOOR };
  });
}
