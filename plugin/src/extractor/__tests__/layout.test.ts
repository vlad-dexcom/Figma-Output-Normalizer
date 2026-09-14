import { describe, expect, it } from "vitest";
import {
  resolveCrossAxisAlign,
  resolveDirection,
  resolveMainAxisAlign,
  resolveSizing,
  buildPaddingRaw,
  isUniformPadding,
} from "../layout.js";
import { mockFrame } from "../../test/nodeBuilders.js";

describe("resolveDirection", () => {
  it("maps HORIZONTAL to row and VERTICAL to column", () => {
    expect(resolveDirection(mockFrame({ name: "f", layoutMode: "HORIZONTAL" }))).toBe("row");
    expect(resolveDirection(mockFrame({ name: "f", layoutMode: "VERTICAL" }))).toBe("column");
  });

  it("maps no Auto Layout to stack", () => {
    expect(resolveDirection(mockFrame({ name: "f" }))).toBe("stack");
    expect(resolveDirection(mockFrame({ name: "f", layoutMode: "NONE" }))).toBe("stack");
  });
});

describe("resolveMainAxisAlign / resolveCrossAxisAlign", () => {
  it("maps primaryAxisAlignItems enums", () => {
    expect(resolveMainAxisAlign(mockFrame({ name: "f", primaryAxisAlignItems: "MIN" }))).toBe(
      "start",
    );
    expect(resolveMainAxisAlign(mockFrame({ name: "f", primaryAxisAlignItems: "MAX" }))).toBe(
      "end",
    );
    expect(resolveMainAxisAlign(mockFrame({ name: "f", primaryAxisAlignItems: "CENTER" }))).toBe(
      "center",
    );
    expect(
      resolveMainAxisAlign(mockFrame({ name: "f", primaryAxisAlignItems: "SPACE_BETWEEN" })),
    ).toBe("spaceBetween");
  });

  it("maps counterAxisAlignItems enums", () => {
    expect(resolveCrossAxisAlign(mockFrame({ name: "f", counterAxisAlignItems: "MIN" }))).toBe(
      "start",
    );
    expect(resolveCrossAxisAlign(mockFrame({ name: "f", counterAxisAlignItems: "MAX" }))).toBe(
      "end",
    );
    expect(resolveCrossAxisAlign(mockFrame({ name: "f", counterAxisAlignItems: "CENTER" }))).toBe(
      "center",
    );
  });

  it("resolves stretch only when every child has layoutAlign=STRETCH", () => {
    const stretchedChild = mockFrame({ name: "child", layoutAlign: "STRETCH" });
    const node = mockFrame({
      name: "f",
      counterAxisAlignItems: "MIN",
      children: [stretchedChild],
    });
    expect(resolveCrossAxisAlign(node)).toBe("stretch");
  });
});

describe("resolveSizing", () => {
  it("resolves fill from layoutGrow on the parent's primary axis", () => {
    const parent = mockFrame({ name: "parent", layoutMode: "HORIZONTAL" });
    const node = mockFrame({ name: "child", layoutGrow: 1 });
    expect(resolveSizing(node, parent).width).toBe("fill");
  });

  it("resolves fill from layoutAlign=STRETCH on the parent's cross axis", () => {
    const parent = mockFrame({ name: "parent", layoutMode: "HORIZONTAL" });
    const node = mockFrame({ name: "child", layoutAlign: "STRETCH" });
    expect(resolveSizing(node, parent).height).toBe("fill");
  });

  it("resolves hug/fixed from the node's own primaryAxisSizingMode when it is itself Auto Layout", () => {
    const node = mockFrame({
      name: "self",
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "AUTO",
      counterAxisSizingMode: "FIXED",
    });
    const sizing = resolveSizing(node, undefined);
    expect(sizing.height).toBe("hug");
    expect(sizing.width).toBe("fixed");
  });

  it("defaults to fixed with no Auto Layout signal at all", () => {
    const sizing = resolveSizing(mockFrame({ name: "plain" }), undefined);
    expect(sizing).toEqual({ width: "fixed", height: "fixed" });
  });

  it("populates numeric dimensions from node.width/node.height, rounded to whole px", () => {
    const node = mockFrame({ name: "sized", width: 123.6, height: 40.2 });
    const sizing = resolveSizing(node, undefined);
    expect(sizing.dimensions).toEqual({ width: 124, height: 40 });
  });

  it("omits dimensions entirely (not an empty object) when the node reports no width/height", () => {
    const sizing = resolveSizing(mockFrame({ name: "plain" }), undefined);
    expect(sizing.dimensions).toBeUndefined();
    expect(sizing).not.toHaveProperty("dimensions");
  });
});

describe("padding helpers", () => {
  it("detects uniform padding", () => {
    const node = mockFrame({
      name: "f",
      paddingTop: 8,
      paddingRight: 8,
      paddingBottom: 8,
      paddingLeft: 8,
    });
    expect(isUniformPadding(buildPaddingRaw(node))).toBe(true);
  });

  it("detects non-uniform padding", () => {
    const node = mockFrame({ name: "f", paddingTop: 8, paddingLeft: 4 });
    expect(isUniformPadding(buildPaddingRaw(node))).toBe(false);
  });
});
