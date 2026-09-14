// Typed shape of the parsed component-map.yaml / generated component-map.json.
// Kept intentionally close to the YAML shape documented in
// mappings/README.md rather than a bespoke normalized model, so a human
// reading component-map.yaml can map fields 1:1 onto these types.

export interface ComponentMapValueEntry {
  figmaValue?: string | null;
  composeValue?: string | boolean;
  status?: "mapped" | "unmapped";
  reason?: string;
  notes?: string;
}

export interface ComponentMapVariantGroup {
  figmaProperty: string;
  composeProperty?: string;
  composeEnum?: string;
  status?: "unmapped";
  reason?: string;
  mappingRule?: string;
  notes?: string;
  values?: ComponentMapValueEntry[];
  figmaValues?: string[];
}

export interface ComponentMapRoutingRule {
  when: { figmaProperty: string; figmaValue: string };
  redirectTo: string;
  note?: string;
}

export interface ComponentMapStateMapping {
  figmaProperty: string;
  composeProperty: string;
  composeType?: string;
  values: { figmaValue: string; composeValue: boolean | string }[];
}

export interface ComponentMapEntry {
  figmaComponentSet: string;
  figmaNodeId: string | null;
  status: "mapped" | "unmapped";
  mappingKind?: string;
  compose: { component: string; package: string } | null;
  routing?: ComponentMapRoutingRule[];
  variants?: ComponentMapVariantGroup[];
  stateMapping?: ComponentMapStateMapping[];
  reason?: string;
  notes?: string;
}

export interface ComponentMap {
  version: number;
  figma: { fileKey: string; fileName: string };
  entries: ComponentMapEntry[];
}

/**
 * One declarative Figma-token -> Kotlin-symbol wiring rule, parsed from
 * `wiring-rules/wiring-rules.yaml`. Rules are evaluated in file order and
 * the first whose `match` applies wins, so a rule with no constraints at
 * all (`match: {}`) acts as the terminal catch-all.
 */
export interface WiringRule {
  id: string;
  status: "mapped" | "unmapped";
  description?: string;
  /** An absent/empty `match` matches every token — the catch-all. */
  match?: { collection?: string; pathPrefix?: string };
  /** Present only on `status: mapped` rules. */
  symbol?: {
    /** Kotlin accessor root, e.g. `AppTheme.semanticColors`. */
    prefix: string;
    /** How many leading Figma path segments to drop before camelCasing the rest. */
    dropSegments?: number;
  };
  /** Required on `status: unmapped` rules: why there is deliberately no symbol. */
  reason?: string;
  /** Why a `mapped` rule is believed correct — the source that was actually read. */
  evidence?: string;
}

export interface WiringRules {
  version: number;
  rules: WiringRule[];
}

/**
 * The outcome of resolving one qualified token to a Kotlin symbol. Always
 * returned (never `undefined`), so "no symbol" is an explained outcome
 * rather than an absence. `from` is the id of the rule that decided, or
 * `null` when no rule matched at all.
 */
export interface SymbolResolution {
  symbol: string | null;
  from: string | null;
  /** Present only when `symbol` is null. */
  reason?: string;
}

/**
 * The parsed `collections-policy.yaml`. Key names deliberately mirror the
 * platform generator's `configs/collections.toml` (kebab-case, same field
 * names) so the two configs read identically side by side.
 */
export interface CollectionsPolicy {
  version: number;
  /** Collection name patterns to exclude (case-insensitive shell globs). */
  exclude?: string[];
  /** Branch patterns: `<collection>/<branch>` when the pattern contains a slash, else any collection. */
  "exclude-branches"?: string[];
  /** Whether to drop collections imported from other Figma libraries. Defaults to true. */
  "exclude-remote-collections"?: boolean;
}

/** Why (or whether) the policy excluded one collection or branch. */
export interface PolicyDecision {
  excluded: boolean;
  /** The pattern (or pseudo-pattern) responsible, when excluded. */
  by?: string;
  reason?: string;
}

/** The `policy` block echoed into an exported token document. */
export interface PolicyReportShape {
  excludedCollections: string[];
  excludedBranches: string[];
  excludeRemoteCollections: boolean;
  unmatchedPatterns: string[];
}

/**
 * A stateful policy evaluator. Stateful because it tracks which patterns
 * actually matched something, so `unmatchedPatterns()` can surface the ones
 * that did not — a pattern matching nothing looks like a working exclusion
 * and behaves like a typo.
 */
export interface PolicyEvaluator {
  excludeRemoteCollections: boolean;
  collection(name: string, remote: boolean): PolicyDecision;
  branch(collection: string, path: string): PolicyDecision;
  unmatchedPatterns(): string[];
  report(unmatched: string[]): PolicyReportShape;
}
