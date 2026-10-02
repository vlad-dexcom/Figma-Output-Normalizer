// Scenario: a settings row with an icon, a label, and an unmapped-component
// instance (Accordions — a Figma component set the design system has no
// Compose composable for yet) side by side. Exercises:
//   - an `asset` node (icon) emitted alongside `text`/`instance` siblings in
//     the same parent (concern #6)
//   - the `unmapped-component` UnresolvedEntry path end-to-end, in a
//     realistic layout context (instance.test.ts already covers this in
//     isolation for the same component set)
//
// Note: an earlier draft of this scenario used the `Checkbox` component set
// (also `status: unmapped` in mappings/component-map.yaml), but Checkbox's
// entry still has a top-level `compose.component` (`AppCheckboxStyle`) —
// the extractor only checks for a *missing* `compose` block, not the
// documentation-only `status` field, so it actually resolves Checkbox
// successfully with zero unresolved entries. That mismatch between the
// yaml's `status: unmapped` marker and the extractor's real behavior seems
// worth a follow-up look (see PR description) but isn't fixed here.
// Accordions' entry has `compose: null`, so it genuinely exercises the
// unmapped-component path.
//
// This `accordion` instance is built with no `children` on purpose: an
// unmapped instance now falls back to the same container-handling rules as
// a plain FRAME (see plugin/src/extractor/instance.ts), so with zero
// children and no auto layout it collapses to nothing in the tree — only
// its `unmapped-component` UnresolvedEntry survives in the flattened
// `unresolved[]` list. See `unmapped-instance-recursion.test.ts` in
// `plugin/src/extractor/__tests__/` for the case where an unmapped instance
// *does* have real children and they're recursed into instead of discarded.
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

function buildSelection(): FigmaNode[] {
  const bellIcon = mockFrame({
    name: "Icon/Bell",
    width: 24,
    height: 24,
    children: [mockVector({ name: "path-1" }), mockVector({ name: "path-2" })],
  });

  const label = mockText("Frequently asked questions", [
    {
      characters: "Frequently asked questions",
      fontSize: 16,
      fontName: { family: "Inter", style: "Regular" },
      fills: [],
    },
  ]);

  const accordionSet = mockComponentSet({ name: "Accordions" });
  const accordionMain = mockComponent({
    name: "Type=Primary, Expanded=No",
    parent: accordionSet,
    key: "accordions-primary-collapsed",
  });
  const accordion = mockInstance({
    name: "Accordions",
    mainComponent: accordionMain,
    componentProperties: {
      Type: { type: "VARIANT", value: "Primary" },
      Expanded: { type: "VARIANT", value: "No" },
    },
  });

  const row = mockFrame({
    name: "FaqRow",
    layoutMode: "HORIZONTAL",
    primaryAxisAlignItems: "SPACE_BETWEEN",
    counterAxisAlignItems: "CENTER",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "AUTO",
    itemSpacing: 12,
    children: [bellIcon, label, accordion],
  });

  const screen = mockFrame({
    name: "Screen",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    itemSpacing: 16,
    children: [
      mockText("Help", [
        {
          characters: "Help",
          fontSize: 18,
          fontName: { family: "Inter", style: "Bold" },
          fills: [],
        },
      ]),
      row,
    ],
  });

  return [screen];
}

export const rowWithIconAndAccordion: FixtureScenario = {
  name: "row-with-icon-and-accordion",
  description:
    "A help row: icon asset + label text + an unmapped Accordions instance (unmapped-component, compose: null) in the same parent.",
  fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
  version: "1",
  buildSelection,
};
