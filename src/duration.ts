/**
 * Human-friendly duration parsing.
 *
 * Accepts: "30s", "5m", "1h", "1.5h", "off", or a bare integer (seconds).
 * Returns ms as a number, or null for "off".
 *
 * Throws on anything else (caller should catch + die-with-friendly-msg).
 */

export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === "off" || s === "none" || s === "never") return null;

  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?$/);
  if (!m) {
    throw new Error(
      `cannot parse duration "${input}". use forms like "30s", "5m", "1h", or "off"`,
    );
  }
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? "s";
  let multMs: number;
  switch (unit) {
    case "s": case "sec": case "secs": case "seconds":
      multMs = 1000; break;
    case "m": case "min": case "mins": case "minutes":
      multMs = 60_000; break;
    case "h": case "hr": case "hrs": case "hours":
      multMs = 3_600_000; break;
    default:
      throw new Error(`unknown duration unit: ${unit}`);
  }
  return Math.round(n * multMs);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "off";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = ms / 60_000;
    return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
  }
  const h = ms / 3_600_000;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}
