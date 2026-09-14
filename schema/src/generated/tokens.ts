/**
 * This file was automatically generated from schema/tokens/v1/schema.json.
 * DO NOT EDIT MANUALLY — run `npm run generate:types` in schema/ to
 * regenerate it, then commit the result.
 */

export interface TokenDocument {
  envelope: TokenDocumentEnvelope;
  policy: PolicyReport;
  /**
   * Every collection that survived the policy filter, in Figma's own declared order. A collection with zero variables is emitted as an empty `tokens` array rather than omitted, so 'this collection is empty' stays distinguishable from 'this collection disappeared'.
   */
  collections: TokenCollection[];
  /**
   * Every variable that could not be fully represented, with a machine-readable reason. Producers MUST emit an entry here for any input variable not present in `collections` - a variable must never be silently dropped.
   */
  unresolved: UnresolvedToken[];
}
/**
 * Document-level provenance. Deliberately carries no timestamp: an export of unchanged content must be byte-identical to the previous one, which a wall-clock field would break.
 */
export interface TokenDocumentEnvelope {
  /**
   * The token schema major version this document conforms to (currently 1).
   */
  schemaVersion: 1;
  /**
   * Discriminates this document from the node IR when both are handled by one consumer.
   */
  kind: "tokens";
  /**
   * The Figma file key these tokens came from.
   */
  fileKey: string;
  /**
   * A deterministic content hash of this document's own payload (see the plugin's versioning.ts). Opaque and comparable for equality only - not parseable or ordered. Equal versions mean identical content; a changed version means something a consumer can see actually changed.
   */
  version: string;
}
/**
 * The exclusion policy that was actually applied, echoed into the document so an export is self-describing and a stale or mistyped pattern is visible in the artifact itself rather than only in the build log.
 */
export interface PolicyReport {
  /**
   * Collection name patterns that were excluded (shell-style globs, matched case-insensitively).
   */
  excludedCollections: string[];
  /**
   * Branch patterns that were excluded. A pattern containing `/` matches `<collection>/<branch>`; a bare pattern matches that branch in every collection.
   */
  excludedBranches: string[];
  /**
   * Whether collections imported from other Figma libraries were excluded. Defaults to true: a real file's remote collections are overwhelmingly unrelated library noise, and their names collide with each other and with local collections.
   */
  excludeRemoteCollections?: boolean;
  /**
   * Patterns that matched nothing. Reported rather than silently ignored, so a typo never turns into a silent no-op.
   */
  unmatchedPatterns: string[];
}
export interface TokenCollection {
  /**
   * The collection's Figma name, e.g. "base".
   */
  name: string;
  /**
   * The Figma variable collection id. Carried once per collection rather than repeated on every token, and needed because collection *names* are not unique across imported libraries.
   */
  id: string;
  /**
   * True when this collection is imported from another Figma library rather than defined locally.
   */
  remote: boolean;
  /**
   * Figma's `hiddenFromPublishing` for the collection.
   */
  hidden?: boolean;
  /**
   * The name of the collection's default mode. Preserved because it encodes designer intent (which mode a single-value consumer should read) and is not recoverable from an alphabetically sorted mode list.
   */
  defaultMode: string | null;
  /**
   * Mode names in Figma's own declared order - NOT sorted. Order is meaningful content here, and sorting it destroys the default/primary-mode signal.
   */
  modes: string[];
  /**
   * The distinct first path segments present in this collection's tokens (e.g. ["color", "radius", "scale"]), in first-seen order. Observed structure, not a codegen decision - a generator may use it to shape classes, or ignore it.
   */
  branches: string[];
  /**
   * Names of other collections this collection's tokens alias into, sorted for determinism. The observed alias-edge summary a build-order/graph step can be derived from, without this document itself modelling build order.
   */
  dependsOn: string[];
  tokens: Token[];
}
export interface Token {
  /**
   * The raw Figma variable name, slash-separated, verbatim and unsanitized (e.g. "color/surface/action/primary/default"). Identical to the node IR's `TokenValue.token` for the same variable. NOT unique on its own - see the owning collection.
   */
  path: string;
  /**
   * Figma's resolvedType for this variable.
   */
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  /**
   * The resolved literal for the collection's DEFAULT mode. Colors are `#RRGGBB` or `#RRGGBBAA` hex - the same representation the node IR uses, so the two documents' values for one variable are the same string. `null` means unresolvable in the default mode; the token then also appears in `unresolved`.
   */
  value: string | number | boolean | null;
  /**
   * Resolved literal per mode name, for every mode the owning collection declares. Always present (even for a single-mode collection) so consumers never have to special-case it.
   */
  modes: {
    [k: string]: string | number | boolean | null;
  };
  alias?: AliasEdges;
  /**
   * Figma's variable scopes (e.g. ["CORNER_RADIUS"], ["GAP"], ["TEXT_FILL"]). This is how a consumer knows a FLOAT is a radius and not a gap - the intent signal that a bare number loses.
   */
  scopes?: string[];
  /**
   * The variable's Figma description, verbatim.
   */
  description?: string;
  /**
   * Figma's `hiddenFromPublishing`.
   */
  hidden?: boolean;
  /**
   * Figma's `deletedButReferenced`: the variable is deleted but something still points at it. Emitted (flagged) rather than dropped, so a consumer can decide.
   */
  deleted?: boolean;
  /**
   * The Kotlin design-system symbol, derived by evaluating mappings/wiring-rules/wiring-rules.yaml against (collection, path). Omitted when no rule confidently derives one - the normal case, and not an error.
   */
  symbol?: string;
  /**
   * The id of the wiring rule that produced `symbol`, so any emitted symbol can be traced to the rule and evidence behind it.
   */
  symbolFrom?: string;
  hints?: TokenHints;
}
/**
 * Where this token's value comes from, when it aliases another variable. The alias EDGE is the fact; a resolved literal is only a view of it. Leaf collections routinely have a single mode while aliasing into a multi-mode collection, so a flattened value silently collapses light/dark - preserving the edge is what lets a consumer expand modes correctly instead of reconstructing the graph from values.
 */
export interface AliasEdges {
  /**
   * Mode name -> the variable this token aliases in that mode. A mode with a literal (non-alias) value is absent.
   */
  byMode: {
    [k: string]: AliasTarget;
  };
}
export interface AliasTarget {
  /**
   * Name of the collection the aliased variable belongs to, or null when it could not be read.
   */
  collection: string | null;
  /**
   * The aliased variable's raw Figma name, or null when the target could not be resolved.
   */
  path: string | null;
  /**
   * True when the alias points into a collection the policy excluded. The value then falls back to the resolved literal so generated code never references something that was not emitted - the documented behaviour this mirrors from the platform's collections.toml.
   */
  excluded?: boolean;
}
/**
 * Non-authoritative signals carried for humans and coding agents. Nothing in the pipeline may RESOLVE against these - they are labelled as hints precisely so that a consumer cannot mistake them for a contract.
 */
export interface TokenHints {
  /**
   * Figma's per-platform `codeSyntax` for this variable (WEB/ANDROID/iOS). Useful as a naming hint when generating code, but deliberately NOT used to derive `symbol`: the platform is moving to a Styles API that will supply the real symbols, at which point these names could diverge.
   */
  codeSyntax?: {
    [k: string]: string;
  };
}
/**
 * Records a variable that could not be fully represented. Mirrors the node IR's UnresolvedEntry convention: every unresolvable value MUST produce one of these rather than a silent substitution or omission.
 */
export interface UnresolvedToken {
  collection: string | null;
  path: string;
  /**
   * Stable machine-readable reason code. `missing-alias-target`: the aliased variable could not be read at all. `unresolvable-alias-chain`: circular or deeper than the hop limit. `excluded-collection-alias`: resolved, but through a collection the policy excluded (value falls back to the literal). `excluded-by-policy`: the variable itself was excluded. `unsupported-value`: a value shape this schema cannot represent.
   */
  reason:
    | "missing-alias-target"
    | "unresolvable-alias-chain"
    | "excluded-collection-alias"
    | "excluded-by-policy"
    | "unsupported-value";
  /**
   * Human-readable detail for debugging.
   */
  detail?: string;
}
