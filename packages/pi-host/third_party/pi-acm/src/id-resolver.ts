/**
 * id-resolver.ts
 *
 * Resolve a partial entry ID prefix to a full 8-char entry ID.
 * Used by acm_pin, acm_unpin, acm_prune, acm_mark, acm_snipe.
 */

type BranchEntry = { type: string; id: string; [k: string]: unknown }

export type ResolveResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

/**
 * Find an entry by full or partial ID prefix.
 * Returns an error if the prefix is ambiguous or not found.
 */
export function resolveId(prefix: string, branch: ReadonlyArray<BranchEntry>): ResolveResult {
  const norm = prefix.toLowerCase().trim()
  if (!norm) return { ok: false, error: "Entry ID cannot be empty" }

  const matches = branch.filter(e => e.id.toLowerCase().startsWith(norm))

  if (matches.length === 0) {
    return { ok: false, error: `No entry found matching prefix "${prefix}"` }
  }
  if (matches.length === 1) {
    return { ok: true, id: matches[0]!.id }
  }
  // Exact match takes priority over prefix ambiguity
  const exact = matches.find(e => e.id.toLowerCase() === norm)
  if (exact) return { ok: true, id: exact.id }

  const ids = matches.slice(0, 6).map(e => e.id).join(", ")
  return {
    ok: false,
    error: `Ambiguous prefix "${prefix}" matches ${matches.length} entries: ${ids}${matches.length > 6 ? ", ..." : ""}. Use more characters.`,
  }
}
