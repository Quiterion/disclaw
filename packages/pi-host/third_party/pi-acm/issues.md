tool call error:

```
 write ~/Documents/projects/personal/pi-term/pi-boundary/src/boundary.ts

 write ~/Documents/projects/personal/pi-term/pi-boundary/src/boundary.ts

 import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
 import { state } from "./state.js"

 /**
  * Detect the project filesystem boundary.
  *
  * Runs `git rev-parse --show-toplevel` to find the git worktree root.
  * Falls back to `cwd` if git is not available or the directory is not a git repo.
  */
 export async function detectBoundary(
 ... (33 more lines, 43 total, ctrl+o to expand)


 ⠸ Working...
[pi-acm] WARNING: toolCall toolu_019ToWW935VqVsf89re1V9yP has no matching toolResult after ACM filtering────────────────────────────────────────────────────────────────
~/Documents/projects/personal/pi-term (main)

```
