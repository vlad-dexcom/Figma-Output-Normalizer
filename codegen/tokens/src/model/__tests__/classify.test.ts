import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { loadTokenDocument } from "../../input/load.js";
import { buildTokenModel } from "../build.js";
import { classifyCollections } from "../classify.js";

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

describe("classifyCollections — real-world data (plan 5.1-5.4)", () => {
  it("classifies every real collection using only mode count and dependsOn, never names", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const report = classifyCollections(model);

    const roleByName = new Map(report.entries.map((e) => [e.name, e.role]));
    // primitives has 3 modes (Value/iOS/Android) so the single-mode
    // primitive rule does not apply to it -- it falls through to the
    // "semantic" default, exactly like base and typography. This is a
    // real, structural surprise the old name-based intuition would miss.
    expect(roleByName.get("primitives")).toBe("semantic");
    expect(roleByName.get("base")).toBe("semantic");
    expect(roleByName.get("typography")).toBe("semantic");
    // layout is single-mode with zero dependencies.
    expect(roleByName.get("layout")).toBe("primitive");
    // components depends on 3 other collections -- a composition point.
    expect(roleByName.get("components")).toBe("leaf");

    // No product groups exist in this fixture (the "stelo" flavor
    // collection was removed from the source file, see plan Stage 0).
    expect(report.entries.some((e) => e.role === "product")).toBe(false);

    // Every entry carries a human-readable justification.
    for (const entry of report.entries) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyCollections — synthetic edge cases", () => {
  it("classifies a single-mode, dependency-free collection as primitive", () => {
    const primitives = collection({ id: "c1", name: "primitives", modes: ["value"] });
    const model = buildTokenModel(document([primitives]));
    const report = classifyCollections(model);
    expect(report.byId.get("c1")?.role).toBe("primitive");
  });

  it("classifies a multi-mode collection with no siblings and <2 deps as semantic", () => {
    const base = collection({
      id: "c1",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
    });
    const primitives = collection({ id: "c2", name: "primitives", modes: ["value"] });
    const model = buildTokenModel(document([base, primitives]));
    const report = classifyCollections(model);
    expect(report.byId.get("c1")?.role).toBe("semantic");
  });

  it("reclassifies a semantic collection with >=2 dependencies as leaf", () => {
    const components = collection({
      id: "c1",
      name: "components",
      modes: ["value"],
      dependsOn: ["base", "typography"],
    });
    const base = collection({ id: "c2", name: "base", modes: ["light", "dark"] });
    const typography = collection({ id: "c3", name: "typography", modes: ["ios", "android"] });
    const model = buildTokenModel(document([components, base, typography]));
    const report = classifyCollections(model);
    expect(report.byId.get("c1")?.role).toBe("leaf");
  });

  it("detects a product group by structural (branch/path) overlap, never by name", () => {
    const base = collection({
      id: "c1",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
      branches: ["color"],
      tokens: [
        token("color/surface", { light: "#fff", dark: "#000" }),
        token("color/text", { light: "#000", dark: "#fff" }),
      ],
    });
    // Deliberately named unlike "base" anywhere -- classification must not
    // rely on this collection's name resembling a "flavor" of base.
    const zzzFlavor = collection({
      id: "c2",
      name: "zzz-totally-unrelated-name",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
      branches: ["color"],
      tokens: [
        token("color/surface", { light: "#eee", dark: "#111" }),
        token("color/text", { light: "#111", dark: "#eee" }),
      ],
    });
    const primitives = collection({ id: "c3", name: "primitives", modes: ["value"] });
    const model = buildTokenModel(document([base, zzzFlavor, primitives]));
    const report = classifyCollections(model);

    // base has more tokens... they're tied (2 vs 2), so whichever the
    // reduce visits first (declared order) wins the base slot; what
    // matters is exactly one becomes the base and the other "product".
    const baseEntry = report.byId.get("c1") as ReturnType<
      typeof classifyCollections
    >["entries"][number];
    const flavorEntry = report.byId.get("c2") as ReturnType<
      typeof classifyCollections
    >["entries"][number];
    const roles = [baseEntry.role, flavorEntry.role].sort();
    expect(roles).toEqual(["product", "semantic"]);
    const product = baseEntry.role === "product" ? baseEntry : flavorEntry;
    const base_ = baseEntry.role === "semantic" ? baseEntry : flavorEntry;
    expect(product.baseCollectionId).toBe(base_.id);
  });

  it("does not group collections whose structure is too different (<90% overlap)", () => {
    const base = collection({
      id: "c1",
      name: "base",
      modes: ["light", "dark"],
      branches: ["color"],
      tokens: [
        token("color/a", { light: "1", dark: "2" }),
        token("color/b", { light: "1", dark: "2" }),
        token("color/c", { light: "1", dark: "2" }),
        token("color/d", { light: "1", dark: "2" }),
      ],
    });
    const unrelated = collection({
      id: "c2",
      name: "unrelated",
      modes: ["light", "dark"],
      branches: ["color"],
      tokens: [
        token("color/a", { light: "1", dark: "2" }),
        token("color/z1", { light: "1", dark: "2" }),
        token("color/z2", { light: "1", dark: "2" }),
        token("color/z3", { light: "1", dark: "2" }),
      ],
    });
    const model = buildTokenModel(document([base, unrelated]));
    const report = classifyCollections(model);
    expect(report.byId.get("c1")?.role).toBe("semantic");
    expect(report.byId.get("c2")?.role).toBe("semantic");
    expect(report.byId.get("c1")?.baseCollectionId).toBeUndefined();
  });
});
