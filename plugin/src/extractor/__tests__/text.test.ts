import { describe, expect, it } from "vitest";
import { buildTextNode } from "../text.js";
import { mockText } from "../../test/nodeBuilders.js";
import type { FigmaAPI } from "../types.js";

const noopFigma: FigmaAPI = {
  variables: {
    getVariableByIdAsync: async () => null,
    getVariableCollectionByIdAsync: async () => null,
  },
};

const ctx = { fileKey: "fk", version: "1", ancestorPath: [], exportRefRegistry: new Map() };

describe("buildTextNode", () => {
  it("emits a plain string for a single uniform-style segment", async () => {
    const node = mockText("Sensor expired", [
      {
        characters: "Sensor expired",
        fontSize: 16,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
    ]);

    const { node: irNode, unresolved } = await buildTextNode(noopFigma, node, ctx);
    expect(irNode.text).toBe("Sensor expired");
    expect(irNode.typography).toEqual({
      token: null,
      literal: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 16 },
    });
    expect(irNode.color).toBeNull();
    // Both typography and color are unbound literals here.
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.reason).toBe("unbound-literal");
  });

  it("emits StyledSegment[] for mixed-style runs, with node-level typography/color null", async () => {
    const node = mockText("Hello world", [
      {
        characters: "Hello ",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
      {
        characters: "world",
        fontSize: 14,
        fontName: { family: "Inter", style: "Bold" },
        fills: [],
      },
    ]);

    const { node: irNode } = await buildTextNode(noopFigma, node, ctx);
    expect(Array.isArray(irNode.text)).toBe(true);
    expect(irNode.text).toEqual([
      {
        text: "Hello ",
        typography: {
          token: null,
          literal: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 14 },
        },
        color: undefined,
      },
      {
        text: "world",
        typography: {
          token: null,
          literal: { fontFamily: "Inter", fontStyle: "Bold", fontSize: 14 },
        },
        color: undefined,
      },
    ]);
    expect(irNode.typography).toBeNull();
    expect(irNode.color).toBeNull();
  });
});
