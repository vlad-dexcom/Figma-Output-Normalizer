import { describe, expect, it } from "vitest";
import type { Token } from "@figma-normalizator/schema";
import {
  buildPropertyTree,
  branchChildren,
  leafChildren,
  OWN_VALUE_KEY,
  PropertyPathCollisionError,
} from "../tree.js";
import { sanitizePath } from "../naming.js";

function token(path: string): Token {
  return { type: "COLOR", path, value: "#FFFFFF", modes: { value: "#FFFFFF" } };
}

describe("buildPropertyTree", () => {
  it("nests tokens by slash-separated path segments", () => {
    const tree = buildPropertyTree(
      [token("color/surface/primary"), token("color/surface/secondary"), token("color/text")],
      sanitizePath,
    );
    const color = tree.children.get("color")!;
    expect(branchChildren(tree).map((c) => c.name)).toEqual(["color"]);
    expect(leafChildren(color).map((c) => c.name)).toEqual(["text"]);
    expect(branchChildren(color).map((c) => c.name)).toEqual(["surface"]);
    const surface = color.children.get("surface")!;
    expect(
      leafChildren(surface)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["primary", "secondary"]);
  });

  it("moves an own value into a synthetic 'value' child when the same path is both a leaf and a branch", () => {
    const tree = buildPropertyTree(
      [
        token("apple/liquid-glass/glass-effect"),
        token("apple/liquid-glass/glass-effect/dark-mode"),
        token("apple/liquid-glass/glass-effect/light-mode"),
      ],
      sanitizePath,
    );
    const glassEffect = tree.children
      .get("apple")!
      .children.get("liquid-glass")!
      .children.get("glass-effect")!;
    expect(glassEffect.token).toBeUndefined();
    expect(glassEffect.children.has(OWN_VALUE_KEY)).toBe(true);
    expect(glassEffect.children.get(OWN_VALUE_KEY)!.token?.path).toBe(
      "apple/liquid-glass/glass-effect",
    );
    expect(
      leafChildren(glassEffect)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["dark-mode", "light-mode", "value"]);
  });

  it("throws PropertyPathCollisionError when the reserved 'value' key is itself already a sibling", () => {
    expect(() =>
      buildPropertyTree([token("a"), token("a/value"), token("a/other")], sanitizePath),
    ).toThrow(PropertyPathCollisionError);
  });
});
