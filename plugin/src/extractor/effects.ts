// Border (stroke) and shadow-effect extraction — previously these were
// silently dropped entirely with no `UnresolvedEntry` at all (see backlog
// item B5, docs/BACKLOG.md). Kept in their own module since neither
// concern is really "layout" (spacing/alignment/sizing).
import type { Border, ShadowEffect, UnresolvedEntry } from "@figma-normalizator/schema";
import { colorToHex, resolveStrokeColor, resolveTokenValue } from "./tokens.js";
import { isMixed } from "./mixed.js";
import type { FigmaAPI, FigmaNode } from "./types.js";

const STROKE_ALIGN_MAP: Record<NonNullable<FigmaNode["strokeAlign"]>, Border["align"]> = {
  INSIDE: "inside",
  OUTSIDE: "outside",
  CENTER: "center",
};

/**
 * Resolves `node.strokes`/`strokeWeight`/`strokeAlign` to a `Border`.
 * Returns `undefined` (the field should be omitted, not emitted as `null`)
 * when the node has no strokes at all — mirroring how `dimensions`/
 * `literal` are omitted rather than defaulted elsewhere in this extractor.
 */
export async function resolveBorder(
  figma: FigmaAPI,
  node: FigmaNode,
): Promise<{ border: Border | undefined; unresolved: UnresolvedEntry[] }> {
  const strokes = node.strokes;
  const hasStrokes = !isMixed(strokes) && (strokes?.length ?? 0) > 0;
  if (!hasStrokes) {
    return { border: undefined, unresolved: [] };
  }

  const unresolved: UnresolvedEntry[] = [];
  const color = await resolveStrokeColor(figma, node.id, strokes, node.boundVariables);
  unresolved.push(...color.unresolved);

  const width = isMixed(node.strokeWeight)
    ? {
        token: { token: null, value: 0 },
        unresolved: [
          {
            nodeId: node.id,
            reason: "mixed-value",
            detail:
              'Field "strokeWeight" is mixed (independent per-side stroke weights) and cannot be represented as a single value.',
          },
        ] as UnresolvedEntry[],
      }
    : await resolveTokenValue(
        figma,
        node.id,
        node.boundVariables,
        "strokeWeight",
        node.strokeWeight ?? 0,
      );
  unresolved.push(...width.unresolved);

  return {
    border: {
      color: color.token,
      width: width.token,
      align: STROKE_ALIGN_MAP[node.strokeAlign ?? "OUTSIDE"],
    },
    unresolved,
  };
}

/**
 * Resolves `node.effects` to the schema's `ShadowEffect[]`. Only
 * DROP_SHADOW/INNER_SHADOW are modeled; LAYER_BLUR/BACKGROUND_BLUR push an
 * `unsupported-effect` UnresolvedEntry instead of being silently dropped.
 * Effect colors are resolved as literals only (Figma effect sub-fields
 * aren't looked up against `boundVariables` here — a further-scoped
 * improvement, not a silent loss: every effect is still accounted for in
 * either `effects[]` or `unresolved[]`).
 */
export function resolveEffects(node: FigmaNode): {
  effects: ShadowEffect[] | undefined;
  unresolved: UnresolvedEntry[];
} {
  const rawEffects = node.effects ?? [];
  const unresolved: UnresolvedEntry[] = [];
  const effects: ShadowEffect[] = [];

  for (const effect of rawEffects) {
    if (effect.visible === false) continue;
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      effects.push({
        type: effect.type === "DROP_SHADOW" ? "dropShadow" : "innerShadow",
        color: effect.color ? { token: null, value: colorToHex(effect.color) } : null,
        offsetX: effect.offset?.x ?? 0,
        offsetY: effect.offset?.y ?? 0,
        blur: effect.radius ?? 0,
        spread: effect.spread ?? 0,
      });
    } else {
      unresolved.push({
        nodeId: node.id,
        reason: "unsupported-effect",
        detail: `Effect type "${effect.type}" is not modeled in the IR (only DROP_SHADOW/INNER_SHADOW are); dropped from this node's effects.`,
      });
    }
  }

  return { effects: effects.length > 0 ? effects : undefined, unresolved };
}

/**
 * Resolves `node.opacity` to the optional `LayoutNode.opacity` field,
 * omitted entirely when the node is fully opaque (the default) to avoid
 * noise on the overwhelming majority of nodes.
 */
export function resolveOpacity(node: FigmaNode): number | undefined {
  return node.opacity !== undefined && node.opacity !== 1 ? node.opacity : undefined;
}
