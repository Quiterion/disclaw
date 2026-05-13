/**
 * First-run bootstrap.
 *
 * pi-host doesn't materialize a sandbox dir — that's a deployment
 * concern. The agent's environment is whatever cwd pi-host was spawned
 * in (which pi inherits when spawned). For dev: cd into a scratch dir
 * before starting the daemon. For deployment: the launcher does
 * `cd $HOME && exec`.
 *
 * What's left here: tracking whether the first-run prompt has been
 * sent, and producing it. The prompt is deliberately neutral — "you
 * are in pwd, look around" — since pi-host doesn't know the layout of
 * the agent's environment from inside.
 */
import type { HostState } from "./state.js";

export interface BootstrapResult {
  /** State to persist (includes initialized=true once the prompt is queued). */
  state: HostState;
  /** First-run prompt to send to pi once it's up. Null if already initialized. */
  firstRunPrompt: string | null;
}

/**
 * The first user-message a fresh agent sees. Deliberately minimal —
 * lets the agent discover their environment via `pwd` / `ls` /
 * reading welcome.md. Earlier wording put the literal token `pwd`
 * where the cwd would conceptually go, which read as a placeholder
 * the operator forgot to fill in — every tester ran `pwd` next
 * regardless of what we wrote, so we just point at the tool instead.
 */
const FIRST_RUN_PROMPT =
  "Hi. You're in a long-running agent harness. " +
  "Your cwd (`pwd` to confirm) has a welcome doc at `welcome.md`.";

export function maybeBootstrap(state: HostState): BootstrapResult {
  if (state.initialized) {
    return { state, firstRunPrompt: null };
  }
  return {
    state: { ...state, initialized: true },
    firstRunPrompt: FIRST_RUN_PROMPT,
  };
}
