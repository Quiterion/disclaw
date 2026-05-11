/**
 * Minimal bash tool for the agent.
 *
 * Executes a command via /bin/bash -c, captures stdout+stderr together,
 * returns output as text. Hard limit on output size; if exceeded, the
 * tail wins and we mark the result truncated.
 *
 * Significantly simpler than pi-coding-agent's bash (no streaming
 * updates, no temp-file overflow, no TUI rendering hooks). Sufficient
 * for an agent that runs commands occasionally and keeps output bounded.
 */
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 60)" })),
});

export interface BashToolOptions {
  /** Working directory for commands. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment to inherit (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export function createBashTool(options: BashToolOptions = {}): AgentTool<typeof bashSchema> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command. Returns combined stdout and stderr as text. " +
      `Output is truncated to the last ${MAX_OUTPUT_BYTES / 1024} KiB if larger. ` +
      "Default timeout is 60 seconds; pass `timeout` (seconds) to override.",
    parameters: bashSchema,
    async execute(_toolCallId, params, signal) {
      const timeoutSecs = params.timeout ?? 60;

      return await new Promise((resolve, reject) => {
        const child = spawn("/bin/bash", ["-c", params.command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let buffer = Buffer.alloc(0);
        let truncated = false;

        const onChunk = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_OUTPUT_BYTES) {
            buffer = buffer.subarray(buffer.length - MAX_OUTPUT_BYTES);
            truncated = true;
          }
        };

        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);

        const timeoutHandle = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        }, timeoutSecs * 1000);

        const onAbort = () => child.kill("SIGTERM");
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        child.on("error", (err) => {
          clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        });

        child.on("close", (code, sig) => {
          clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          let text = buffer.toString("utf-8");
          if (truncated) {
            text = `[output truncated; showing last ${MAX_OUTPUT_BYTES / 1024} KiB]\n${text}`;
          }
          if (text === "") text = "(no output)";

          if (sig === "SIGTERM" && signal?.aborted) {
            reject(new Error(`Command aborted.\n${text}`));
            return;
          }
          if (sig === "SIGTERM") {
            reject(new Error(`Command timed out after ${timeoutSecs}s.\n${text}`));
            return;
          }
          if (code !== 0 && code !== null) {
            reject(new Error(`Command exited with code ${code}.\n${text}`));
            return;
          }
          resolve({ content: [{ type: "text", text }], details: {} });
        });
      });
    },
  };
}
