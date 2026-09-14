// Asset detection: vectors, and graphic-only frames/groups/instances, are
// represented as an `asset` node (an export reference) rather than being
// descended into. See concern #6 in the plugin-extractor task description.
import type { AssetNode, UnresolvedEntry } from "@figma-normalizator/schema";
import type { FigmaNode } from "./types.js";
import { buildProvenance, type ProvenanceContext } from "./provenance.js";
import { slugify } from "./slug.js";

const VECTOR_LIKE_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "ELLIPSE",
  "RECTANGLE",
  "LINE",
  "POLYGON",
]);

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE"]);

function isVectorLikeSubtree(node: FigmaNode): boolean {
  if (VECTOR_LIKE_TYPES.has(node.type)) return true;
  if (CONTAINER_TYPES.has(node.type)) {
    const children = node.children ?? [];
    return children.length > 0 && children.every(isVectorLikeSubtree);
  }
  return false;
}

/**
 * True when `node` is effectively just a graphic: a bare vector node, or a
 * frame/group/component/instance whose entire subtree is vector-like shapes
 * (no text, no nested layout-bearing content). Instances of icon components
 * are also treated as assets by name heuristic (see `inferAssetType`) since
 * we don't want to descend into (or component-map-resolve) an icon glyph's
 * internals.
 */
export function isAssetNode(node: FigmaNode): boolean {
  if (node.type === "VECTOR") return true;
  if (node.type === "INSTANCE" && node.name.toLowerCase().includes("icon")) {
    return true;
  }
  if (CONTAINER_TYPES.has(node.type)) {
    const children = node.children ?? [];
    if (children.length === 0) return false;
    return children.every(isVectorLikeSubtree);
  }
  return false;
}

/**
 * Heuristic asset-type classification, deliberately approximate (see
 * plugin-extractor task notes — refining this is a follow-up):
 *   - name contains "icon" (case-insensitive) -> "icon"
 *   - otherwise, at most 48x48 -> "icon" (backlog G3: small glyphs like
 *     "right_content" 40x56 or "misc_lightbulb" 32x32 have no "icon" in
 *     their name but are unmistakably icon-sized, not photos/artwork)
 *   - otherwise, a top-level node at least 120x120 -> "illustration"
 *     (large standalone graphics tend to be illustrations/empty-states)
 *   - otherwise -> "image"
 */
export function inferAssetType(node: FigmaNode, isTopLevel: boolean): AssetNode["assetType"] {
  if (node.name.toLowerCase().includes("icon")) return "icon";
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  if (width > 0 && height > 0 && width <= 48 && height <= 48) return "icon";
  if (isTopLevel && width >= 120 && height >= 120) return "illustration";
  return "image";
}

/**
 * Converts a Figma node id (e.g. "165:3186") into a slug-safe suffix
 * ("165_3186"), for disambiguating `exportRef` collisions.
 */
function nodeIdSuffix(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Deterministically assigns `node`'s `exportRef`, disambiguating a
 * collision with a previously seen *different* node's slug (backlog G2:
 * `icon` x3, `action_buttons` x2, `line` x2, etc. in a real export — the
 * same slugified name from unrelated graphics, which would otherwise
 * silently overwrite one another's exported file). Disambiguation is by
 * node id (`"165:3186"` -> `"_165_3186"` suffix), not by processing order,
 * so the same Figma node always gets the same `exportRef` regardless of
 * selection/traversal order. A collision is also surfaced as an
 * `UnresolvedEntry("duplicate-export-ref")` so it's visible to whoever
 * reviews the export, not just silently renamed.
 */
function resolveExportRef(
  node: FigmaNode,
  registry: Map<string, string>,
): { exportRef: string; unresolved: UnresolvedEntry[] } {
  const baseSlug = slugify(node.name);
  const owner = registry.get(baseSlug);
  if (owner === undefined) {
    registry.set(baseSlug, node.id);
    return { exportRef: baseSlug, unresolved: [] };
  }
  if (owner === node.id) {
    // Same node seen twice (shouldn't normally happen) — reuse its slug.
    return { exportRef: baseSlug, unresolved: [] };
  }
  const disambiguated = `${baseSlug}_${nodeIdSuffix(node.id)}`;
  registry.set(disambiguated, node.id);
  return {
    exportRef: disambiguated,
    unresolved: [
      {
        nodeId: node.id,
        reason: "duplicate-export-ref",
        detail: `exportRef "${baseSlug}" was already assigned to another node; disambiguated to "${disambiguated}" so the two graphics don't overwrite each other's exported file.`,
      },
    ],
  };
}

export function buildAssetNode(
  node: FigmaNode,
  ctx: ProvenanceContext,
  isTopLevel: boolean,
): { node: AssetNode; unresolved: UnresolvedEntry[] } {
  const { exportRef, unresolved } = resolveExportRef(node, ctx.exportRefRegistry);
  return {
    node: {
      kind: "asset",
      assetType: inferAssetType(node, isTopLevel),
      exportRef,
      width: Math.round(node.width ?? 0),
      height: Math.round(node.height ?? 0),
      source: buildProvenance(node, ctx),
    },
    unresolved,
  };
}
