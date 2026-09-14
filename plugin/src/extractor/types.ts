// Internal "duck-typed" view of the Figma plugin-sandbox node/API surface
// that the extractor actually reads. Kept deliberately narrower than the
// full `@figma/plugin-typings` union (which models dozens of node-specific
// mixins) so that:
//
//   1. Test fixtures can be built as plain object literals (see
//      `../test/nodeBuilders.ts`) without satisfying every required field
//      of the real Figma API types.
//   2. The extractor's own logic stays readable — it only names the fields
//      it actually inspects.
//
// `code.ts` casts the real `figma.currentPage.selection` (real `SceneNode[]`)
// to `FigmaNode[]` at the single point where the plugin sandbox API meets
// this module; real Figma nodes are a structural superset of `FigmaNode`, so
// that cast is safe in practice (real nodes have every field below, plus
// many more we don't read).
import type { CollectionsPolicy } from "@figma-normalizator/mappings";

/** A Figma variable/style binding, as found in `boundVariables`. */
export interface VariableAliasBinding {
  type: "VARIABLE_ALIAS";
  id: string;
}

/** Subset of Figma's `Variable` this extractor reads. */
export interface FigmaVariable {
  name: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  /** Present on real Figma variables; read by the token export, not by node extraction. */
  id?: string;
  resolvedType?: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  description?: string;
  scopes?: readonly string[];
  codeSyntax?: Record<string, string>;
  hiddenFromPublishing?: boolean;
  /** Figma sets this on a deleted variable that something still references. */
  deletedButReferenced?: boolean;
  remote?: boolean;
}

/** Subset of Figma's `VariableCollection` this extractor reads. */
export interface FigmaVariableCollection {
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
  /**
   * The collection's name. Part of a token's *identity* (see
   * `resolveVariable`), not decoration: sibling collections routinely
   * define the same variable path with different values.
   */
  name?: string;
  id?: string;
  remote?: boolean;
  hiddenFromPublishing?: boolean;
  variableIds?: readonly string[];
}

/** Subset of the Figma plugin `variables` API this extractor reads. */
export interface FigmaVariablesAPI {
  getVariableByIdAsync(id: string): Promise<FigmaVariable | null>;
  getVariableCollectionByIdAsync(id: string): Promise<FigmaVariableCollection | null>;
  /** Used only by the token export (`tokenExport.ts`), not by node extraction. */
  getLocalVariableCollectionsAsync?(): Promise<FigmaVariableCollection[]>;
}

/** A resolved Figma text-style/typography style, read off a bound style id. */
export interface FigmaTextStyle {
  name: string;
}

/** Subset of a Figma `Paint` (fill/stroke) this extractor reads. */
export interface FigmaPaint {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
}

/** Subset of a component property definition value on an instance. */
export interface FigmaComponentPropertyValue {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
  value: string | number | boolean;
}

/** Subset of one segment from `TextNode.getStyledTextSegments`. */
export interface FigmaStyledTextSegment {
  characters: string;
  fontSize: number;
  fontName: { family: string; style: string };
  fills: FigmaPaint[];
  boundVariables?: Record<string, VariableAliasBinding | VariableAliasBinding[] | undefined>;
}

/**
 * The duck-typed node shape the extractor operates on. Every field is
 * optional except `id`/`name`/`type` since which fields are meaningful
 * depends on `type` (mirrors how Figma's own node mixins work).
 */
export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;

  readonly visible?: boolean;
  readonly children?: readonly FigmaNode[];

  // Geometry (used for asset bounds + overlay alignment heuristics).
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;

  // Auto Layout (frame/component/instance level).
  readonly layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  readonly primaryAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN";
  readonly counterAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "BASELINE";
  readonly primaryAxisSizingMode?: "FIXED" | "AUTO";
  readonly counterAxisSizingMode?: "FIXED" | "AUTO";
  readonly itemSpacing?: number;
  readonly paddingLeft?: number;
  readonly paddingRight?: number;
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  // `CornerMixin.cornerRadius` in the real Plugin API: `number |
  // PluginAPI["mixed"]` — a rectangle/frame with independent per-corner
  // radii (top-left/top-right/bottom-left/bottom-right differ) returns the
  // `figma.mixed` sentinel (a `Symbol`) instead of a plain number. See
  // `./mixed.ts`'s `isMixed` guard, used at every read site.
  readonly cornerRadius?: number | symbol;

  // Auto Layout (child level — how this node participates in its parent).
  readonly layoutGrow?: number;
  readonly layoutAlign?: "MIN" | "CENTER" | "MAX" | "STRETCH" | "INHERIT";
  readonly layoutPositioning?: "AUTO" | "ABSOLUTE";

  // Fills/strokes (color resolution). `MinimalFillsMixin.fills` in the real
  // Plugin API is `ReadonlyArray<Paint> | PluginAPI["mixed"]` — a node with
  // multiple sets of fills (e.g. per-character text fills observed at the
  // node level rather than per-segment) returns the `figma.mixed` sentinel
  // (a `Symbol`) instead of an array. Guarded via `isMixed` in
  // `resolveFillColor` (tokens.ts), the single choke point every raw
  // `fills` read goes through.
  readonly fills?: readonly FigmaPaint[] | symbol;

  // Bound variables (token resolution). See VariableBindableNodeField.
  readonly boundVariables?: Record<
    string,
    VariableAliasBinding | VariableAliasBinding[] | undefined
  >;

  // Text.
  readonly characters?: string;
  getStyledTextSegments?(fields: string[]): FigmaStyledTextSegment[];

  // Instances.
  readonly key?: string;
  readonly componentProperties?: Record<string, FigmaComponentPropertyValue>;
  getMainComponentAsync?(): Promise<FigmaNode | null>;
  readonly parent?: FigmaNode | null;

  // Dev Mode / plugin data (deferred — see extractor/index.ts).
  getPluginData?(key: string): string;
  readonly annotations?: readonly unknown[];
}

/** Everything the extractor needs from the ambient `figma` global. */
export interface FigmaAPI {
  variables: FigmaVariablesAPI;
}

/** Deterministic extraction inputs that don't come off the node tree itself. */
export interface ExtractionSource {
  fileKey: string;
  /**
   * Optional literal override for `Provenance.version`. Production callers
   * (`code.ts`) omit this: `extractSelection` then derives a deterministic
   * content-hash version from the extracted IR itself (see
   * `./versioning.ts`) and returns it as `ExtractionResult.version`. Tests
   * that want a fixed, human-readable version string (e.g. fixture
   * snapshots) may still pass one explicitly, which is used verbatim.
   */
  version?: string;
}

/** Everything the token export needs from the ambient `figma` global. */
export interface TokenExportFigmaAPI {
  variables: FigmaVariablesAPI;
}

/** Deterministic token-export inputs that don't come off the variables API itself. */
export interface TokenExportSource {
  fileKey: string;
  /**
   * Optional literal override for `TokenDocument.envelope.version`.
   * Production callers omit it: `extractTokens` then derives a
   * deterministic content hash from the document itself. Tests that want a
   * fixed, human-readable version may pass one, which is used verbatim.
   */
  version?: string;
  /**
   * Optional policy override. Omitted in production, where the bundled
   * `collections-policy.yaml` is used; tests pass one to exercise a
   * specific exclusion without editing the checked-in config.
   */
  policy?: CollectionsPolicy;
  /** Optional override for the variable budget (see budget.ts). */
  variableBudget?: number;
}
