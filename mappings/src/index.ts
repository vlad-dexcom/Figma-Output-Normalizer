// Public entry point for @figma-normalizator/mappings.
//
// Consumers (the plugin-extractor) should import `componentMap` (the parsed
// component-map.yaml, pre-generated to JSON at build time — see
// scripts/generate-map.mjs) plus the lookup helpers below, rather than
// reading/parsing the YAML themselves.
//
// Consumers should likewise import `tokenMap` (the bundled Android_Avalon
// token-map, trimmed and pre-generated to JSON at build time — see
// scripts/bundle-token-map.mjs) plus `findTokenSymbol` below, rather than
// reading mappings/token-map/*.token-map.json directly.
import componentMapJson from "./generated/component-map.json" with { type: "json" };
import tokenMapJson from "./generated/token-map.json" with { type: "json" };
import type {
  ComponentMap,
  ComponentMapEntry,
  ComponentMapValueEntry,
  ComponentMapVariantGroup,
  TokenMapBundleEntry,
} from "./types.js";

export * from "./types.js";

/** The parsed component-map.yaml, pre-generated to JSON at build time. */
export const componentMap = componentMapJson as unknown as ComponentMap;

/**
 * Normalizes a component-set name for fuzzy (but still conservative)
 * matching: trims whitespace, collapses repeated internal whitespace,
 * lowercases, and strips a single trailing "s" (naive singular/plural
 * folding — e.g. "Badge" vs. "Badges" in component-map.yaml, backlog B2).
 * This is deliberately narrow: it only tolerates case/whitespace/plural
 * drift, never fuzzy/substring matching, so it can't silently pair up two
 * genuinely different component sets.
 */
function normalizeComponentSetName(name: string): string {
  const collapsed = name.trim().replace(/\s+/g, " ").toLowerCase();
  return collapsed.endsWith("s") ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Looks up a component-map entry by Figma component set name. Tries an
 * exact match first, then falls back to a normalized (case/whitespace/
 * singular-plural insensitive) match — see `normalizeComponentSetName`.
 * The fallback exists because Figma component set names and
 * component-map.yaml entries are typed independently by humans and can
 * drift (e.g. "Badge" vs. "Badges"); it does not paper over genuinely
 * unmapped component sets, which still return `null`.
 */
export function findComponentMapEntry(figmaComponentSetName: string): ComponentMapEntry | null {
  const exact = componentMap.entries.find(
    (entry) => entry.figmaComponentSet === figmaComponentSetName,
  );
  if (exact) return exact;

  const normalizedTarget = normalizeComponentSetName(figmaComponentSetName);
  return (
    componentMap.entries.find(
      (entry) => normalizeComponentSetName(entry.figmaComponentSet) === normalizedTarget,
    ) ?? null
  );
}

/**
 * The bundled token-map (Android_Avalon, see mappings/token-map/README.md
 * and scripts/bundle-token-map-lib.mjs for why this product's map is the
 * one bundled) — trimmed to just the entries with a confirmed symbol, and
 * pre-generated to JSON at build time.
 */
export const tokenMap = tokenMapJson as unknown as TokenMapBundleEntry[];

/**
 * Path -> symbol index over `tokenMap`, built once (module-level, lazily on
 * first lookup) and reused for every subsequent `findTokenSymbol` call —
 * `tokenMap` has ~250 entries today and could grow along with the source
 * token-map, so a per-call linear scan (`Array.prototype.find`, as
 * `findComponentMapEntry` above does over ~a few hundred component-map
 * entries) would needlessly cost O(n) per resolved token instead of O(1).
 */
let tokenSymbolIndex: Map<string, string> | undefined;

function getTokenSymbolIndex(): Map<string, string> {
  tokenSymbolIndex ??= new Map(tokenMap.map((entry) => [entry.path, entry.symbol]));
  return tokenSymbolIndex;
}

/**
 * Looks up a Figma variable path (the same string carried by
 * `TokenValue.token`/`TokenRef.token`) against the bundled token-map.
 * Returns the confirmed Kotlin design-system symbol, or `undefined` when
 * the path has no entry in the bundled map, or has an entry whose `symbol`
 * couldn't be confidently derived (dropped from the bundle — see
 * `TokenMapBundleEntry`'s doc comment). Both cases are deliberately
 * indistinguishable to callers: an absent symbol is the normal, expected
 * state for most tokens today (see mappings/token-map/README.md), not a
 * hygiene problem to warn about.
 */
export function findTokenSymbol(path: string): string | undefined {
  return getTokenSymbolIndex().get(path);
}

/**
 * Applies any `routing` rules on `entry` given the instance's resolved
 * VARIANT-type property values (Figma property name -> raw variant value,
 * e.g. `{ Type: "Icon Only" }`). Returns the routed-to entry (e.g. Buttons
 * with Type=Icon Only routes to the "Buttons (Type=Icon Only)" entry), or
 * `entry` unchanged if no routing rule matches.
 *
 * `redirectTo` is authored as a human-readable string of the form
 * `"<figmaComponentSet> -> <ComposeComponent>"` (see component-map.yaml); we
 * only need the component set name half to re-look-up the target entry.
 */
export function resolveRouting(
  entry: ComponentMapEntry,
  figmaVariantValues: Record<string, string>,
): ComponentMapEntry {
  for (const rule of entry.routing ?? []) {
    if (figmaVariantValues[rule.when.figmaProperty] === rule.when.figmaValue) {
      const targetSetName = rule.redirectTo.split("->")[0]?.trim();
      const target = targetSetName ? findComponentMapEntry(targetSetName) : null;
      if (target) return target;
    }
  }
  return entry;
}

export type VariantResolution =
  | { status: "mapped"; composeProperty: string; composeValue: string | boolean }
  | { status: "unmapped"; composeProperty?: string; reason: string }
  | { status: "no-mapping" };

/**
 * Resolves a single Figma VARIANT-type property value (e.g.
 * `figmaProperty: "Style", figmaValue: "Primary"`) against a component-map
 * entry's `variants` groups. Never guesses: an unmapped or unknown value
 * always resolves to `{ status: "unmapped" | "no-mapping" }` rather than a
 * fallback value.
 */
export function resolveVariantValue(
  entry: ComponentMapEntry,
  figmaProperty: string,
  figmaValue: string,
): VariantResolution {
  const group: ComponentMapVariantGroup | undefined = entry.variants?.find(
    (v) => v.figmaProperty === figmaProperty,
  );
  if (!group) return { status: "no-mapping" };

  if (group.status === "unmapped") {
    return {
      status: "unmapped",
      composeProperty: group.composeProperty,
      reason: group.reason ?? `No Compose mapping exists for Figma property "${figmaProperty}".`,
    };
  }

  const match: ComponentMapValueEntry | undefined = group.values?.find(
    (v) => v.figmaValue === figmaValue,
  );
  if (!match) return { status: "no-mapping" };

  if (match.status === "unmapped" || match.composeValue === undefined) {
    return {
      status: "unmapped",
      composeProperty: group.composeProperty,
      reason:
        match.reason ??
        `Figma value "${figmaValue}" for property "${figmaProperty}" has no Compose equivalent.`,
    };
  }

  return {
    status: "mapped",
    composeProperty: group.composeProperty ?? figmaProperty,
    composeValue: match.composeValue,
  };
}

/**
 * Resolves a state-based (non-VARIANT-enum) mapping, e.g. Switch's
 * State=On/Off -> checked=true/false.
 */
export function resolveStateValue(
  entry: ComponentMapEntry,
  figmaProperty: string,
  figmaValue: string,
): VariantResolution {
  const group = entry.stateMapping?.find((v) => v.figmaProperty === figmaProperty);
  if (!group) return { status: "no-mapping" };
  const match = group.values.find((v) => v.figmaValue === figmaValue);
  if (!match) return { status: "no-mapping" };
  return {
    status: "mapped",
    composeProperty: group.composeProperty,
    composeValue: match.composeValue,
  };
}
