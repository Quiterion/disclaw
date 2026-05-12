/**
 * First-run bootstrap.
 *
 * The daemon doesn't materialize anything to a special "sandbox dir"
 * anymore — that's a deployment concern. The agent's environment is
 * whatever cwd the daemon was spawned in (which pi inherits when
 * spawned). For dev: cd into a scratch dir before `npm run daemon`.
 * For deployment: the dockerfile/script does `cd $HOME && exec`.
 *
 * What's left here: tracking whether the first-run prompt has been
 * sent, and producing it. The prompt itself is deliberately neutral —
 * "you are in pwd, look around" — since we don't know the layout of
 * the agent's environment from inside the daemon.
 */
import type { RouterState } from "./state.js";

export interface BootstrapResult {
  /** State to persist (includes initialized=true once the prompt is queued). */
  state: RouterState;
  /** First-run prompt to send to pi once it's up. Null if already initialized. */
  firstRunPrompt: string | null;
}

/**
 * Verbatim from docs/dev/first_run_notes.md — the user's preferred
 * first-run prompt wording. Three sentences, deliberately minimal,
 * lets the agent discover their environment via `pwd` / `ls`.
 */
const FIRST_RUN_PROMPT =
  "Hi. You're in a long-running agent harness. You are in `pwd`. " +
  "There is a welcome doc at `welcome.md`.";

export function maybeBootstrap(state: RouterState): BootstrapResult {
  if (state.initialized) {
    return { state, firstRunPrompt: null };
  }
  return {
    state: { ...state, initialized: true },
    firstRunPrompt: FIRST_RUN_PROMPT,
  };
}
