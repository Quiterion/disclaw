import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerStateHandlers } from "../src/state.js"
import { registerContextHandler } from "../src/context-filter.js"
import { registerChessClock } from "../src/chess-clock.js"
import { registerWhisperHandler } from "../src/whisper.js"
import { registerCompactionHandler } from "../src/compaction.js"
import { registerObserveTools } from "../src/tools/observe.js"
import { registerControlTools } from "../src/tools/control.js"
import { registerSnipeTool } from "../src/tools/snipe.js"
import { registerCompactTool } from "../src/tools/compact.js"
import { registerRecallTool } from "../src/tools/recall.js"
import { registerCommands } from "../src/ui/commands.js"
import { registerStatusWidget } from "../src/ui/status.js"

export default function (pi: ExtensionAPI) {
  // State layer — must be first so all other modules have state on load
  registerStateHandlers(pi)

  // Core pipeline
  registerContextHandler(pi)
  registerChessClock(pi)
  registerWhisperHandler(pi)
  registerCompactionHandler(pi)

  // LLM tools
  registerObserveTools(pi)
  registerControlTools(pi)
  registerSnipeTool(pi)
  registerCompactTool(pi)
  registerRecallTool(pi)

  // User-facing commands and TUI
  registerCommands(pi)
  registerStatusWidget(pi)
}
