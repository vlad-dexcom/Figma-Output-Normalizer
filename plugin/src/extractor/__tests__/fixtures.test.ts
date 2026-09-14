// Integration-style tests: reproduce the exact two worked examples from
// schema/fixtures/ using constructed mock Figma node trees, and assert the
// extractor's output matches those fixture files exactly. This is our best
// proxy for the determinism requirement, since real Figma node data isn't
// available in a headless test environment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSelection } from "../index.js";
import { buildInstanceNode } from "../instance.js";
import { createMockFigma } from "../../test/mockFigma.js";
import {
  mockComponent,
  mockComponentSet,
  mockFrame,
  mockInstance,
  mockText,
} from "../../test/nodeBuilders.js";
import type { InstanceNode as IRInstanceNode, LayoutNode } from "@figma-normalizator/schema";

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../schema/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("fixture: button-instance.json", () => {
  it("reproduces the AppButton instance IR exactly", async () => {
    const componentSet = mockComponentSet({ name: "Buttons" });
    const mainComponent = mockComponent({
      name: "Style=Primary, Size=Large",
      parent: componentSet,
      key: "a91f...",
    });
    const instance = mockInstance({
      id: "12:340",
      name: "Buttons",
      mainComponent,
      layoutGrow: 1,
      componentProperties: {
        Style: { type: "VARIANT", value: "Primary" },
        Size: { type: "VARIANT", value: "Large" },
        "✏️ CTA Label#123:1": { type: "TEXT", value: "Start sensor" },
        "Leading Icon#123:2": { type: "INSTANCE_SWAP", value: "" },
        "Trailing Icon#123:3": { type: "INSTANCE_SWAP", value: "" },
      },
    });
    const footer = mockFrame({ name: "Footer", layoutMode: "HORIZONTAL" });

    const ctx = {
      fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
      version: "1",
      ancestorPath: ["Screen", "Footer"],
      exportRefRegistry: new Map(),
    };

    const result = await buildInstanceNode(instance, footer, ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected mapped result");
    const fixture = readFixture("button-instance.json") as IRInstanceNode;

    expect(result.node).toEqual(fixture);
  });
});

describe("fixture: container-with-text.json", () => {
  it("reproduces the container-with-text layout IR exactly", async () => {
    const textNode = mockText(
      "Sensor expired",
      [
        {
          characters: "Sensor expired",
          fontSize: 16,
          fontName: { family: "Inter", style: "Regular" },
          fills: [
            { type: "SOLID", visible: true, color: { r: 26 / 255, g: 26 / 255, b: 26 / 255 } },
          ],
          boundVariables: {
            fontName: { type: "VARIABLE_ALIAS", id: "var:typography" },
            fills: [{ type: "VARIABLE_ALIAS", id: "var:textColor" }],
          },
        },
      ],
      { id: "12:342", name: "Text", layoutAlign: "STRETCH" },
    );

    const body = mockFrame({
      id: "12:341",
      name: "Body",
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "AUTO",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      layoutAlign: "STRETCH",
      itemSpacing: 16,
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
      boundVariables: {
        itemSpacing: { type: "VARIABLE_ALIAS", id: "var:gap" },
        paddingTop: { type: "VARIABLE_ALIAS", id: "var:padding" },
        paddingRight: { type: "VARIABLE_ALIAS", id: "var:padding" },
        paddingBottom: { type: "VARIABLE_ALIAS", id: "var:padding" },
        paddingLeft: { type: "VARIABLE_ALIAS", id: "var:padding" },
        fills: [{ type: "VARIABLE_ALIAS", id: "var:bg" }],
      },
      children: [textNode],
    });

    const screen = mockFrame({ name: "Screen", layoutMode: "VERTICAL", children: [body] });

    const mockFigma = createMockFigma({
      selection: [screen],
      fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
      variables: {
        "var:gap": {
          name: "spacing/md",
          variableCollectionId: "col:spacing",
          valuesByMode: { m: 16 },
        },
        "var:padding": {
          name: "spacing/lg",
          variableCollectionId: "col:spacing",
          valuesByMode: { m: 24 },
        },
        "var:bg": {
          name: "color/surface/canvas/primary",
          variableCollectionId: "col:color",
          valuesByMode: {
            light: { r: 1, g: 1, b: 1 },
            dark: { r: 0, g: 0, b: 0 },
          },
        },
        "var:typography": {
          name: "typography/body/large",
          variableCollectionId: "col:typography",
          valuesByMode: { m: "n/a" },
        },
        "var:textColor": {
          name: "color/text/base/default",
          variableCollectionId: "col:color",
          valuesByMode: {
            light: { r: 26 / 255, g: 26 / 255, b: 26 / 255 },
            dark: { r: 1, g: 1, b: 1 },
          },
        },
      },
      variableCollections: {
        "col:spacing": {
          modes: [{ modeId: "m", name: "default" }],
          defaultModeId: "m",
          name: "base",
        },
        "col:typography": {
          modes: [{ modeId: "m", name: "default" }],
          defaultModeId: "m",
          name: "typography",
        },
        "col:color": {
          modes: [
            { modeId: "light", name: "light" },
            { modeId: "dark", name: "dark" },
          ],
          defaultModeId: "light",
          name: "base",
        },
      },
    });

    const result = await extractSelection(
      {
        variables: mockFigma.variables as unknown as Parameters<
          typeof extractSelection
        >[0]["variables"],
      },
      [screen],
      { fileKey: "z4Ns3yQoXwMgjky6H9WYtP", version: "1" },
    );

    // `Screen` itself has Auto Layout (needed so `Body`'s fill/hug sizing is
    // derivable), so it produces its own layout node wrapping `Body` — dig
    // one level in to compare the fixture's actual root, `Body`.
    const screenNode = result.nodes[0] as LayoutNode;
    const bodyNode = screenNode.children[0];
    const fixture = readFixture("container-with-text.json");

    expect(bodyNode).toEqual(fixture);
  });
});
