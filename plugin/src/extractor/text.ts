// Text extraction: detects mixed-style runs via getStyledTextSegments and
// resolves typography/color tokens per run. See concern #2 in the
// plugin-extractor task description.
import type {
  StyledSegment,
  TextNode as IRTextNode,
  UnresolvedEntry,
} from "@figma-normalizator/schema";
import { resolveFillColor, resolveTypographyToken } from "./tokens.js";
import type { FigmaAPI, FigmaNode, FigmaStyledTextSegment } from "./types.js";
import { buildProvenance, type ProvenanceContext } from "./provenance.js";

/** Fields requested from `getStyledTextSegments`, in the order the plugin-extractor task specifies. */
export const STYLED_TEXT_SEGMENT_FIELDS = [
  "fontSize",
  "fontName",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "fills",
  "boundVariables",
] as const;

function getSegments(node: FigmaNode): FigmaStyledTextSegment[] {
  if (typeof node.getStyledTextSegments === "function") {
    return node.getStyledTextSegments([...STYLED_TEXT_SEGMENT_FIELDS]);
  }
  // Defensive fallback (shouldn't happen for a real TEXT node): treat the
  // whole string as one unstyled segment.
  return [
    {
      characters: node.characters ?? "",
      fontSize: 0,
      fontName: { family: "", style: "" },
      fills: [],
    },
  ];
}

export async function buildTextNode(
  figma: FigmaAPI,
  node: FigmaNode,
  ctx: ProvenanceContext,
): Promise<{ node: IRTextNode; unresolved: UnresolvedEntry[] }> {
  const segments = getSegments(node);
  const unresolved: UnresolvedEntry[] = [];

  const resolveSegment = async (segment: FigmaStyledTextSegment): Promise<StyledSegment> => {
    const typography = await resolveTypographyToken(
      figma,
      node.id,
      segment.boundVariables,
      segment,
    );
    const color = await resolveFillColor(figma, node.id, segment.fills, segment.boundVariables);
    unresolved.push(...typography.unresolved, ...color.unresolved);
    return {
      text: segment.characters,
      typography: typography.token,
      color: color.token ?? undefined,
    };
  };

  if (segments.length <= 1) {
    const first = segments[0];
    const characters = first?.characters ?? node.characters ?? "";
    const typography = first
      ? await resolveTypographyToken(figma, node.id, first.boundVariables, first)
      : { token: { token: null }, unresolved: [] };
    const color = first
      ? await resolveFillColor(figma, node.id, first.fills, first.boundVariables)
      : { token: null, unresolved: [] };
    unresolved.push(...typography.unresolved, ...color.unresolved);

    return {
      node: {
        kind: "text",
        text: characters,
        typography: typography.token,
        color: color.token,
        source: buildProvenance(node, ctx),
      },
      unresolved,
    };
  }

  const styledSegments: StyledSegment[] = [];
  for (const segment of segments) {
    styledSegments.push(await resolveSegment(segment));
  }

  return {
    node: {
      kind: "text",
      text: styledSegments,
      // No single typography/color applies at the node level when the run
      // is mixed-style — per-segment values carry the resolved tokens.
      typography: null,
      color: null,
      source: buildProvenance(node, ctx),
    },
    unresolved,
  };
}
