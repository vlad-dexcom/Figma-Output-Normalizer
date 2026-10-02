// Scenario: a small "today" dashboard screen combining several extractor
// concerns in one realistic composition, as an integration-level regression
// beyond the single-feature scenarios above:
//   - a header row mixing mixed-style text with an icon asset
//   - a frame-based (non-instance) list of 4 identical reminder rows,
//     collapsing to a `list` node (complementary to instance-list.ts, which
//     exercises the same collapse driven by `instance` nodes instead)
//   - a footer AppButton instance using an unmapped Figma variant value
//     ("Elevated Action" — see mappings/component-map.yaml), exercising the
//     `unmapped-variant` UnresolvedEntry path in a realistic context
import {
  mockComponent,
  mockComponentSet,
  mockFrame,
  mockInstance,
  mockText,
  mockVector,
} from "@figma-exporter/plugin/src/test/nodeBuilders.js";
import type { FigmaNode } from "@figma-exporter/plugin/src/extractor/types.js";
import type { FixtureScenario } from "../../scenario.js";

function buildIcon(name: string): FigmaNode {
  return mockFrame({ name, width: 20, height: 20, children: [mockVector({ name: "path" })] });
}

function buildReminderRow(label: string): FigmaNode {
  return mockFrame({
    name: "ReminderRow",
    layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    counterAxisAlignItems: "CENTER",
    itemSpacing: 8,
    children: [
      buildIcon("Icon/Alarm"),
      mockText(label, [
        {
          characters: label,
          fontSize: 14,
          fontName: { family: "Inter", style: "Regular" },
          fills: [],
        },
      ]),
    ],
  });
}

function buildSelection(): FigmaNode[] {
  const headerTitle = mockText(
    "Good morning, Alex",
    [
      {
        characters: "Good morning, ",
        fontSize: 20,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
      {
        characters: "Alex",
        fontSize: 20,
        fontName: { family: "Inter", style: "Bold" },
        fills: [],
      },
    ],
    { name: "HeaderTitle" },
  );

  const headerRow = mockFrame({
    name: "HeaderRow",
    layoutMode: "HORIZONTAL",
    primaryAxisAlignItems: "SPACE_BETWEEN",
    counterAxisAlignItems: "CENTER",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    children: [headerTitle, buildIcon("Icon/Settings")],
  });

  const remindersTitle = mockText("Reminders", [
    {
      characters: "Reminders",
      fontSize: 16,
      fontName: { family: "Inter", style: "Bold" },
      fills: [],
    },
  ]);

  const remindersList = mockFrame({
    name: "RemindersList",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    itemSpacing: 8,
    children: [
      remindersTitle,
      buildReminderRow("Check glucose at 8:00 AM"),
      buildReminderRow("Take insulin at 8:15 AM"),
      buildReminderRow("Log breakfast at 8:30 AM"),
      buildReminderRow("Change sensor at 9:00 AM"),
    ],
  });

  const buttonSet = mockComponentSet({ name: "Buttons" });
  const buttonMain = mockComponent({
    name: "Style=Elevated Action, Size=Large",
    parent: buttonSet,
    key: "buttons-elevated-action-large",
  });
  const snoozeButton = mockInstance({
    name: "Buttons",
    mainComponent: buttonMain,
    componentProperties: {
      Style: { type: "VARIANT", value: "Elevated Action" },
      Size: { type: "VARIANT", value: "Large" },
      "✏️ CTA Label#733:1": { type: "TEXT", value: "Snooze all" },
    },
  });

  const footerRow = mockFrame({
    name: "FooterRow",
    layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    children: [snoozeButton],
  });

  const screen = mockFrame({
    name: "Screen",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    itemSpacing: 20,
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    children: [headerRow, remindersList, footerRow],
  });

  return [screen];
}

export const dashboardScreen: FixtureScenario = {
  name: "dashboard-screen",
  description:
    "A comprehensive 'today' dashboard: header with mixed-style text + icon, a frame-based reminders list collapsing to a list node, and a footer AppButton instance using an unmapped variant value.",
  fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
  version: "1",
  buildSelection,
};
