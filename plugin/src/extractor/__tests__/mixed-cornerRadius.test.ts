// Integration test for the "figma.mixed cornerRadius crashes extraction"
// fix (see extractor/mixed.ts, tokens.ts, index.ts): a node whose
// cornerRadius is Figma's `figma.mixed` sentinel (independent per-corner
// radii) must not crash the whole extraction with a raw Symbol reaching
// the IR — it should produce a `mixed-value` warning for that specific
// node/property while the rest of the tree (siblings, children) still
// extracts normally. Mirrors the pattern in
// `unmapped-instance-recursion.test.ts`.
import { describe, expect, it } from "vitest";
import { extractSelection } from "../index.js";
import type { LayoutNode } from "@figma-exporter/schema";
import { mockFrame, mockText } from "../../test/nodeBuilders.js";
import type { FigmaAPI } from "../types.js";

const noopFigmaAPI = {
  variables: {
    getVariableByIdAsync: async () => null,
    getVariableCollectionByIdAsync: async () => null,
  },
} as unknown as FigmaAPI;

describe("mixed cornerRadius", () => {
  it("does not crash and surfaces a mixed-value warning for a node with independent per-corner radii, while siblings still extract", async () => {
    const mixedCornerNode = mockFrame({
      name: "Card with independent corners",
      // Auto Layout so this node isn't pruned/passed-through before
      // `buildLayoutNode` (and therefore the cornerRadius read) ever runs.
      layoutMode: "VERTICAL",
      // Simulates figma.mixed: a real Symbol, exactly as the real Plugin
      // API would return for a rectangle/frame with independent per-corner
      // radii.
      cornerRadius: Symbol("figma.mixed"),
      children: [],
    });
    const siblingText = mockText("Sibling", [
      {
        characters: "Sibling",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
    ]);

    const root = mockFrame({
      name: "Root",
      layoutMode: "VERTICAL",
      children: [mixedCornerNode, siblingText],
    });

    const result = await extractSelection(noopFigmaAPI, [root], { fileKey: "fk", version: "1" });

    const rootNode = result.nodes[0] as LayoutNode;
    expect(rootNode.kind).toBe("layout");
    expect(rootNode.children).toHaveLength(2);

    const [mixedChild, textChild] = rootNode.children;
    expect(mixedChild).toMatchObject({ kind: "layout", cornerRadius: null, children: [] });
    expect(textChild).toMatchObject({ kind: "text", text: "Sibling" });

    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ nodeId: mixedCornerNode.id, reason: "mixed-value" }),
    );

    // No raw Symbol anywhere in the produced IR/unresolved output.
    expect(
      JSON.stringify(result, (_key, value) =>
        typeof value === "symbol" ? "__SYMBOL_LEAKED__" : value,
      ),
    ).not.toContain("__SYMBOL_LEAKED__");
  });

  it("still emits the mixed-value warning for a node with children (does not prune)", async () => {
    const child = mockText("Child", [
      {
        characters: "Child",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
    ]);
    const mixedCornerFrame = mockFrame({
      name: "Frame",
      layoutMode: "VERTICAL",
      cornerRadius: Symbol("figma.mixed"),
      children: [child],
    });

    const result = await extractSelection(noopFigmaAPI, [mixedCornerFrame], {
      fileKey: "fk",
      version: "1",
    });

    const rootNode = result.nodes[0] as LayoutNode;
    expect(rootNode.kind).toBe("layout");
    expect(rootNode.cornerRadius).toBeNull();
    expect(rootNode.children).toHaveLength(1);
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ nodeId: mixedCornerFrame.id, reason: "mixed-value" }),
    );
  });
});
