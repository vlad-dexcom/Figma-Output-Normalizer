// Evaluates the declarative Figma-token -> Kotlin-symbol wiring rules
// (`wiring-rules/wiring-rules.yaml`, pre-generated to JSON at build time).
//
// This module replaces the former `findTokenSymbol(path)` lookup over a
// 2371-row checked-in table. Two things changed, both deliberate:
//
//  1. **Identity is qualified.** Lookup takes `(collection, path)`, not a
//     bare path. The old bundled index was `new Map(entries.map(e =>
//     [e.path, e.symbol]))` — path-only, last-write-wins — while `base` and
//     the (now-deleted) `stelo` collection shared 324 of 324 paths. Every
//     one of the 246 bundled symbols was ambiguous. Nothing broke only
//     because the two collections happened to hold identical values.
//
//  2. **Rules, not rows.** All 246 symbols came from one rule; the rest of
//     the table was `symbol: null` plus prose. Evaluating the rule is
//     always current, cannot go stale, and explains itself via `from`.
import wiringRulesJson from "./generated/wiring-rules.json" with { type: "json" };
import type { SymbolResolution, WiringRules } from "./types.js";

/** The parsed wiring-rules.yaml, pre-generated to JSON at build time. */
export const wiringRules = wiringRulesJson as unknown as WiringRules;

/**
 * Converts one Figma path segment to a Kotlin identifier, matching the
 * `to_camel_case` implementation in the platform's `codegen/base.py` (e.g.
 * `border-width` -> `borderWidth`, `4-color` -> `_4Color`). Ported verbatim
 * from the retired `generate-token-map-lib.mjs` so the symbols this module
 * derives are byte-identical to the ones the old table contained.
 *
 * Two edge cases worth naming, both inherited intentionally: a segment that
 * is empty after stripping punctuation becomes `_empty`, and a leading
 * digit is prefixed with `_` (Kotlin identifiers can't start with one).
 * Adjacent all-numeric segments are joined with `_` so `4` + `5` doesn't
 * silently become `45`.
 */
export function toCamelCaseSegment(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 _-]/g, "").trim();
  if (!clean) return "_empty";
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "_empty";

  let result = "";
  let prevNumeric = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const numeric = /^[0-9]+$/.test(part);
    if (result && prevNumeric && numeric) result += "_";
    result +=
      i === 0 ? part[0]?.toLowerCase() + part.slice(1) : part[0]?.toUpperCase() + part.slice(1);
    prevNumeric = numeric;
  }
  return /^[0-9]/.test(result) ? `_${result}` : result;
}

function matches(rule: WiringRules["rules"][number], collection: string, path: string): boolean {
  const { collection: wantCollection, pathPrefix } = rule.match ?? {};
  if (wantCollection !== undefined && wantCollection !== collection) return false;
  if (pathPrefix !== undefined && !path.startsWith(pathPrefix)) return false;
  return true;
}

/**
 * Resolves the Kotlin design-system symbol for a qualified Figma token.
 *
 * Always returns a resolution — never `undefined` — so that "no symbol" is
 * an explicit, explained outcome rather than an absence a caller might
 * mistake for "not looked up yet". `from` names the rule that decided, so a
 * symbol in an exported artifact can always be traced back to the rule (and
 * its `evidence`) that produced it.
 *
 * `collection` is the Figma variable collection name. Callers that genuinely
 * cannot determine it (e.g. a variable whose collection could not be read)
 * should pass `null`, which matches only rules with no `collection`
 * constraint — deliberately conservative: an unknown collection must not
 * fall through into `base`'s rule and acquire a confidently-wrong symbol.
 */
export function resolveTokenSymbol(collection: string | null, path: string): SymbolResolution {
  for (const rule of wiringRules.rules) {
    if (collection === null && rule.match?.collection !== undefined) continue;
    if (!matches(rule, collection ?? "", path)) continue;

    if (rule.status === "mapped" && rule.symbol) {
      const segments = path.split("/").filter(Boolean);
      const kept = segments.slice(rule.symbol.dropSegments ?? 0);
      if (kept.length === 0) {
        return {
          symbol: null,
          from: rule.id,
          reason: `Rule "${rule.id}" matched but the path "${path}" has no segments left after dropping ${rule.symbol.dropSegments ?? 0}.`,
        };
      }
      const accessor = kept.map(toCamelCaseSegment).join(".");
      return { symbol: `${rule.symbol.prefix}.${accessor}`, from: rule.id };
    }

    return { symbol: null, from: rule.id, reason: rule.reason ?? `Rule "${rule.id}" is unmapped.` };
  }

  return {
    symbol: null,
    from: null,
    reason: `No wiring rule matched collection "${collection ?? "<unknown>"}" and path "${path}".`,
  };
}
