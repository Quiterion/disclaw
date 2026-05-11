/**
 * slice 0: pi RPC smoke test
 *
 * Spawns `pi --mode rpc`, sends one prompt, reads events to agent_end,
 * prints a summary. The point is to verify that pi behaves the way the
 * design doc assumes — especially the agent_start / agent_end semantics
 * we're going to build the entire router around.
 *
 * Run with: npm run slice0
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_SCRIPT = resolve(__dirname, "../third_party/pi/pi-test.sh");
const PROVIDER = "anthropic";
const MODEL = "claude-haiku-4-5";
const PROMPT = "Hi. What model are you, in one sentence?";
const TIMEOUT_MS = 60_000;

/**
 * JSONL line reader that splits ONLY on \n. Per pi's RPC docs, Node's
 * built-in readline is NOT protocol-compliant because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings.
 */
function attachJsonlLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const i = buffer.indexOf("\n");
      if (i === -1) break;
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.trim()) onLine(buffer);
  });
}

const pi = spawn(
  PI_SCRIPT,
  ["--mode", "rpc", "--no-session", "--provider", PROVIDER, "--model", MODEL],
  { stdio: ["pipe", "pipe", "pipe"], env: process.env },
);

pi.on("error", (err) => {
  console.error("Failed to spawn pi:", err);
  process.exit(1);
});

let agentStartTime: number | null = null;
let agentEndTime: number | null = null;
const eventOrder: string[] = [];
const accumulatedText: string[] = [];

pi.stderr.on("data", (chunk) => process.stderr.write(`[pi-stderr] ${chunk}`));

attachJsonlLineReader(pi.stdout, (line) => {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch (err) {
    console.error("Bad JSON from pi:", JSON.stringify(line));
    return;
  }
  const t: string = event.type;

  if (t === "response") {
    console.log(
      `[response] command=${event.command} success=${event.success}` +
        (event.error ? ` error=${event.error}` : ""),
    );
    return;
  }

  // Suppress noisy per-token events from the timeline (they're useful for
  // text accumulation but pollute the event-order summary).
  if (t !== "message_update") eventOrder.push(t);

  if (t === "agent_start") agentStartTime = Date.now();
  if (t === "agent_end") agentEndTime = Date.now();

  if (t === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame?.type === "text_delta") accumulatedText.push(ame.delta);
  }

  if (t === "agent_end") setTimeout(printSummaryAndExit, 50);
});

pi.on("exit", (code) => {
  if (agentEndTime === null) {
    console.error(
      `pi exited (code=${code}) without agent_end. Events: ${eventOrder.join(", ")}`,
    );
    process.exit(1);
  }
});

const timeoutHandle = setTimeout(() => {
  console.error(`Timeout after ${TIMEOUT_MS}ms. Events seen: ${eventOrder.join(", ")}`);
  pi.kill();
  process.exit(1);
}, TIMEOUT_MS);

// Send the prompt. Node buffers stdin writes, so even if pi hasn't
// finished init yet, this lands when it starts reading.
const cmd = JSON.stringify({ type: "prompt", message: PROMPT });
pi.stdin.write(cmd + "\n");

function printSummaryAndExit(): void {
  clearTimeout(timeoutHandle);
  console.log("\n=== Slice 0 summary ===");
  console.log(`Model:        ${PROVIDER}/${MODEL}`);
  console.log(`Prompt:       ${PROMPT}`);
  console.log(`Events:       ${eventOrder.join(" → ")}`);
  console.log(`Final text:   ${accumulatedText.join("")}`);
  if (agentStartTime !== null && agentEndTime !== null) {
    console.log(`agent_start → agent_end: ${agentEndTime - agentStartTime}ms`);
  }
  pi.kill();
  process.exit(0);
}
