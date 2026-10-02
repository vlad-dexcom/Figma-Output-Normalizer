// Scenario: a badge absolutely positioned over an avatar inside an
// otherwise-plain (non-auto-layout, i.e. "stack") parent, wrapped in a
// realistic screen with title/caption text. Exercises the overlay/absolute
// positioning path (concern #7) end-to-end, using a real mapped instance
// (AppBadge) as the overlaid element rather than a bare mock frame.
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
  // A 64x64 avatar image, represented as an asset (vector-only subtree) so
  // its internals aren't descended into.
  const avatar = mockFrame({
    name: "Avatar",
    width: 64,
    height: 64,
    x: 0,
    y: 0,
    children: [mockVector({ name: "photo" })],
  });

  const badgeSet = mockComponentSet({ name: "Badges" });
  const badgeMain = mockComponent({
    name: "Type=New, Size=Small",
    parent: badgeSet,
    key: "badges-new-small",
  });
  const badge = mockInstance({
    name: "Badges",
    mainComponent: badgeMain,
    layoutPositioning: "ABSOLUTE",
    x: 48,
    y: -6,
    width: 20,
    height: 20,
    componentProperties: {
      Type: { type: "VARIANT", value: "New" },
      Size: { type: "VARIANT", value: "Small" },
    },
  });

  // No `layoutMode`: a plain (non-auto-layout) container with 2+ children
  // resolves to `direction: "stack"`, and its absolutely-positioned child
  // (the badge) is grouped into an `overlay` node alongside the avatar.
  const avatarStack = mockFrame({
    name: "AvatarStack",
    width: 64,
    height: 64,
    children: [avatar, badge],
  });

  const title = mockText("Profile", [
    {
      characters: "Profile",
      fontSize: 18,
      fontName: { family: "Inter", style: "Bold" },
      fills: [],
    },
  ]);
  const caption = mockText("Tap to edit your photo", [
    {
      characters: "Tap to edit your photo",
      fontSize: 13,
      fontName: { family: "Inter", style: "Regular" },
      fills: [],
    },
  ]);

  const screen = mockFrame({
    name: "Screen",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    counterAxisAlignItems: "CENTER",
    itemSpacing: 12,
    children: [title, avatarStack, caption],
  });

  return [screen];
}

export const overlayBadgeOverAvatar: FixtureScenario = {
  name: "overlay-badge-over-avatar",
  description:
    "A profile screen with a 'New' badge instance absolutely positioned over the top-right corner of an avatar, exercising the overlay/absolute-positioning path.",
  fileKey: "z4Ns3yQoXwMgjky6H9WYtP",
  version: "1",
  buildSelection,
};
