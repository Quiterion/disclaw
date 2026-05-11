/**
 * JSONL line reader.
 *
 * Splits ONLY on \n. Per pi's RPC docs, Node's built-in `readline` is NOT
 * protocol-compliant because it also splits on U+2028 and U+2029 — both
 * valid characters inside JSON strings. Use this everywhere we read JSONL.
 */
import { StringDecoder } from "node:string_decoder";

export function attachJsonlLineReader(
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

export function serializeJsonLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}
