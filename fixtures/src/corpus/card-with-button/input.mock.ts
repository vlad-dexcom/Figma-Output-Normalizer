// Scenario: a card-like screen — an outer auto-layout column containing a
// card that mixes plain text, mixed-style text, and a mapped component
// instance, nested at least two levels deep (Screen > Card > ButtonRow >
// AppButton). Exercises:
//   - nested layout containers (2+ levels)
//   - an `instance` node sitting alongside `text`/`layout` siblings
//   - mixed-style text (getStyledTextSegments with >1 run) inside a
//     realistic layout, not in isolation
//   - bound-variable token resolution (padding/gap/background/typography)
//     alongside unbound literals, mirroring schema/fixtures/container-with-text.json
import {
  mockComponent,
  mockComponentSet,
  mockFrame,
  mockInstance,
  mockText,
} from "@figma-normalizator/plugin/src/test/nodeBuilders.js";
import type { FigmaNode } from "@figma-normalizator/plugin/src/extractor/types.js";
import type { FixtureScenario } from "../../scenario.js";

function buildSelection(): FigmaNode[] {
  const title = mockText("Sensor status", [
    {
      characters: "Sensor status",
      fontSize: 20,
      fontName: { family: "Inter", style: "Bold" },
      fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 } }],
      boundVariables: {
        fontName: { type: "VARIABLE_ALIAS", id: "var:typography-title" },
      },
    },
  ]);

  const description = mockText(
    "Your sensor expires in 2 days",
    [
      {
        characters: "Your sensor expires in ",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        fills: [{ type: "SOLID", visible: true, color: { r: 0.4, g: 0.4, b: 0.4 } }],
      },
      {
        characters: "2 days",
        fontSize: 14,
        fontName: { family: "Inter", style: "Bold" },
        fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 } }],
      },
    ],
    { name: "Description" },
  );

  const componentSet = mockComponentSet({ name: "Buttons" });
  const mainComponent = mockComponent({
    name: "Style=Primary, Size=Large",
    parent: componentSet,
    key: "buttons-primary-large",
  });
  const replaceButton = mockInstance({
    name: "Buttons",
    mainComponent,
    layoutGrow: 1,
    componentProperties: {
      Style: { type: "VARIANT", value: "Primary" },
      Size: { type: "VARIANT", value: "Large" },
      "✏️ CTA Label#901:1": { type: "TEXT", value: "Replace now" },
    },
  });

  const buttonRow = mockFrame({
    name: "ButtonRow",
    layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    itemSpacing: 8,
    children: [replaceButton],
  });

  const card = mockFrame({
    name: "Card",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    counterAxisAlignItems: "MIN",
    itemSpacing: 12,
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: 20,
    cornerRadius: 12,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
    boundVariables: {
      itemSpacing: { type: "VARIABLE_ALIAS", id: "var:gap-md" },
      paddingTop: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingRight: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingBottom: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingLeft: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      fills: [{ type: "VARIABLE_ALIAS", id: "var:bg-surface" }],
    },
    children: [title, description, buttonRow],
  });

  const screen = mockFrame({
    name: "Screen",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    boundVariables: {
      paddingTop: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingRight: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingBottom: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
      paddingLeft: { type: "VARIABLE_ALIAS", id: "var:padding-lg" },
    },
    children: [card],
  });

  return [screen];
}

export const cardWithButton: FixtureScenario = {
  name: "card-with-button",
  description:
    "A card-like screen: Screen > Card > (title text, mixed-style description text, ButtonRow > AppButton instance), nested 2+ levels deep.",
  fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
  version: "1",
  buildSelection,
  variables: {
    "var:gap-md": {
      name: "spacing/md",
      variableCollectionId: "col:spacing",
      valuesByMode: { m: 12 },
    },
    "var:padding-lg": {
      name: "spacing/lg",
      variableCollectionId: "col:spacing",
      valuesByMode: { m: 20 },
    },
    "var:bg-surface": {
      name: "color/surface/canvas/primary",
      variableCollectionId: "col:color",
      valuesByMode: { light: { r: 1, g: 1, b: 1 }, dark: { r: 0, g: 0, b: 0 } },
    },
    "var:typography-title": {
      name: "typography/title/medium",
      variableCollectionId: "col:typography",
      valuesByMode: { m: "n/a" },
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
};
