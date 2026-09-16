import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { loadTokenDocument } from "../../input/load.js";
import { buildTokenModel } from "../build.js";
import { classifyCollections } from "../classify.js";
import { AmbiguousThemeSourceError, computeBuilderChain, computeThemeModes } from "../graph.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

function collection(
  overrides: Partial<TokenCollection> & Pick<TokenCollection, "id" | "name" | "modes">,
): TokenCollection {
  return {
    remote: false,
    defaultMode: overrides.modes[0] ?? null,
    branches: [],
    dependsOn: [],
    tokens: [],
    ...overrides,
  };
}

function token(path_: string, modes: Record<string, Token["value"]>): Token {
  return { type: "COLOR", path: path_, value: Object.values(modes)[0] ?? null, modes };
}

function document(collections: TokenCollection[]): TokenDocument {
  return {
    envelope: { schemaVersion: 1, kind: "tokens", fileKey: "f", version: "v" },
    policy: {
      excludedCollections: [],
      excludedBranches: [],
      excludeRemoteCollections: true,
      unmatchedPatterns: [],
    },
    collections,
    unresolved: [],
  };
}

describe("computeBuilderChain — synthetic", () => {
  it("orders a linear chain dependencies-first, leaf excluded", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
    });
    const components = collection({
      id: "c",
      name: "components",
      modes: ["value"],
      dependsOn: ["base", "primitives"],
    });
    const model = buildTokenModel(document([primitives, base, components]));
    const classification = classifyCollections(model);
    const chain = computeBuilderChain(model, classification, "c");
    expect(chain.map((c) => c.name)).toEqual(["primitives", "base"]);
  });

  it("handles a diamond dependency without duplicating a shared ancestor", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
    });
    const typography = collection({
      id: "t",
      name: "typography",
      modes: ["ios", "android"],
      dependsOn: ["primitives"],
    });
    const components = collection({
      id: "c",
      name: "components",
      modes: ["value"],
      dependsOn: ["base", "typography"],
    });
    const model = buildTokenModel(document([primitives, base, typography, components]));
    const classification = classifyCollections(model);
    const chain = computeBuilderChain(model, classification, "c");
    expect(chain).toHaveLength(3);
    const names = chain.map((c) => c.name);
    expect(names.indexOf("primitives")).toBeLessThan(names.indexOf("base"));
    expect(names.indexOf("primitives")).toBeLessThan(names.indexOf("typography"));
  });

  it("throws for an unknown leaf id", () => {
    const model = buildTokenModel(document([collection({ id: "p", name: "p", modes: ["value"] })]));
    const classification = classifyCollections(model);
    expect(() => computeBuilderChain(model, classification, "missing")).toThrow(/no collection/);
  });

  it("collapses a reference to one product-group sibling onto the one being built", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const base = collection({
      id: "base",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
      branches: ["color"],
      tokens: [
        token("color/a", { light: "1", dark: "2" }),
        token("color/b", { light: "1", dark: "2" }),
      ],
    });
    const flavor = collection({
      id: "flavor",
      name: "stelo",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
      branches: ["color"],
      tokens: [
        token("color/a", { light: "3", dark: "4" }),
        token("color/b", { light: "3", dark: "4" }),
      ],
    });
    const components = collection({
      id: "components",
      name: "components",
      modes: ["value"],
      // Only ever references the "stelo" flavor directly.
      dependsOn: ["stelo", "primitives"],
    });
    const model = buildTokenModel(document([primitives, base, flavor, components]));
    const classification = classifyCollections(model);
    // Sanity: base/flavor were detected as a product group.
    expect(
      classification.byId.get("flavor")?.role === "product" ||
        classification.byId.get("base")?.role === "product",
    ).toBe(true);

    const chainForFlavor = computeBuilderChain(model, classification, "components", "flavor");
    expect(chainForFlavor.map((c) => c.id)).toContain("flavor");
    expect(chainForFlavor.map((c) => c.id)).not.toContain("base");

    // Building for "base" instead collapses the "stelo" reference onto it.
    const chainForBase = computeBuilderChain(model, classification, "components", "base");
    expect(chainForBase.map((c) => c.id)).toContain("base");
    expect(chainForBase.map((c) => c.id)).not.toContain("flavor");
  });
});

describe("computeBuilderChain — real-world data", () => {
  it("orders components' 3 declared dependencies with primitives before base/typography", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const classification = classifyCollections(model);
    const componentsId = doc.collections.find((c) => c.name === "components")?.id as string;
    const chain = computeBuilderChain(model, classification, componentsId);
    const names = chain.map((c) => c.name);
    expect([...names].sort()).toEqual(["base", "primitives", "typography"]);
    expect(names.indexOf("primitives")).toBeLessThan(names.indexOf("base"));
    expect(names.indexOf("primitives")).toBeLessThan(names.indexOf("typography"));
  });
});

describe("computeThemeModes — synthetic", () => {
  it("returns a single unnamed variant when no collection has more than one mode", () => {
    const a = collection({ id: "a", name: "a", modes: ["value"] });
    const variants = computeThemeModes([a]);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.name).toBe("");
    expect(variants[0]?.modeByCollectionId.get("a")).toBe("value");
  });

  it("derives light/dark variants from the sole multi-mode collection", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    const primitives = collection({ id: "prim", name: "primitives", modes: ["value"] });
    const variants = computeThemeModes([base, primitives]);
    expect(variants.map((v) => v.name)).toEqual(["light", "dark"]);
    const light = variants.find((v) => v.name === "light");
    expect(light?.modeByCollectionId.get("base")).toBe("light");
    // primitives has no "light" mode of its own -- falls back to its default.
    expect(light?.modeByCollectionId.get("prim")).toBe("value");
  });

  it("aligns a collection sharing the variant's mode name instead of falling back to its default", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    // "other" is not the theme driver (given explicitly), but its own
    // default mode ("extra") differs from "dark" -- alignment should still
    // pick "dark" because "other" happens to declare that mode too.
    const other = collection({
      id: "other",
      name: "other",
      modes: ["extra", "dark", "light"],
      defaultMode: "extra",
    });
    const variants = computeThemeModes([base, other], { themeCollectionId: "base" });
    const dark = variants.find((v) => v.name === "dark");
    expect(dark?.modeByCollectionId.get("other")).toBe("dark");
  });

  it("throws AmbiguousThemeSourceError when more than one collection could drive variants", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    const typography = collection({ id: "typo", name: "typography", modes: ["ios", "android"] });
    expect(() => computeThemeModes([base, typography])).toThrow(AmbiguousThemeSourceError);
  });

  it("resolves the ambiguity when an explicit themeCollectionId is given", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    const typography = collection({ id: "typo", name: "typography", modes: ["ios", "android"] });
    const variants = computeThemeModes([base, typography], { themeCollectionId: "base" });
    expect(variants.map((v) => v.name)).toEqual(["light", "dark"]);
  });

  it("drops platform-filtered modes via the caller-supplied option, never a hardcoded rule", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    const typography = collection({ id: "typo", name: "typography", modes: ["ios", "android"] });
    // A Kotlin/Android build excludes "ios" -- typography then has a single
    // filtered mode, so base is unambiguously the theme driver.
    const variants = computeThemeModes([base, typography], { excludeModePattern: /ios/i });
    expect(variants.map((v) => v.name)).toEqual(["light", "dark"]);
    const light = variants.find((v) => v.name === "light");
    expect(light?.modeByCollectionId.get("typo")).toBe("android");
  });

  it("throws for an unknown themeCollectionId", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    expect(() => computeThemeModes([base], { themeCollectionId: "missing" })).toThrow(
      /does not match/,
    );
  });
});

describe("computeThemeModes — real-world data", () => {
  it("is genuinely ambiguous for the components chain until a platform filter or explicit override is applied", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const classification = classifyCollections(model);
    const componentsId = doc.collections.find((c) => c.name === "components")?.id as string;
    const components = model.byId.get(componentsId) as TokenCollection;
    const chain = [components, ...computeBuilderChain(model, classification, componentsId)];

    // base (light/dark) AND primitives (Value/iOS/Android) both have >1
    // mode -- without a platform filter this is a real, unresolved
    // ambiguity the old generator's keyword scoring used to paper over
    // silently.
    expect(() => computeThemeModes(chain)).toThrow(AmbiguousThemeSourceError);

    // A Kotlin build's platform filter (drop "ios") removes typography as a
    // candidate ("ios"/"android" -> "android" alone), but primitives keeps
    // "Value"/"Android" -- two remaining modes -- so this real document
    // stays ambiguous even after platform filtering. An explicit
    // themeCollectionId (e.g. "base", supplied by generator config) is
    // required to build it at all; this is a genuine finding this
    // migration surfaces rather than a test bug.
    expect(() => computeThemeModes(chain, { excludeModePattern: /ios/i })).toThrow(
      AmbiguousThemeSourceError,
    );
    const baseId = doc.collections.find((c) => c.name === "base")?.id as string;
    const variants = computeThemeModes(chain, {
      excludeModePattern: /ios/i,
      themeCollectionId: baseId,
    });
    expect(variants.map((v) => v.name)).toEqual(["light", "dark"]);
  });
});
