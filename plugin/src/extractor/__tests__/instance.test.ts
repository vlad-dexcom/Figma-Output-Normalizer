import { describe, expect, it } from "vitest";
import { buildInstanceNode } from "../instance.js";
import {
  mockComponent,
  mockComponentSet,
  mockInstance,
  mockInstanceWithUnreadableComponentProperties,
} from "../../test/nodeBuilders.js";

const ctx = { fileKey: "fk", version: "1", ancestorPath: [], exportRefRegistry: new Map() };

function buttonsInstance(overrides: Omit<Parameters<typeof mockInstance>[0], "mainComponent">) {
  const componentSet = mockComponentSet({ name: "Buttons" });
  const main = mockComponent({ name: "Style=Primary, Size=Large", parent: componentSet });
  return mockInstance({ mainComponent: main, ...overrides });
}

describe("buildInstanceNode", () => {
  it("resolves a mapped Buttons instance to AppButton with variant + text props", async () => {
    const node = buttonsInstance({
      name: "Buttons",
      componentProperties: {
        Style: { type: "VARIANT", value: "Primary" },
        Size: { type: "VARIANT", value: "Large" },
        "✏️ CTA Label#123:1": { type: "TEXT", value: "Start sensor" },
      },
    });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    expect(result.node.component).toBe("AppButton");
    expect(result.node.figmaComponentSetName).toBe("Buttons");
    expect(result.node.props.type).toEqual({ variant: "Primary", from: "Style=Primary" });
    expect(result.node.props.size).toEqual({ variant: "Large", from: "Size=Large" });
    expect(result.node.props.text).toEqual({ value: "Start sensor" });
    expect(result.unresolved).toEqual([]);
  });

  it("stops at the instance boundary: the built node has no descended children", async () => {
    const node = buttonsInstance({ name: "Buttons", componentProperties: {} });
    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    expect(result.node).not.toHaveProperty("children");
  });

  it("routes Buttons Type=Icon Only to AppIconButton, keeping the raw figmaComponentSetName", async () => {
    const node = buttonsInstance({
      name: "Buttons",
      componentProperties: {
        Style: { type: "VARIANT", value: "Primary" },
        Type: { type: "VARIANT", value: "Icon Only" },
      },
    });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    expect(result.node.component).toBe("AppIconButton");
    expect(result.node.figmaComponentSetName).toBe("Buttons");
  });

  it("flags an unmapped variant value with reason unmapped-variant and a null variant", async () => {
    const node = buttonsInstance({
      name: "Buttons",
      componentProperties: {
        Style: { type: "VARIANT", value: "Elevated Action" },
      },
    });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    expect(result.node.props.type).toEqual({ variant: null, from: "Style=Elevated Action" });
    expect(result.unresolved).toEqual([
      expect.objectContaining({ nodeId: node.id, reason: "unmapped-variant" }),
    ]);
  });

  it("flags a fully unmapped component set (Accordions) as an unmapped result", async () => {
    const componentSet = mockComponentSet({ name: "Accordions" });
    const main = mockComponent({ name: "Type=Primary, Expanded=No", parent: componentSet });
    const node = mockInstance({ name: "Accordions", mainComponent: main, componentProperties: {} });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("unmapped");
    expect(result.unresolved).toEqual([
      expect.objectContaining({ nodeId: node.id, reason: "unmapped-component" }),
    ]);
  });

  it("flags Checkbox (status: unmapped) as an unmapped result even though its entry has a populated compose block", async () => {
    // Regression test: mappings/component-map.yaml's Checkbox entry has
    // `status: unmapped` (no standalone Figma component set exists yet)
    // but still carries a populated `compose.component` field documenting
    // a "someday" target name. The extractor must treat `status` as
    // authoritative and not silently resolve this as mapped.
    const componentSet = mockComponentSet({ name: "Checkbox" });
    const main = mockComponent({ name: "Selected=Yes, Disabled=No", parent: componentSet });
    const node = mockInstance({ name: "Checkbox", mainComponent: main, componentProperties: {} });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("unmapped");
    expect(result.unresolved).toEqual([
      expect.objectContaining({ nodeId: node.id, reason: "unmapped-component" }),
    ]);
  });

  it("flags a component set with no component-map entry at all as an unmapped result", async () => {
    const componentSet = mockComponentSet({ name: "Some Unknown Set" });
    const main = mockComponent({ name: "Default", parent: componentSet });
    const node = mockInstance({ name: "Unknown", mainComponent: main });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("unmapped");
    expect(result.unresolved[0]?.reason).toBe("unmapped-component");
  });

  it("flags an instance with an unresolvable main component as missing-main-component", async () => {
    const node = mockInstance({ name: "Buttons", mainComponent: null, componentProperties: {} });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ nodeId: node.id, reason: "missing-main-component" }),
    );
  });

  it("treats a throwing componentProperties getter as unmapped with reason unreadable-component-properties", async () => {
    // Simulates the real-world report: Figma's plugin API throws
    // synchronously reading `componentProperties` when the instance's
    // component set has broken/conflicting variant definitions in the
    // file itself. This must not throw out of buildInstanceNode — it
    // should fall back to `unmapped` (same as any other unmapped
    // instance) so the caller recurses into real children instead of
    // discarding the whole subtree.
    const componentSet = mockComponentSet({ name: "Buttons" });
    const main = mockComponent({ name: "Style=Primary, Size=Large", parent: componentSet });
    const node = mockInstanceWithUnreadableComponentProperties(
      { name: "Buttons", mainComponent: main },
      "Component set for node has existing errors",
    );

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("unmapped");
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        nodeId: node.id,
        reason: "unreadable-component-properties",
        detail: expect.stringContaining("Component set for node has existing errors"),
      }),
    ]);
  });

  it("resolves Switch's state-based checked prop", async () => {
    const componentSet = mockComponentSet({ name: "Switch" });
    const main = mockComponent({ name: "State=On", parent: componentSet });
    const node = mockInstance({
      name: "Switch",
      mainComponent: main,
      componentProperties: { State: { type: "VARIANT", value: "On" } },
    });

    const result = await buildInstanceNode(node, undefined, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    expect(result.node.component).toBe("AppSwitch");
    expect(result.node.props.checked).toEqual({ value: true });
  });
});
