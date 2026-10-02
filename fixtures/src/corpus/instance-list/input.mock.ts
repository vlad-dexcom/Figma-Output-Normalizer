// Scenario: a "quick actions" bar — 4 structurally-identical AppButton
// instances (same main component, same set of component-property keys,
// differing only in label text and layout position) that should collapse
// into a single `list` node with `itemCount: 4`. Exercises list-collapsing
// end-to-end (concern #5) driven by real `instance` IR nodes, not the bare
// text/frame nodes used in `list.test.ts`.
import {
  mockComponent,
  mockComponentSet,
  mockFrame,
  mockInstance,
  mockText,
} from "@figma-exporter/plugin/src/test/nodeBuilders.js";
import type { FigmaNode } from "@figma-exporter/plugin/src/extractor/types.js";
import type { FixtureScenario } from "../../scenario.js";

// Figma keeps the same component-property definition id for every instance
// of a given main component, so identical instances genuinely share this
// raw key — that's what makes them collapse (see `list.ts`'s
// `structuralSignature`, which sorts `componentProperties` keys).
const CTA_LABEL_KEY = "✏️ CTA Label#402:1";

function buildQuickActionInstance(label: string): FigmaNode {
  const componentSet = mockComponentSet({ name: "Buttons" });
  const mainComponent = mockComponent({
    name: "Style=Secondary, Size=Large",
    parent: componentSet,
    key: "buttons-secondary-large",
  });
  return mockInstance({
    name: "Buttons",
    mainComponent,
    componentProperties: {
      Style: { type: "VARIANT", value: "Secondary" },
      Size: { type: "VARIANT", value: "Large" },
      [CTA_LABEL_KEY]: { type: "TEXT", value: label },
    },
  });
}

function buildSelection(): FigmaNode[] {
  const title = mockText("Quick actions", [
    {
      characters: "Quick actions",
      fontSize: 18,
      fontName: { family: "Inter", style: "Bold" },
      fills: [],
    },
  ]);

  const quickActions = mockFrame({
    name: "QuickActions",
    layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    itemSpacing: 8,
    children: [
      buildQuickActionInstance("Log glucose"),
      buildQuickActionInstance("Log insulin"),
      buildQuickActionInstance("Log meal"),
      buildQuickActionInstance("Log exercise"),
    ],
  });

  const screen = mockFrame({
    name: "Screen",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    itemSpacing: 16,
    children: [title, quickActions],
  });

  return [screen];
}

export const instanceList: FixtureScenario = {
  name: "instance-list",
  description:
    "A quick-actions bar: 4 structurally-identical AppButton instances (same component, same prop keys, different labels) collapsing into a single list node.",
  fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
  version: "1",
  buildSelection,
};
