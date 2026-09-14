import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateWiringRulesJson,
  generatedFilePath,
} from "../scripts/generate-wiring-rules-lib.mjs";
import { resolveTokenSymbol, toCamelCaseSegment, wiringRules } from "./wiring.js";

describe("wiring-rules.yaml", () => {
  it("generated src/generated/wiring-rules.json is not stale relative to the YAML", async () => {
    const expected = await generateWiringRulesJson();
    const actual = await readFile(generatedFilePath, "utf8");
    expect(actual).toBe(expected);
  });

  it("requires a reason on every unmapped rule and evidence on every mapped one", () => {
    for (const rule of wiringRules.rules) {
      if (rule.status === "unmapped") {
        expect(rule.reason, `rule "${rule.id}" is unmapped but has no reason`).toBeTruthy();
      } else {
        expect(rule.symbol, `rule "${rule.id}" is mapped but derives no symbol`).toBeTruthy();
        expect(rule.evidence, `rule "${rule.id}" is mapped but cites no evidence`).toBeTruthy();
      }
    }
  });

  it("ends with a catch-all rule, so no token can fall through unexplained", () => {
    const last = wiringRules.rules[wiringRules.rules.length - 1];
    expect(last?.match ?? {}).toEqual({});
  });
});

describe("toCamelCaseSegment", () => {
  it("camelCases hyphenated and spaced segments", () => {
    expect(toCamelCaseSegment("border-width")).toBe("borderWidth");
    expect(toCamelCaseSegment("black 5%")).toBe("black5");
    expect(toCamelCaseSegment("systemBlue")).toBe("systemBlue");
  });

  it("prefixes a leading digit so the result is a valid Kotlin identifier", () => {
    expect(toCamelCaseSegment("4-color")).toBe("_4Color");
    expect(toCamelCaseSegment("500")).toBe("_500");
  });

  it("falls back to _empty for a segment that is entirely punctuation", () => {
    expect(toCamelCaseSegment("%%%")).toBe("_empty");
  });
});

describe("resolveTokenSymbol", () => {
  it("derives the AppTheme accessor for base/color/*, naming the rule that decided", () => {
    expect(resolveTokenSymbol("base", "color/surface/action/primary/default")).toEqual({
      symbol: "AppTheme.semanticColors.surface.action.primary.default",
      from: "base-color",
    });
  });

  it("returns symbol:null plus a reason for base's non-color branches", () => {
    const result = resolveTokenSymbol("base", "radius/md");
    expect(result.symbol).toBeNull();
    expect(result.from).toBe("base-other-branches");
    expect(result.reason).toContain("Base.color");
  });

  it("returns symbol:null plus a reason for every other collection", () => {
    const result = resolveTokenSymbol("components", "banners/type/informative/color/surface");
    expect(result.symbol).toBeNull();
    expect(result.from).toBe("other-collections");
    expect(result.reason).toBeTruthy();
  });

  it("never lends base's rule to another collection sharing the same path", () => {
    // The retired token-map bundle was indexed by path alone while `base`
    // and the (since-deleted) `stelo` collection shared 324 of 324 paths.
    // Qualified identity is what makes this case unambiguous.
    const base = resolveTokenSymbol("base", "color/brand/tertiary");
    const other = resolveTokenSymbol("some-product-theme", "color/brand/tertiary");
    expect(base.symbol).toBe("AppTheme.semanticColors.brand.tertiary");
    expect(other.symbol).toBeNull();
  });

  it("treats an unknown collection as unknown, not as base", () => {
    const result = resolveTokenSymbol(null, "color/brand/tertiary");
    expect(result.symbol).toBeNull();
  });

  it("always explains itself: a null symbol always carries a reason", () => {
    for (const [collection, path] of [
      ["base", "color/a/b"],
      ["base", "opacity/disabled"],
      ["primitives", "palette/blue/500"],
      [null, "color/a/b"],
    ] as const) {
      const result = resolveTokenSymbol(collection, path);
      if (result.symbol === null) expect(result.reason).toBeTruthy();
      else expect(result.from).toBeTruthy();
    }
  });
});

describe("retired stelo artifacts", () => {
  // `stelo` was deliberately deleted from Figma. The retired token-map
  // artifacts kept shipping 324 rows for it regardless, which is the exact
  // failure mode this guard exists to prevent from recurring: a *data*
  // artifact outliving the thing it describes.
  //
  // Prose references (this repo's READMEs and source comments explaining the
  // history) are fine and deliberately kept — only generated data and config
  // are checked.
  const dataFiles = [
    "generated/wiring-rules.json",
    "generated/collections-policy.json",
    "generated/component-map.json",
    "../wiring-rules/wiring-rules.yaml",
    "../collections-policy.yaml",
    "../component-map.yaml",
  ];

  for (const file of dataFiles) {
    it(`${file} contains no stelo data`, async () => {
      const contents = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(contents.toLowerCase()).not.toContain("stelo");
    });
  }

  it("no token-map artifact has come back", async () => {
    const dir = fileURLToPath(new URL("../", import.meta.url));
    await expect(readFile(`${dir}token-map/android-stelo.token-map.json`)).rejects.toThrow();
    await expect(readFile(`${dir}src/generated/token-map.json`)).rejects.toThrow();
  });
});
