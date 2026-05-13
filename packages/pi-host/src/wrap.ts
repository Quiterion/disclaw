/**
 * pi-host's wrapper for messages it injects into pi as user prompts
 * (first-run bootstrap, idle nudges, sleep-expired nudges).
 *
 * Format mirrors the bridge's `<discord>` wrap shape — a `<time>`
 * opener carrying wall-clock for transcript-readability decades hence,
 * then the body. The element name (`pi-host`) tells the agent *which
 * subsystem* originated this message so they can tell a daemon nudge
 * apart from a real Discord ping.
 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimeOpener(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

export function wrapHostMessage(body: string, now: number = Date.now()): string {
  return `<pi-host>\n<time>${formatTimeOpener(now)}</time>\n${body}\n</pi-host>`;
}
