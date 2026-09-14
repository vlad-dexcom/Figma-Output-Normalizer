// Extractor orchestration: recursively walks a Figma node tree (starting
// from the current selection) and produces IR nodes conforming to
// schema/ir/v1/schema.json. Ties together layout normalization, text
// extraction, token resolution, instance resolution, list collapsing,
// asset detection, and overlay grouping (concerns #1-#7 in the
// plugin-extractor task description).
//
// Deferred (see PR description): Dev Mode annotations / `getPluginData`
// hints (concern #8) — the current IR schema has no channel for "inferred
// hint, never authoritative" metadata, and inventing one wasn't in scope
// for this task.
import type {
  IRNode,
  LayoutNode,
  Padding,
  TokenValue,
  UnresolvedEntry,
} from "@figma-normalizator/schema";
import { IR_SCHEMA_VERSION } from "@figma-normalizator/schema";
import { DEFAULT_NODE_BUDGET, NodeBudget } from "./budget.js";
import { isAssetNode, buildAssetNode } from "./asset.js";
import { buildInstanceNode } from "./instance.js";
import { buildTextNode } from "./text.js";
import {
  resolveCrossAxisAlign,
  resolveDirection,
  resolveMainAxisAlign,
  resolveSizing,
  buildPaddingRaw,
  isUniformPadding,
} from "./layout.js";
import { resolveFillColor, resolveTokenValue, mixedValueResult } from "./tokens.js";
import { resolveBorder, resolveEffects, resolveOpacity } from "./effects.js";
import { buildProvenance, withDescendant, type ProvenanceContext } from "./provenance.js";
import { collapseLists, type OrderedChild } from "./list.js";
import { groupOverlayChildren } from "./overlay.js";
import { computeContentVersion, withVersion } from "./versioning.js";
import { isMixed } from "./mixed.js";
import { createCachingVariablesAPI } from "./variableCache.js";
import { withSeverity } from "./severity.js";
import type { ExtractionSource, FigmaAPI, FigmaNode } from "./types.js";

export { DEFAULT_NODE_BUDGET, NodeBudgetExceededError } from "./budget.js";
export type { FigmaAPI, FigmaNode, ExtractionSource } from "./types.js";
export { canonicalize, canonicalStringify } from "./canonical.js";
export { computeContentVersion } from "./versioning.js";

export interface ExtractionResult {
  /**
   * The IR schema version this document conforms to (schema/ir/v1/schema.json
   * `$defs.irDocument.schemaVersion`, backlog G6/G7). Present so a consumer
   * of an exported `*.ir.json` can tell which schema version produced it,
   * instead of guessing from shape — previously absent from every exported
   * artifact entirely.
   */
  schemaVersion: typeof IR_SCHEMA_VERSION;
  nodes: IRNode[];
  /**
   * Every UnresolvedEntry produced anywhere in the tree, flattened. Instance
   * nodes also carry their own subset locally (`InstanceNode.unresolved`,
   * required by the schema); this is the convenient "everything, in one
   * place" view for layout/text/asset-adjacent issues that the current
   * schema has no dedicated per-node channel for.
   */
  unresolved: UnresolvedEntry[];
  /**
   * The `Provenance.version` shared by every node in `nodes` (either the
   * caller's explicit `ExtractionSource.version` override, or — the normal
   * production path — a content-hash derived from this exact IR; see
   * `./versioning.ts`). Exposed here too since callers (e.g. `code.ts`)
   * also need it to name the exported file/`ExportSource.version` without
   * digging into `nodes[0].source`.
   */
  version: string;
}

/** Placeholder used while building the tree, before the real content-hash version is known (see the end of `extractSelection`). */
const PENDING_VERSION = "";

interface NodeResult {
  ir: IRNode | null;
  unresolved: UnresolvedEntry[];
}

const CONTAINER_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "GROUP",
  "BOOLEAN_OPERATION",
  "SECTION",
]);

function hasAutoLayout(node: FigmaNode): boolean {
  return node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
}

async function resolvePadding(
  figma: FigmaAPI,
  node: FigmaNode,
): Promise<{ padding: Padding; unresolved: UnresolvedEntry[] }> {
  if (!hasAutoLayout(node)) return { padding: {}, unresolved: [] };

  const raw = buildPaddingRaw(node);
  const unresolved: UnresolvedEntry[] = [];

  if (isUniformPadding(raw)) {
    const all = await resolveTokenValue(
      figma,
      node.id,
      node.boundVariables,
      "paddingLeft",
      raw.left,
    );
    unresolved.push(...all.unresolved);
    return { padding: { all: all.token }, unresolved };
  }

  const [top, right, bottom, left] = await Promise.all([
    resolveTokenValue(figma, node.id, node.boundVariables, "paddingTop", raw.top),
    resolveTokenValue(figma, node.id, node.boundVariables, "paddingRight", raw.right),
    resolveTokenValue(figma, node.id, node.boundVariables, "paddingBottom", raw.bottom),
    resolveTokenValue(figma, node.id, node.boundVariables, "paddingLeft", raw.left),
  ]);
  unresolved.push(...top.unresolved, ...right.unresolved, ...bottom.unresolved, ...left.unresolved);

  return {
    padding: { top: top.token, right: right.token, bottom: bottom.token, left: left.token },
    unresolved,
  };
}

async function buildLayoutNode(
  figma: FigmaAPI,
  node: FigmaNode,
  parent: FigmaNode | undefined,
  ctx: ProvenanceContext,
  budget: NodeBudget,
  source: ExtractionSource,
): Promise<NodeResult> {
  const unresolved: UnresolvedEntry[] = [];
  const autoLayout = hasAutoLayout(node);

  const direction = resolveDirection(node);
  const mainAxisAlign = autoLayout ? resolveMainAxisAlign(node) : "start";
  const crossAxisAlign = autoLayout ? resolveCrossAxisAlign(node) : "start";

  const gap = autoLayout
    ? await resolveTokenValue(
        figma,
        node.id,
        node.boundVariables,
        "itemSpacing",
        node.itemSpacing ?? 0,
      )
    : { token: null, unresolved: [] as UnresolvedEntry[] };
  unresolved.push(...gap.unresolved);

  const { padding, unresolved: paddingUnresolved } = await resolvePadding(figma, node);
  unresolved.push(...paddingUnresolved);

  const background = await resolveFillColor(figma, node.id, node.fills, node.boundVariables);
  unresolved.push(...background.unresolved);

  const cornerRadius = isMixed(node.cornerRadius)
    ? mixedValueResult<TokenValue>(
        node.id,
        "This node has independent per-corner radii (top-left/top-right/bottom-left/bottom-right differ) and cannot be represented as a single token; consider using a uniform radius or documenting the intended per-corner values separately.",
      )
    : node.cornerRadius !== undefined
      ? await resolveTokenValue(
          figma,
          node.id,
          node.boundVariables,
          "cornerRadius",
          node.cornerRadius,
        )
      : { token: null, unresolved: [] as UnresolvedEntry[] };
  unresolved.push(...cornerRadius.unresolved);

  const sizing = resolveSizing(node, parent);

  const { border, unresolved: borderUnresolved } = await resolveBorder(figma, node);
  unresolved.push(...borderUnresolved);

  const { effects, unresolved: effectsUnresolved } = resolveEffects(node);
  unresolved.push(...effectsUnresolved);

  const opacity = resolveOpacity(node);

  const childCtx = withDescendant(ctx, node);
  const childItems: OrderedChild[] = [];
  for (const child of node.children ?? []) {
    const result = await extractNode(figma, child, node, childCtx, budget, source, false);
    unresolved.push(...result.unresolved);
    if (result.ir) childItems.push({ node: child, ir: result.ir });
  }

  const collapsed = collapseLists(childItems, childCtx);
  const overlayResult = groupOverlayChildren(node, collapsed, childCtx);
  const children = overlayResult.children;
  unresolved.push(...overlayResult.unresolved);

  const layoutNode: LayoutNode = {
    kind: "layout",
    direction,
    gap: gap.token,
    padding,
    mainAxisAlign,
    crossAxisAlign,
    sizing,
    background: background.token,
    cornerRadius: cornerRadius.token,
    ...(border ? { border } : {}),
    ...(effects ? { effects } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    children,
    source: buildProvenance(node, ctx),
  };

  return { ir: layoutNode, unresolved };
}

/**
 * Handles a container-like node (a plain FRAME/GROUP/etc., or — since an
 * unmapped instance has no design-system composable to protect — an
 * unmapped INSTANCE falling back to this same path): empty-and-no-auto-
 * layout collapses to nothing, a single-child non-auto-layout wrapper is a
 * transparent pass-through, and everything else becomes a real `layout`
 * node with recursively-extracted children.
 *
 * Only reads structural fields common to both plain containers and
 * instances (`layoutMode`, spacing/padding, `fills`, `cornerRadius`,
 * `children`, sizing) — never instance-specific fields (`mainComponent`,
 * `componentProperties`), so it's safe to call with an `INSTANCE` node.
 */
async function handleContainerLike(
  figma: FigmaAPI,
  node: FigmaNode,
  parent: FigmaNode | undefined,
  ctx: ProvenanceContext,
  budget: NodeBudget,
  source: ExtractionSource,
  isTopLevel: boolean,
): Promise<NodeResult> {
  const children = node.children ?? [];

  if (children.length === 0 && !hasAutoLayout(node)) {
    // An empty, non-auto-layout frame carries no structural information.
    return { ir: null, unresolved: [] };
  }

  if (children.length === 1 && !hasAutoLayout(node)) {
    // Transparent wrapper: a plain frame around a single child adds no
    // layout intent of its own — recurse straight through to the child
    // rather than emitting a meaningless nested `layout` node. The
    // wrapper's own name is still pushed onto the ancestor path (see
    // provenance.ts) so identity/traceability through re-exports isn't
    // affected by whether we chose to emit an IR node for it.
    const onlyChild = children[0];
    if (onlyChild) {
      return extractNode(
        figma,
        onlyChild,
        node,
        withDescendant(ctx, node),
        budget,
        source,
        isTopLevel,
      );
    }
  }

  return buildLayoutNode(figma, node, parent, ctx, budget, source);
}

async function extractNode(
  figma: FigmaAPI,
  node: FigmaNode,
  parent: FigmaNode | undefined,
  ctx: ProvenanceContext,
  budget: NodeBudget,
  source: ExtractionSource,
  isTopLevel: boolean,
): Promise<NodeResult> {
  await budget.tick();

  if (node.visible === false) {
    return { ir: null, unresolved: [] };
  }

  if (isAssetNode(node)) {
    const result = buildAssetNode(node, ctx, isTopLevel);
    return { ir: result.node, unresolved: result.unresolved };
  }

  if (node.type === "INSTANCE") {
    const result = await buildInstanceNode(node, parent, ctx);
    if (result.kind === "mapped") {
      return { ir: result.node, unresolved: result.unresolved };
    }
    // Unmapped: no design-system composable to protect, so fall back to
    // the same container-handling path a plain FRAME would take — this
    // surfaces the instance's real content (text, nested mapped
    // instances, assets, plain layout) instead of a dead-end node. The
    // unmapped-component/missing-main-component warning(s) already
    // computed above are preserved and merged with whatever the recursed
    // children additionally surface.
    const containerResult = await handleContainerLike(
      figma,
      node,
      parent,
      ctx,
      budget,
      source,
      isTopLevel,
    );
    return {
      ir: containerResult.ir,
      unresolved: [...result.unresolved, ...containerResult.unresolved],
    };
  }

  if (node.type === "TEXT") {
    const result = await buildTextNode(figma, node, ctx);
    return { ir: result.node, unresolved: result.unresolved };
  }

  if (CONTAINER_TYPES.has(node.type)) {
    return handleContainerLike(figma, node, parent, ctx, budget, source, isTopLevel);
  }

  // Unknown/unsupported node type (e.g. a stray SLICE or an unrecognized
  // future node kind): nothing meaningful to extract.
  return { ir: null, unresolved: [] };
}

export async function extractSelection(
  figma: FigmaAPI,
  selection: readonly FigmaNode[],
  source: ExtractionSource,
  nodeBudget = DEFAULT_NODE_BUDGET,
): Promise<ExtractionResult> {
  // Wrap `figma.variables` in a per-call memoization cache (see
  // `variableCache.ts`) so the same variable/collection id looked up from
  // many different nodes/fields hits the Plugin API once, not once per
  // reference.
  const cachedFigma: FigmaAPI = { variables: createCachingVariablesAPI(figma.variables) };
  const budget = new NodeBudget(nodeBudget);
  const ctx: ProvenanceContext = {
    fileKey: source.fileKey,
    version: source.version ?? PENDING_VERSION,
    ancestorPath: [],
    exportRefRegistry: new Map(),
  };

  const nodes: IRNode[] = [];
  const unresolved: UnresolvedEntry[] = [];

  for (const node of selection) {
    const result = await extractNode(cachedFigma, node, undefined, ctx, budget, source, true);
    unresolved.push(...result.unresolved);
    if (result.ir) nodes.push(result.ir);
  }
  withSeverity(unresolved);

  // Explicit override (tests, fixtures): use it verbatim, no hashing.
  if (source.version !== undefined) {
    return { schemaVersion: IR_SCHEMA_VERSION, nodes, unresolved, version: source.version };
  }

  // Production path: derive the version from the IR we just built, then
  // stamp every Provenance.version in the tree with it (see
  // versioning.ts for why a content hash rather than a literal).
  const version = computeContentVersion(nodes);
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    nodes: withVersion(nodes, version),
    unresolved,
    version,
  };
}
