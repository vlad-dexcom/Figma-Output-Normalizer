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
// Consumers should likewise import the wiring-rule evaluator
// (`resolveTokenSymbol`, from ./wiring.ts) rather than a checked-in
// token->symbol table; the former 2371-row token-map artifacts were retired
// in favour of the rules they encoded (see mappings/wiring-rules/README.md).
import componentMapJson from "./generated/component-map.json" with { type: "json" };
import type {
  ComponentMap,
  ComponentMapEntry,
  ComponentMapValueEntry,
  ComponentMapVariantGroup,
} from "./types.js";

export * from "./types.js";
export { resolveTokenSymbol, toCamelCaseSegment, wiringRules } from "./wiring.js";
export { collectionsPolicy, createPolicyEvaluator, globMatches, globToRegExp } from "./policy.js";

/** The parsed component-map.yaml, pre-generated to JSON at build time. */
export const componentMap = componentMapJson as unknown as ComponentMap;

/**
 * The outcome of looking up a Figma component set in the component map.
 * `matchedBy` records *how* the entry was found so callers can surface a
 * drift warning: matching on `figmaNodeId` is stable across renames, while
 * matching on `name` is not — a renamed component set silently stops
 * matching, which is exactly the failure this field makes visible.
 */
export interface ComponentMapLookup {
  entry: ComponentMapEntry | null;
  matchedBy: "figmaNodeId" | "name" | null;
  /** Set when the entry was found by node id but its recorded name is stale. */
  nameDrift?: { mapName: string; figmaName: string };
}

/**
 * Looks up a component-map entry, preferring the stable Figma node id over
 * the display name.
 *
 * The map has always carried `figmaNodeId` "for traceability" while lookup
 * matched on `figmaComponentSet` (the *name*) — so renaming a component set
 * in Figma silently unmapped every instance of it, degrading those nodes
 * into raw geometry trees. Node id is now the primary key; the name is kept
 * as a fallback (entries may legitimately have `figmaNodeId: null`) and a
 * name/id disagreement is reported rather than ignored.
 */
export function lookupComponentMapEntry(
  figmaComponentSetName: string,
  figmaNodeId?: string | null,
): ComponentMapLookup {
  if (figmaNodeId) {
    const byId = componentMap.entries.find((entry) => entry.figmaNodeId === figmaNodeId);
    if (byId) {
      return {
        entry: byId,
        matchedBy: "figmaNodeId",
        ...(byId.figmaComponentSet !== figmaComponentSetName
          ? { nameDrift: { mapName: byId.figmaComponentSet, figmaName: figmaComponentSetName } }
          : {}),
      };
    }
  }

  const byName = componentMap.entries.find(
    (entry) => entry.figmaComponentSet === figmaComponentSetName,
  );
  return byName ? { entry: byName, matchedBy: "name" } : { entry: null, matchedBy: null };
}

/** Looks up a component-map entry by its exact Figma component set name. */
export function findComponentMapEntry(figmaComponentSetName: string): ComponentMapEntry | null {
  return lookupComponentMapEntry(figmaComponentSetName).entry;
}

/**
 * A count of how much of the component map is actually usable.
 *
 * Mapping coverage is the single variable that decides whether the IR is
 * useful: an unmapped instance is not emitted as an `instance` node at all,
 * so the extractor recurses into its raw children and the IR degrades into
 * the geometry tree this project exists to avoid. That makes coverage a
 * first-class health metric, not trivia — so it is computed rather than
 * left to be guessed at from the YAML.
 */
export interface ComponentMapCoverage {
  entries: number;
  mappedEntries: number;
  /** Entries with no `figmaNodeId`, i.e. only matchable by a rename-fragile name. */
  entriesWithoutNodeId: number;
  variantValues: number;
  mappedVariantValues: number;
}

export function componentMapCoverage(map: ComponentMap = componentMap): ComponentMapCoverage {
  let variantValues = 0;
  let mappedVariantValues = 0;

  for (const entry of map.entries) {
    for (const group of entry.variants ?? []) {
      for (const value of group.values ?? []) {
        variantValues += 1;
        if (
          group.status !== "unmapped" &&
          value.status !== "unmapped" &&
          value.composeValue !== undefined
        ) {
          mappedVariantValues += 1;
        }
      }
    }
  }

  return {
    entries: map.entries.length,
    mappedEntries: map.entries.filter((e) => e.status === "mapped").length,
    entriesWithoutNodeId: map.entries.filter((e) => !e.figmaNodeId).length,
    variantValues,
    mappedVariantValues,
  };
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
