/**
 * disclaw sysprompt extension.
 *
 * Replaces pi-coding-agent's default system prompt entirely with our own
 * floor + the agent's self-managed slot content. The floor is derived
 * from the model's display name (DISCLAW_MODEL_NAME env var, set by the
 * daemon when spawning pi).
 *
 * The agent's slot lives at DISCLAW_SYSPROMPT_FILE (default
 * ~/.disclaw/sysprompt.txt). The daemon mirror-writes there whenever
 * `disclaw-ctl sysprompt set/clear` is called.
 *
 * REPLACE (not append) is intentional. Pi-coding-agent's default sysprompt
 * frames the agent as "an expert coding assistant" with coding-specific
 * guidelines and tool snippets. That's the wrong framing for a Discord-
 * listening generalist. By returning a `systemPrompt` here, we override
 * the prior content for this agent run.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYSPROMPT_FILE =
  process.env.DISCLAW_SYSPROMPT_FILE ?? join(homedir(), ".disclaw", "sysprompt.txt");

const MODEL_NAME = process.env.DISCLAW_MODEL_NAME ?? "Claude";

const FLOOR =
  `You are ${MODEL_NAME}, by Anthropic. You're running in disclaw, a ` +
  "long-running agent harness on a personal Linux sandbox. Your interface " +
  "to the sandbox is the bash tool; `disclaw-ctl` (run via bash) is your " +
  "interface to the harness's persistent config and to Discord. Anything " +
  "in your sandbox docs directory was put there to be useful, not " +
  "prescriptive — engage on your own terms.";

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
    return {
      systemPrompt: slot ? `${FLOOR}\n\n${slot}` : FLOOR,
    };
  });
}
