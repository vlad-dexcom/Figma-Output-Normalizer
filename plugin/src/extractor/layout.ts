// Layout intent normalization: maps raw Auto Layout properties off a
// FrameNode/ComponentNode/InstanceNode to the schema's `layout` IR shape.
// See concern #1 in the plugin-extractor task description.
import type {
  CrossAxisAlign,
  LayoutDirection,
  MainAxisAlign,
  Padding,
  SizeDimensions,
  Sizing,
  SizingMode,
} from "@figma-normalizator/schema";
import type { FigmaNode } from "./types.js";

/** Maps `layoutMode` to IR `direction`. A node with no Auto Layout at all is "stack" if it still has 2+ children (unordered overlap), else it's a leaf. */
export function resolveDirection(node: FigmaNode): LayoutDirection {
  if (node.layoutMode === "HORIZONTAL") return "row";
  if (node.layoutMode === "VERTICAL") return "column";
  return "stack";
}

const PRIMARY_ALIGN_MAP: Record<NonNullable<FigmaNode["primaryAxisAlignItems"]>, MainAxisAlign> = {
  MIN: "start",
  MAX: "end",
  CENTER: "center",
  SPACE_BETWEEN: "spaceBetween",
};

const CROSS_ALIGN_MAP: Record<NonNullable<FigmaNode["counterAxisAlignItems"]>, CrossAxisAlign> = {
  MIN: "start",
  MAX: "end",
  CENTER: "center",
  BASELINE: "start",
};

export function resolveMainAxisAlign(node: FigmaNode): MainAxisAlign {
  return PRIMARY_ALIGN_MAP[node.primaryAxisAlignItems ?? "MIN"];
}

export function resolveCrossAxisAlign(node: FigmaNode): CrossAxisAlign {
  // counterAxisAlignItems has no direct "stretch" enum value in the Figma
  // API — Figma models per-child stretch via the child's own `layoutAlign
  // === "STRETCH"`, not a container-level cross-axis mode. We surface
  // "stretch" for the container only when every child stretches; otherwise
  // fall back to the resolved MIN/MAX/CENTER mapping.
  if (node.counterAxisAlignItems === undefined) return "start";
  const children = node.children ?? [];
  if (children.length > 0 && children.every((c) => c.layoutAlign === "STRETCH")) {
    return "stretch";
  }
  return CROSS_ALIGN_MAP[node.counterAxisAlignItems];
}

/**
 * Resolves how `node` itself sizes along one axis relative to its parent.
 * Precedence (documented heuristic — Figma has no single "resolved sizing"
 * field):
 *   1. If the parent is an Auto Layout container and this node fills along
 *      the matching axis (`layoutGrow === 1` on the parent's primary axis,
 *      or `layoutAlign === "STRETCH"` on the parent's cross axis) -> "fill".
 *   2. Else if `node` is itself an Auto Layout container, use its own
 *      `primaryAxisSizingMode`/`counterAxisSizingMode` (whichever
 *      corresponds to this axis): "FIXED" -> "fixed", "AUTO" -> "hug".
 *   3. Else "fixed" (an explicit, non-auto-layout-driven size).
 */
function resolveAxisSizing(
  node: FigmaNode,
  parent: FigmaNode | undefined,
  axis: "horizontal" | "vertical",
): SizingMode {
  if (parent?.layoutMode === "HORIZONTAL") {
    if (axis === "horizontal" && node.layoutGrow === 1) return "fill";
    if (axis === "vertical" && node.layoutAlign === "STRETCH") return "fill";
  } else if (parent?.layoutMode === "VERTICAL") {
    if (axis === "vertical" && node.layoutGrow === 1) return "fill";
    if (axis === "horizontal" && node.layoutAlign === "STRETCH") return "fill";
  }

  if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL") {
    const modeForAxis =
      node.layoutMode === "HORIZONTAL"
        ? axis === "horizontal"
          ? node.primaryAxisSizingMode
          : node.counterAxisSizingMode
        : axis === "vertical"
          ? node.primaryAxisSizingMode
          : node.counterAxisSizingMode;
    return modeForAxis === "AUTO" ? "hug" : "fixed";
  }

  return "fixed";
}

/**
 * Builds the `Sizing.dimensions` numeric fallback from `node.width`/
 * `node.height` (rounded to whole px, matching the same convention
 * `asset.ts` already uses for its own `width`/`height` fields). Always
 * attempted regardless of resolved sizing mode — a "fill"/"hug" node's
 * current rendered size is still a useful hint for a codegen consumer,
 * even though the authoritative size there comes from the layout engine,
 * not this fixed value. Returns `undefined` (not an empty object) when
 * neither dimension is readable, keeping the IR free of empty-object
 * noise (same convention as `buildTypographyLiteral` in `tokens.ts`).
 */
function buildSizeDimensions(node: FigmaNode): SizeDimensions | undefined {
  const dimensions: SizeDimensions = {};
  if (typeof node.width === "number") dimensions.width = Math.round(node.width);
  if (typeof node.height === "number") dimensions.height = Math.round(node.height);
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

export function resolveSizing(node: FigmaNode, parent: FigmaNode | undefined): Sizing {
  const dimensions = buildSizeDimensions(node);
  return {
    width: resolveAxisSizing(node, parent, "horizontal"),
    height: resolveAxisSizing(node, parent, "vertical"),
    ...(dimensions ? { dimensions } : {}),
  };
}

/** Builds the IR `padding` shape from the four Figma padding fields, using `all` when every side is equal. */
export function buildPaddingRaw(node: FigmaNode): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  return {
    top: node.paddingTop ?? 0,
    right: node.paddingRight ?? 0,
    bottom: node.paddingBottom ?? 0,
    left: node.paddingLeft ?? 0,
  };
}

/** True when top/right/bottom/left padding are all equal (eligible for the `all` shorthand). */
export function isUniformPadding(padding: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): boolean {
  return (
    padding.top === padding.right &&
    padding.right === padding.bottom &&
    padding.bottom === padding.left
  );
}

export type { Padding };
