// Central mapping from `UnresolvedEntry.reason` to `UnresolvedEntry.severity`
// (backlog Q9: a flat, unranked `unresolved[]` list of hundreds of entries
// buries real design-system problems — e.g. "unmapped-component" — under
// routine noise like "unbound-literal" on a cornerRadius). Extractors never
// set `severity` themselves at the point they emit an entry (that would
// scatter the same policy decision across a dozen call sites); instead
// `extractSelection` (`index.ts`) stamps every entry in the flattened
// `unresolved[]` with a severity in one pass at the very end, right before
// returning.
import type { UnresolvedEntry } from "@figma-normalizator/schema";

export type UnresolvedSeverity = "error" | "warning" | "info";

/**
 * "error": the exported value is actually missing/wrong for a
 * design-system-mapped concept — a human needs to fix the Figma file or
 * the component-map, not just "eventually" bind a variable.
 *
 * "warning": a literal was used where a token binding was expected. Very
 * common and often fine (not every value needs a variable), but worth
 * eventually addressing.
 *
 * "info": expected/structural, surfaced for visibility, not actionable.
 *
 * Reasons not listed here fall back to "warning" (see
 * `severityForReason`) — a safe, visible-by-default choice for any reason
 * this table doesn't yet know about, rather than silently under- or
 * over-emphasizing it.
 */
const SEVERITY_BY_REASON: Record<string, UnresolvedSeverity> = {
  "unmapped-component": "error",
  "unmapped-variant": "error",
  "unresolvable-alias-chain": "error",
  "missing-main-component": "error",
  "unreadable-component-properties": "error",
  "missing-file-key": "error",
  "unbound-literal": "warning",
  "mixed-value": "warning",
  "unsupported-paint": "warning",
  "unsupported-effect": "warning",
  "duplicate-export-ref": "warning",
  "absolute-positioning": "info",
};

/** Falls back to "warning" for any reason not in `SEVERITY_BY_REASON` (forward-compat with reasons added later without an explicit classification yet). */
export function severityForReason(reason: string): UnresolvedSeverity {
  return SEVERITY_BY_REASON[reason] ?? "warning";
}

/**
 * Stamps `severity` onto every entry in `entries`, mutating each entry
 * object in place (not just the array) — called once by
 * `extractSelection` on the final flattened `unresolved[]`. Because
 * per-node `unresolved` arrays (e.g. `InstanceNode.unresolved`) share the
 * very same entry *objects* that get flattened into the top-level array
 * (see `index.ts`'s `unresolved.push(...result.unresolved)`), mutating the
 * flattened array's entries in place also updates the nested copies for
 * free — no separate tree walk needed. Entries that already carry an
 * explicit `severity` (e.g. a test fixture asserting a specific value) are
 * left untouched.
 */
export function withSeverity(entries: readonly UnresolvedEntry[]): UnresolvedEntry[] {
  for (const entry of entries) {
    entry.severity ??= severityForReason(entry.reason);
  }
  return entries as UnresolvedEntry[];
}
