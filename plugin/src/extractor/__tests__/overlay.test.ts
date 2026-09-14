import { describe, expect, it } from "vitest";
import { computeOverlayAlign, groupOverlayChildren } from "../overlay.js";
import { mockFrame } from "../../test/nodeBuilders.js";
import type { TextNode as IRTextNode } from "@figma-normalizator/schema";

const ctx = { fileKey: "fk", version: "1", ancestorPath: [], exportRefRegistry: new Map() };

function textIr(text: string): IRTextNode {
  return {
    kind: "text",
    text,
    typography: null,
    color: null,
    source: { nodeId: "x", fileKey: "fk", version: "1", path: [] },
  };
}

describe("computeOverlayAlign", () => {
  it("buckets a top-left badge as start/start", () => {
    const parent = mockFrame({ name: "p", width: 300, height: 300 });
    const child = mockFrame({ name: "badge", x: 0, y: 0, width: 20, height: 20 });
    expect(computeOverlayAlign(child, parent)).toEqual({ horizontal: "start", vertical: "start" });
  });

  it("buckets a centered modal as center/center", () => {
    const parent = mockFrame({ name: "p", width: 300, height: 300 });
    const child = mockFrame({ name: "modal", x: 100, y: 100, width: 100, height: 100 });
    expect(computeOverlayAlign(child, parent)).toEqual({
      horizontal: "center",
      vertical: "center",
    });
  });

  it("buckets a bottom-right FAB as end/end", () => {
    const parent = mockFrame({ name: "p", width: 300, height: 300 });
    const child = mockFrame({ name: "fab", x: 260, y: 260, width: 30, height: 30 });
    expect(computeOverlayAlign(child, parent)).toEqual({ horizontal: "end", vertical: "end" });
  });
});

describe("groupOverlayChildren", () => {
  it("passes normal children through unchanged when there are no absolute children", () => {
    const parent = mockFrame({ name: "p", width: 100, height: 100 });
    const items = [
      { node: mockFrame({ name: "a" }), ir: textIr("a") },
      { node: mockFrame({ name: "b" }), ir: textIr("b") },
    ];
    const result = groupOverlayChildren(parent, items, ctx);
    expect(result.children).toEqual([textIr("a"), textIr("b")]);
    expect(result.unresolved).toEqual([]);
  });

  it("collects absolute children into a single overlay node at the position they'd start", () => {
    const parent = mockFrame({ name: "p", width: 100, height: 100 });
    const items = [
      { node: mockFrame({ name: "a" }), ir: textIr("a") },
      {
        node: mockFrame({
          name: "badge",
          layoutPositioning: "ABSOLUTE",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        }),
        ir: textIr("badge"),
      },
      { node: mockFrame({ name: "b" }), ir: textIr("b") },
      {
        node: mockFrame({
          name: "fab",
          layoutPositioning: "ABSOLUTE",
          x: 90,
          y: 90,
          width: 10,
          height: 10,
        }),
        ir: textIr("fab"),
      },
    ];

    const result = groupOverlayChildren(parent, items, ctx);
    expect(result.children).toHaveLength(3);
    expect(result.children[0]).toEqual(textIr("a"));
    expect(result.children[1]?.kind).toBe("overlay");
    if (result.children[1]?.kind === "overlay") {
      expect(result.children[1].children).toHaveLength(2);
      expect(result.children[1].children[0]?.node).toEqual(textIr("badge"));
      expect(result.children[1].children[1]?.node).toEqual(textIr("fab"));
    }
    expect(result.children[2]).toEqual(textIr("b"));
    expect(result.unresolved).toEqual([
      expect.objectContaining({ nodeId: parent.id, reason: "absolute-positioning" }),
    ]);
  });
});
