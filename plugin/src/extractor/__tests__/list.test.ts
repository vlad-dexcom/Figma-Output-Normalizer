import { describe, expect, it } from "vitest";
import { collapseLists } from "../list.js";
import {
  mockComponent,
  mockComponentSet,
  mockFrame,
  mockInstance,
  mockInstanceWithUnreadableComponentProperties,
  mockText,
} from "../../test/nodeBuilders.js";
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

describe("collapseLists", () => {
  it("collapses 3+ structurally identical consecutive siblings into a list", () => {
    const items = [1, 2, 3].map((n) => ({
      node: mockFrame({ name: `Row ${n}`, children: [mockText(`Item ${n}`, [])] }),
      ir: textIr(`Item ${n}`),
    }));

    const result = collapseLists(items, ctx);
    expect(result).toHaveLength(1);
    expect(result[0]?.ir.kind).toBe("list");
    if (result[0]?.ir.kind === "list") {
      expect(result[0].ir.itemCount).toBe(3);
      expect(result[0].ir.itemTemplate).toEqual(textIr("Item 1"));
    }
  });

  it("does not collapse runs shorter than 3", () => {
    const items = [1, 2].map((n) => ({
      node: mockFrame({ name: `Row ${n}` }),
      ir: textIr(`Item ${n}`),
    }));
    const result = collapseLists(items, ctx);
    expect(result).toHaveLength(2);
  });

  it("does not collapse structurally different siblings", () => {
    const items = [
      { node: mockFrame({ name: "A" }), ir: textIr("a") },
      { node: mockFrame({ name: "B", layoutMode: "HORIZONTAL" }), ir: textIr("b") },
      { node: mockFrame({ name: "C" }), ir: textIr("c") },
    ];
    const result = collapseLists(items, ctx);
    expect(result).toHaveLength(3);
  });

  it("does not merge a run across an absolute/normal positioning boundary", () => {
    const items = [1, 2, 3].map((n) => ({
      node: mockFrame({ name: `Row ${n}`, layoutPositioning: n === 2 ? "ABSOLUTE" : "AUTO" }),
      ir: textIr(`Item ${n}`),
    }));
    const result = collapseLists(items, ctx);
    expect(result).toHaveLength(3);
  });

  it("does not crash and excludes a sibling whose componentProperties getter throws from list-collapsing", () => {
    // Otherwise-identical instances, but the middle one's componentProperties
    // read throws (broken/conflicting variant definitions in the Figma
    // file). List-collapsing must fail safe — not crash, and not treat
    // the broken sibling as structurally identical to its neighbors — so
    // a single run of 4 identical instances with one broken middle one
    // yields three separate items rather than one collapsed run of 4, and
    // does not throw.
    const componentSet = mockComponentSet({ name: "Buttons" });
    const main = mockComponent({ name: "Style=Primary, Size=Large", parent: componentSet });
    const buildItem = (n: number) => {
      const node = mockInstance({
        name: `Buttons ${n}`,
        mainComponent: main,
        componentProperties: {
          Style: { type: "VARIANT", value: "Primary" },
          Size: { type: "VARIANT", value: "Large" },
        },
      });
      return { node, ir: textIr(`Item ${n}`) };
    };
    const brokenItem = {
      node: mockInstanceWithUnreadableComponentProperties({
        name: "Buttons broken",
        mainComponent: main,
      }),
      ir: textIr("Item broken"),
    };

    const items = [buildItem(1), buildItem(2), brokenItem, buildItem(3), buildItem(4)];

    expect(() => collapseLists(items, ctx)).not.toThrow();
    const result = collapseLists(items, ctx);

    // The broken sibling breaks up what would otherwise be a single run of
    // 5 identical items into shorter runs on either side of it, none of
    // which reach MIN_RUN_LENGTH (3) — so nothing collapses at all, and
    // every item (including the broken one) still passes through.
    expect(result).toHaveLength(5);
    expect(result.every((item) => item.ir.kind !== "list")).toBe(true);
  });
});
