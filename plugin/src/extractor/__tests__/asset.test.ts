import { describe, expect, it } from "vitest";
import { buildAssetNode, inferAssetType, isAssetNode } from "../asset.js";
import { mockFrame, mockGroup, mockInstance, mockVector } from "../../test/nodeBuilders.js";
import { slugify } from "../slug.js";

const ctx = { fileKey: "fk", version: "1", ancestorPath: [], exportRefRegistry: new Map() };

describe("isAssetNode", () => {
  it("treats a bare VECTOR as an asset", () => {
    expect(isAssetNode(mockVector({ name: "Chevron" }))).toBe(true);
  });

  it("treats a frame containing only vector-like children as an asset", () => {
    const node = mockFrame({
      name: "Icon / Chevron",
      children: [mockVector({ name: "path-1" }), mockVector({ name: "path-2" })],
    });
    expect(isAssetNode(node)).toBe(true);
  });

  it("treats a group of only vectors as an asset, recursively", () => {
    const node = mockGroup({
      name: "Illustration",
      children: [mockGroup({ name: "sub", children: [mockVector({ name: "v" })] })],
    });
    expect(isAssetNode(node)).toBe(true);
  });

  it("does not treat a frame with a text child as an asset", () => {
    const node = mockFrame({
      name: "Card",
      children: [mockVector({ name: "v" }), { id: "t", name: "label", type: "TEXT" } as never],
    });
    expect(isAssetNode(node)).toBe(false);
  });

  it("treats an instance named with 'icon' as an asset", () => {
    expect(isAssetNode(mockInstance({ name: "Icon/Chevron", mainComponent: null }))).toBe(true);
  });

  it("does not treat an empty frame as an asset", () => {
    expect(isAssetNode(mockFrame({ name: "Empty", children: [] }))).toBe(false);
  });
});

describe("inferAssetType", () => {
  it("classifies by name containing 'icon'", () => {
    expect(inferAssetType(mockVector({ name: "Icon/Close" }), false)).toBe("icon");
  });

  it("classifies a large top-level graphic as an illustration", () => {
    expect(inferAssetType(mockFrame({ name: "Empty state", width: 200, height: 200 }), true)).toBe(
      "illustration",
    );
  });

  it("classifies everything else as an image", () => {
    expect(inferAssetType(mockVector({ name: "Photo", width: 300, height: 200 }), false)).toBe(
      "image",
    );
  });

  it("classifies a small (<=48x48) graphic as an icon by size, even without 'icon' in the name (G3)", () => {
    expect(
      inferAssetType(mockVector({ name: "misc_lightbulb", width: 32, height: 32 }), false),
    ).toBe("icon");
  });
});

describe("buildAssetNode", () => {
  it("derives a deterministic exportRef slug and rounds bounds", () => {
    const node = mockVector({ name: "Icon / Chevron-Right!!", width: 23.6, height: 24.4 });
    const result = buildAssetNode(node, ctx, false);
    expect(result.node.exportRef).toBe(slugify("Icon / Chevron-Right!!"));
    expect(result.node.exportRef).toBe("icon_chevron_right");
    expect(result.node.width).toBe(24);
    expect(result.node.height).toBe(24);
    expect(result.unresolved).toEqual([]);
  });

  it("disambiguates a collision between two different nodes sharing a slug (backlog G2)", () => {
    const registry = new Map<string, string>();
    const localCtx = { ...ctx, exportRefRegistry: registry };
    const first = mockVector({ id: "1:1", name: "icon" });
    const second = mockVector({ id: "1:2", name: "icon" });

    const firstResult = buildAssetNode(first, localCtx, false);
    expect(firstResult.node.exportRef).toBe("icon");
    expect(firstResult.unresolved).toEqual([]);

    const secondResult = buildAssetNode(second, localCtx, false);
    expect(secondResult.node.exportRef).toBe("icon_1_2");
    expect(secondResult.unresolved).toEqual([
      { nodeId: "1:2", reason: "duplicate-export-ref", detail: expect.stringContaining("icon") },
    ]);
  });

  it("does not flag the same node re-processed twice as a collision", () => {
    const registry = new Map<string, string>();
    const localCtx = { ...ctx, exportRefRegistry: registry };
    const node = mockVector({ id: "1:1", name: "icon" });

    buildAssetNode(node, localCtx, false);
    const secondPass = buildAssetNode(node, localCtx, false);
    expect(secondPass.node.exportRef).toBe("icon");
    expect(secondPass.unresolved).toEqual([]);
  });
});
