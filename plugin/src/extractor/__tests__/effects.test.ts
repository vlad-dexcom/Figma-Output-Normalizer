import { describe, expect, it } from "vitest";
import { resolveBorder, resolveEffects, resolveOpacity } from "../effects.js";
import { extractSelection } from "../index.js";
import { mockFrame } from "../../test/nodeBuilders.js";
import type { FigmaAPI } from "../types.js";

const noopFigma: FigmaAPI = {
  variables: {
    getVariableByIdAsync: async () => null,
    getVariableCollectionByIdAsync: async () => null,
  },
};

describe("resolveBorder", () => {
  it("omits border entirely when the node has no strokes", async () => {
    const node = mockFrame({ name: "plain" });
    const { border, unresolved } = await resolveBorder(noopFigma, node);
    expect(border).toBeUndefined();
    expect(unresolved).toHaveLength(0);
  });

  it("resolves an unbound stroke color/weight as literals, with unbound-literal warnings", async () => {
    const node = mockFrame({
      name: "bordered",
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      strokeWeight: 2,
      strokeAlign: "INSIDE",
    });
    const { border, unresolved } = await resolveBorder(noopFigma, node);
    expect(border).toEqual({
      color: { token: null, value: "#000000" },
      width: { token: null, value: 2 },
      align: "inside",
    });
    expect(unresolved.map((u) => u.reason)).toEqual(["unbound-literal", "unbound-literal"]);
  });

  it("defaults align to 'outside' (Figma's own default) when strokeAlign is absent", async () => {
    const node = mockFrame({
      name: "bordered",
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
      strokeWeight: 1,
    });
    const { border } = await resolveBorder(noopFigma, node);
    expect(border?.align).toBe("outside");
  });
});

describe("resolveEffects", () => {
  it("omits effects entirely when the node has none", () => {
    expect(resolveEffects(mockFrame({ name: "plain" }))).toEqual({
      effects: undefined,
      unresolved: [],
    });
  });

  it("resolves DROP_SHADOW/INNER_SHADOW as literal ShadowEffect entries", () => {
    const node = mockFrame({
      name: "shadowed",
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 2 },
          radius: 4,
          spread: 0,
        },
      ],
    });
    const { effects, unresolved } = resolveEffects(node);
    expect(effects).toEqual([
      {
        type: "dropShadow",
        color: { token: null, value: "#00000040" },
        offsetX: 0,
        offsetY: 2,
        blur: 4,
        spread: 0,
      },
    ]);
    expect(unresolved).toHaveLength(0);
  });

  it("skips invisible effects", () => {
    const node = mockFrame({
      name: "shadowed",
      effects: [
        {
          type: "DROP_SHADOW",
          visible: false,
          color: { r: 0, g: 0, b: 0 },
          offset: { x: 0, y: 0 },
          radius: 0,
          spread: 0,
        },
      ],
    });
    expect(resolveEffects(node).effects).toBeUndefined();
  });

  it("emits an unsupported-effect warning for LAYER_BLUR/BACKGROUND_BLUR instead of silently dropping it", () => {
    const node = mockFrame({
      name: "blurred",
      effects: [{ type: "LAYER_BLUR", radius: 8 }],
    });
    const { effects, unresolved } = resolveEffects(node);
    expect(effects).toBeUndefined();
    expect(unresolved).toEqual([
      {
        nodeId: node.id,
        reason: "unsupported-effect",
        detail: expect.stringContaining("LAYER_BLUR"),
      },
    ]);
  });
});

describe("resolveOpacity", () => {
  it("omits opacity when fully opaque (the default)", () => {
    expect(resolveOpacity(mockFrame({ name: "opaque", opacity: 1 }))).toBeUndefined();
    expect(resolveOpacity(mockFrame({ name: "no-opacity-field" }))).toBeUndefined();
  });

  it("reports a partial opacity value", () => {
    expect(resolveOpacity(mockFrame({ name: "translucent", opacity: 0.5 }))).toBe(0.5);
  });
});

describe("extractSelection integration", () => {
  it("wires border/effects/opacity onto a real layout node, and leaves them absent when not set", async () => {
    const bordered = mockFrame({
      name: "Card",
      layoutMode: "VERTICAL",
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      strokeWeight: 1,
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.1 },
          offset: { x: 0, y: 1 },
          radius: 2,
          spread: 0,
        },
      ],
      opacity: 0.9,
      children: [mockFrame({ name: "child", width: 10, height: 10 })],
    });
    const plain = mockFrame({
      name: "Plain",
      layoutMode: "VERTICAL",
      children: [mockFrame({ name: "child", width: 10, height: 10 })],
    });

    const result = await extractSelection(noopFigma, [bordered, plain], {
      fileKey: "fk",
      version: "1",
    });

    const [borderedNode, plainNode] = result.nodes as unknown as Array<Record<string, unknown>>;
    expect(borderedNode).toBeDefined();
    expect(borderedNode?.border).toEqual({
      color: { token: null, value: "#000000" },
      width: { token: null, value: 1 },
      align: "outside",
    });
    expect(borderedNode?.effects).toEqual([
      {
        type: "dropShadow",
        color: { token: null, value: "#0000001A" },
        offsetX: 0,
        offsetY: 1,
        blur: 2,
        spread: 0,
      },
    ]);
    expect(borderedNode?.opacity).toBe(0.9);

    expect(plainNode).not.toHaveProperty("border");
    expect(plainNode).not.toHaveProperty("effects");
    expect(plainNode).not.toHaveProperty("opacity");
  });
});
