/**
 * Pi RPC type fragments we depend on. Kept narrow so we don't have to
 * keep pi's full type universe in sync — only the bits we read.
 *
 * See https://pi.dev/docs/latest/rpc for the full schema.
 */

/**
 * What the host actually did with a deliver verb. May differ from the
 * verb the subscriber sent because the host adapts to pi's current
 * state (idle vs. streaming). E.g. a `prompt` while pi is streaming
 * is delivered as `follow-up`; a `follow-up` while pi is idle is
 * delivered as `prompt`.
 */
export type DeliveredAs = "prompt" | "follow-up" | "steer";
