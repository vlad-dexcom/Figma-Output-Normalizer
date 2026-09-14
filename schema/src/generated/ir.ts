/**
 * This file was automatically generated from schema/ir/v1/schema.json.
 * DO NOT EDIT MANUALLY — run `npm run generate:types` in schema/ to
 * regenerate it, then commit the result.
 */

/**
 * The discriminated union of every IR node kind. `kind` selects the variant.
 */
export type IRNode = LayoutNode | TextNode | InstanceNode | AssetNode | OverlayNode | ListNode;
export type LayoutDirection = "row" | "column" | "stack";
export type NullableTokenValue = TokenValue | null;
export type MainAxisAlign = "start" | "center" | "end" | "spaceBetween";
export type CrossAxisAlign = "start" | "center" | "end" | "stretch";
export type SizingMode = "fixed" | "fill" | "hug";
export type NullableTokenRef = TokenRef | null;
/**
 * The resolved value of a single Figma component property, used in instance node `props`.
 */
export type PropValue = TextOrBooleanPropValue | VariantPropValue;

/**
 * An Auto Layout container resolved to intent (direction/alignment/sizing), not raw Figma enums.
 */
export interface LayoutNode {
  kind: "layout";
  direction: LayoutDirection;
  gap: NullableTokenValue;
  padding: Padding;
  mainAxisAlign: MainAxisAlign;
  crossAxisAlign: CrossAxisAlign;
  sizing: Sizing;
  background: NullableTokenValue;
  cornerRadius: NullableTokenValue;
  /**
   * Present only when the node reports at least one visible stroke; `null` otherwise. See docs/BACKLOG.md B5.
   */
  border?: Border | null;
  /**
   * DROP_SHADOW/INNER_SHADOW effects, resolved in order. LAYER_BLUR/BACKGROUND_BLUR are not modeled and instead produce an UnresolvedEntry with reason "unsupported-effect" (see docs/BACKLOG.md B5); omitted (not an empty array) when the node has no modeled effects.
   */
  effects?: ShadowEffect[];
  /**
   * Node opacity, 0-1. Omitted when 1 (fully opaque, the default) to avoid noise on the overwhelming majority of nodes.
   */
  opacity?: number;
  children: IRNode[];
  source: Provenance;
}
/**
 * A resolved Figma variable/style reference plus its concrete value(s). The optional `symbol` field is reserved for a later stage that will map `token` to a generated design-system symbol name (e.g. "AppTheme.semanticColors.text.base.default"); it is optional and unpopulated in v1 so that adding it later is additive, not a breaking change.
 */
export interface TokenValue {
  /**
   * The raw Figma variable/style path, e.g. "color/text/base/default". `null` means this value is a raw literal with no bound Figma variable; extractors MUST also push an UnresolvedEntry with reason "unbound-literal" alongside a null token rather than inventing a path.
   */
  token: string | null;
  /**
   * The concrete resolved value for the mode active at extraction time.
   */
  value: string | number;
  /**
   * Present only when the value is theme-dependent. Maps mode name (e.g. "light", "dark") to the resolved value in that mode.
   */
  modes?: {
    [k: string]: string | number;
  };
  /**
   * Reserved for a later stage: the generated design-system symbol name for this token. Optional and unused in v1 (forward-compat placeholder, see schema description).
   */
  symbol?: string;
}
/**
 * Per-side padding. Any side may be omitted (no padding on that side). `all` may be present instead of/alongside explicit sides as a convenience shorthand from the extractor; consumers should treat explicit sides as overriding `all`.
 */
export interface Padding {
  top?: TokenValue;
  right?: TokenValue;
  bottom?: TokenValue;
  left?: TokenValue;
  all?: TokenValue;
}
export interface Sizing {
  width: SizingMode;
  height: SizingMode;
  dimensions?: SizeDimensions;
}
/**
 * Numeric px dimensions for this node's own bounding box, read directly off Figma's node.width/node.height. Always populated when the node reports a size (independent of width/height mode) so a codegen consumer isn't stuck with an unusable "fixed" mode and no value to size a "fixed" axis with; for "fill"/"hug" axes the value is still the node's current rendered size, useful as a hint but not authoritative (the real size there is computed by the layout engine, not fixed).
 */
export interface SizeDimensions {
  width?: number;
  height?: number;
}
/**
 * A resolved stroke (border): color + weight tokens plus the raw Figma alignment.
 */
export interface Border {
  color: NullableTokenValue;
  width: NullableTokenValue;
  align: "inside" | "outside" | "center";
}
/**
 * A single resolved DROP_SHADOW/INNER_SHADOW effect. Offset/blur/spread are raw px numbers (Figma effects have no bindable-variable concept for these sub-fields, unlike fills/strokes/spacing), color is resolved the same way as a fill/stroke color.
 */
export interface ShadowEffect {
  type: "dropShadow" | "innerShadow";
  color: NullableTokenValue;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}
/**
 * Origin metadata for a node, used to diff IR across re-exports of the same Figma file.
 */
export interface Provenance {
  /**
   * The Figma node id this IR node was derived from.
   */
  nodeId: string;
  /**
   * The Figma file key the node lives in.
   */
  fileKey: string;
  /**
   * A version identifier for this extraction. The Figma Plugin API exposes no per-node revision counter, so producers typically derive this as a deterministic content hash of the extracted IR rather than a true Figma-side version (see the plugin's ir-export task / plugin/README.md 'Export versioning' section for the full rationale and limitations). Consumers should treat it as an opaque, comparable-for-equality identifier, not a parseable/ordered version number.
   */
  version: string;
  /**
   * Stable chain of node names from the nearest meaningful root down to and including this node's own name, used for diffing across re-exports (e.g. ["Screen", "Footer", "Buttons"] for a node named "Buttons" nested under "Screen" > "Footer").
   */
  path: string[];
}
/**
 * A text layer. `text` is a plain string for uniformly-styled text, or an array of StyledSegment when getStyledTextSegments reports mixed-style runs.
 */
export interface TextNode {
  kind: "text";
  text: string | StyledSegment[];
  typography: NullableTokenRef;
  color: NullableTokenValue;
  source: Provenance;
}
/**
 * One run of text from Figma's getStyledTextSegments, sharing a single typography/color style.
 */
export interface StyledSegment {
  text: string;
  typography?: TokenRef;
  color?: TokenValue;
}
/**
 * Same shape as TokenValue but for typography tokens, which have no single resolved numeric/string value. The optional `symbol` field carries the same forward-compat intent as TokenValue.symbol.
 */
export interface TokenRef {
  /**
   * The raw Figma typography style path, e.g. "typography/body/large". `null` means this text has no bound typography style/variable (a raw literal font); extractors MUST also push an UnresolvedEntry with reason "unbound-literal" alongside a null token rather than inventing a path.
   */
  token: string | null;
  /**
   * Reserved for a later stage: the generated design-system symbol name for this token. Optional and unused in v1.
   */
  symbol?: string;
  literal?: TypographyLiteral;
}
/**
 * Populated only when `token` is null: the raw font values read directly off the text segment (getStyledTextSegments), so a codegen consumer can still render the text instead of losing the style entirely. Never populated alongside a non-null `token` (the token path is the source of truth there).
 */
export interface TypographyLiteral {
  fontFamily?: string;
  /**
   * Figma's fontName.style, e.g. "Regular", "Bold", "Semi Bold Italic".
   */
  fontStyle?: string;
  fontSize?: number;
  fontWeight?: number;
  /**
   * Either a concrete value+unit pair, or the literal string "AUTO" when Figma computes line height automatically from the font.
   */
  lineHeight?:
    | {
        value: number;
        unit: "PIXELS" | "PERCENT";
      }
    | "AUTO";
  letterSpacing?: {
    value: number;
    unit: "PIXELS" | "PERCENT";
  };
}
/**
 * A component instance. Opaque past this boundary: the instance's internal children are NEVER included, only its resolved properties, named slot content, and call-site layout.
 */
export interface InstanceNode {
  kind: "instance";
  /**
   * The mapped design-system component name (e.g. "AppButton"), or null if this component set has no mapping yet.
   */
  component: string | null;
  figmaComponentSetName: string;
  figmaComponentKey: string;
  /**
   * Resolved component properties keyed by Figma property name.
   */
  props: {
    [k: string]: PropValue;
  };
  /**
   * Named slot content for INSTANCE_SWAP or boolean-gated optional children (e.g. leadingIcon/trailingIcon). A null value means the slot exists but is empty/hidden.
   */
  slots: {
    [k: string]: IRNode | null;
  };
  layout: LayoutFieldsPartial;
  unresolved: UnresolvedEntry[];
  source: Provenance;
}
/**
 * For TEXT and BOOLEAN component properties.
 */
export interface TextOrBooleanPropValue {
  value: string | number | boolean;
}
/**
 * For VARIANT component properties. `from` is the raw Figma variant property value (e.g. "Style=Primary") kept for traceability back to the source. `variant` is `null` when the component-map has no Compose equivalent for this specific Figma variant value (component-map.yaml status: unmapped) — extractors MUST also push an UnresolvedEntry with reason "unmapped-variant" alongside a null variant rather than guessing.
 */
export interface VariantPropValue {
  variant: string | null;
  from: string;
}
/**
 * The subset of layout node fields relevant to an instance's call-site layout (sizing, spacing, etc as needed) — NOT the internal styling of the component. Every field is optional; only fields actually relevant at the call site are present.
 */
export interface LayoutFieldsPartial {
  direction?: LayoutDirection;
  gap?: NullableTokenValue;
  padding?: Padding;
  mainAxisAlign?: MainAxisAlign;
  crossAxisAlign?: CrossAxisAlign;
  sizing?: SizingPartial;
  background?: NullableTokenValue;
  cornerRadius?: NullableTokenValue;
}
/**
 * Like Sizing, but either axis may be omitted when only one axis is relevant at a call site (e.g. an instance's layout override).
 */
export interface SizingPartial {
  width?: SizingMode;
  height?: SizingMode;
  dimensions?: SizeDimensions1;
}
export interface SizeDimensions1 {
  width?: number;
  height?: number;
}
/**
 * Records a value that could not be resolved during extraction (a missing token, an unmapped component variant/property, etc). Every unresolvable value MUST produce one of these rather than a silent substitution or omission.
 */
export interface UnresolvedEntry {
  /**
   * The Figma node id where the unresolved value was encountered.
   */
  nodeId: string;
  /**
   * A short, stable machine-readable reason code/summary, e.g. "missing-variable-binding" or "unmapped-variant".
   */
  reason: string;
  /**
   * Optional free-form human-readable detail for debugging.
   */
  detail?: string;
  /**
   * How much this entry should stand out to a human reviewing the warnings list (backlog Q9: a flat list of hundreds of entries buries real problems in routine noise). Assigned centrally from `reason` by `plugin/src/extractor/severity.ts` at the end of extraction (extractors themselves never set this), not authored per call site, so the mapping stays in one place. "error": the exported value is actually missing/wrong for a design-system-mapped concept (e.g. "unmapped-component", "unresolvable-alias-chain"). "warning": a literal was used instead of a token — usually fine, but worth eventually binding a variable (e.g. "unbound-literal", "unsupported-paint"). "info": expected/structural, not actionable (e.g. "absolute-positioning"). Optional for backward compatibility with older `*.ir.json` artifacts that predate this field; absence does not imply any particular severity.
   */
  severity?: "error" | "warning" | "info";
}
/**
 * A vector or image, represented as an export reference — never inline geometry/path data.
 */
export interface AssetNode {
  kind: "asset";
  assetType: "icon" | "image" | "illustration";
  /**
   * Suggested filename/drawable name, deterministic from the node name.
   */
  exportRef: string;
  /**
   * Logical width; no path data.
   */
  width: number;
  /**
   * Logical height; no path data.
   */
  height: number;
  source: Provenance;
}
/**
 * Absolutely positioned children inside an otherwise auto-layout parent.
 */
export interface OverlayNode {
  kind: "overlay";
  children: {
    node: IRNode;
    align: {
      horizontal: "start" | "center" | "end";
      vertical: "start" | "center" | "end";
    };
    offset?: {
      x: number;
      y: number;
    };
  }[];
  source: Provenance;
}
/**
 * N identical/near-identical siblings collapsed to one template.
 */
export interface ListNode {
  kind: "list";
  itemTemplate: IRNode;
  /**
   * Count observed in the design; informational only, not a rendering directive.
   */
  itemCount: number;
  source: Provenance;
}

/**
 * The top-level export envelope written to a `*.ir.json` file / posted from the plugin sandbox / copied to the clipboard: `{ schemaVersion, nodes, unresolved, version }`. `irNode` (above) only describes one node in `nodes[]`, not this envelope — validate a whole exported artifact against `irDocument`, not `irNode`, to catch envelope-shape drift (e.g. a missing `schemaVersion`).
 */
export interface IRDocument {
  /**
   * The IR schema version this document conforms to (the `v1` path segment in this schema's `$id`). Present in every exported artifact so a future v2 consumer/tool can tell old and new exports apart without guessing from shape alone.
   */
  schemaVersion: 1;
  /**
   * The extracted root IR nodes, one per top-level selected Figma layer.
   */
  nodes: IRNode[];
  /**
   * Every UnresolvedEntry produced anywhere in the extraction, flattened into one list.
   */
  unresolved: UnresolvedEntry[];
  /**
   * The `Provenance.version` shared by every node in `nodes` for this export (see `provenance.version` below).
   */
  version: string;
}
