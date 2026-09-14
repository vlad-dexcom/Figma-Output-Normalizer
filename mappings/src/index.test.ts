import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { generateComponentMapJson, generatedFilePath } from "../scripts/generate-map-lib.mjs";
import {
  componentMap,
  findComponentMapEntry,
  resolveRouting,
  resolveStateValue,
  resolveVariantValue,
} from "./index.js";

const componentMapPath = fileURLToPath(new URL("../component-map.yaml", import.meta.url));

describe("component-map.yaml", () => {
  it("parses as valid YAML and contains entries", () => {
    const raw = readFileSync(componentMapPath, "utf8");
    const parsed = yaml.load(raw) as Record<string, unknown>;

    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect((parsed.entries as unknown[]).length).toBeGreaterThan(0);
  });

  it("gives every entry a figmaComponentSet name and a mapped/unmapped status", () => {
    const raw = readFileSync(componentMapPath, "utf8");
    const parsed = yaml.load(raw) as { entries: Array<Record<string, unknown>> };

    for (const entry of parsed.entries) {
      expect(typeof entry.figmaComponentSet).toBe("string");
      expect(["mapped", "unmapped"]).toContain(entry.status);
    }
  });

  it("generated src/generated/component-map.json is not stale relative to the YAML", async () => {
    const expected = await generateComponentMapJson();
    const actual = await readFile(generatedFilePath, "utf8");
    expect(
      actual,
      "src/generated/component-map.json is stale — run `npm run generate:map` in mappings/ and commit the diff",
    ).toBe(expected);
  });
});

describe("findComponentMapEntry", () => {
  it("finds an entry by exact figmaComponentSet name", () => {
    const entry = findComponentMapEntry("Buttons");
    expect(entry?.compose?.component).toBe("AppButton");
  });

  it("returns null for an unknown component set name", () => {
    expect(findComponentMapEntry("Nonexistent Set")).toBeNull();
  });

  it("falls back to a normalized match for case drift", () => {
    const entry = findComponentMapEntry("buttons");
    expect(entry?.compose?.component).toBe("AppButton");
  });

  it("falls back to a normalized match for extra whitespace", () => {
    const entry = findComponentMapEntry("  Buttons  ");
    expect(entry?.compose?.component).toBe("AppButton");
  });

  it("falls back to a normalized match for singular/plural drift (Badge vs. Badges, B2)", () => {
    const entry = findComponentMapEntry("Badge");
    expect(entry?.figmaComponentSet).toBe("Badges");
  });

  it("still returns null for a genuinely unmapped component set name (no fuzzy/substring matching)", () => {
    expect(findComponentMapEntry("Section Header")).toBeNull();
    expect(findComponentMapEntry("Container")).toBeNull();
  });

  it("has a null compose mapping for a fully unmapped component set (Accordions)", () => {
    const entry = findComponentMapEntry("Accordions");
    expect(entry?.status).toBe("unmapped");
    expect(entry?.compose).toBeNull();
  });
});

describe("resolveRouting", () => {
  it("routes Buttons Type=Icon Only to the AppIconButton entry", () => {
    const buttons = findComponentMapEntry("Buttons");
    expect(buttons).not.toBeNull();
    const routed = resolveRouting(buttons!, { Type: "Icon Only" });
    expect(routed.compose?.component).toBe("AppIconButton");
  });

  it("leaves the entry unchanged when no routing rule matches", () => {
    const buttons = findComponentMapEntry("Buttons");
    expect(buttons).not.toBeNull();
    const routed = resolveRouting(buttons!, { Type: "Default" });
    expect(routed.compose?.component).toBe("AppButton");
  });
});

describe("resolveVariantValue", () => {
  it("resolves a mapped variant value", () => {
    const buttons = findComponentMapEntry("Buttons")!;
    const result = resolveVariantValue(buttons, "Style", "Primary");
    expect(result).toEqual({ status: "mapped", composeProperty: "type", composeValue: "Primary" });
  });

  it("resolves an unmapped variant value with its reason", () => {
    const buttons = findComponentMapEntry("Buttons")!;
    const result = resolveVariantValue(buttons, "Style", "Elevated Action");
    expect(result.status).toBe("unmapped");
    expect(result.status === "unmapped" && result.reason).toMatch(/Elevated Action/);
  });

  it("returns no-mapping for a property the component-map doesn't know about", () => {
    const buttons = findComponentMapEntry("Buttons")!;
    expect(resolveVariantValue(buttons, "SomeOtherProp", "X")).toEqual({ status: "no-mapping" });
  });
});

describe("resolveStateValue", () => {
  it("resolves Switch's state-based checked mapping", () => {
    const swtch = findComponentMapEntry("Switch")!;
    expect(resolveStateValue(swtch, "State", "On")).toEqual({
      status: "mapped",
      composeProperty: "checked",
      composeValue: true,
    });
  });
});

describe("componentMap", () => {
  it("exposes the parsed figma file metadata", () => {
    expect(componentMap.figma.fileKey).toBe("z4Ns3yQoXwMgjky6H9WYtP");
  });
});
