import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { loadTokenDocument } from "../../input/load.js";
import { buildTokenModel } from "../../model/build.js";
import {
  DuplicateClassNameError,
  generateCollectionKotlinFile,
  generateCollectionLegacyKotlinFiles,
  generateKotlinFiles,
  generateLegacyKotlinFiles,
  MissingDependencyParamError,
  UnrepresentableTokenValueError,
} from "../kotlin.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-88d0431a4019ec4b.tokens.json",
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

function token(overrides: Partial<Token> & Pick<Token, "path" | "modes">): Token {
  return { type: "COLOR", value: Object.values(overrides.modes)[0] ?? null, ...overrides };
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

describe("generateCollectionKotlinFile — synthetic", () => {
  it("returns undefined for an empty collection", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const model = buildTokenModel(document([primitives]));
    expect(
      generateCollectionKotlinFile(model, primitives, { packageName: "com.test" }),
    ).toBeUndefined();
  });

  it("emits a nested data class and one factory per mode, with a Kotlin keyword escaped", () => {
    const primitives = collection({
      id: "p",
      name: "primitives",
      modes: ["value"],
      tokens: [
        token({ path: "color/surface", modes: { value: "#FF0000" } }),
        token({ path: "color/is", type: "BOOLEAN", modes: { value: true } }),
      ],
    });
    const model = buildTokenModel(document([primitives]));
    const file = generateCollectionKotlinFile(model, primitives, { packageName: "com.test" })!;
    expect(file.relativePath).toBe("com/test/Primitives.kt");
    expect(file.contents).toContain("package com.test");
    expect(file.contents).toContain("data class Primitives");
    expect(file.contents).toContain("data class Color(");
    expect(file.contents).toContain("val `is`: Boolean,");
    expect(file.contents).toContain("fun primitivesValue(): Primitives =");
    expect(file.contents).toContain(
      "surface = androidx.compose.ui.graphics.Color(1.0f, 0.0f, 0.0f, 1.0f),",
    );
    expect(file.contents).toContain("`is` = true,");
    expect(file.contents).toContain("DO NOT MODIFY");
  });

  it("emits a live property reference for a resolved, non-excluded alias, not a duplicated literal", () => {
    const primitives = collection({
      id: "p",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "color/red", modes: { value: "#FF0000" } })],
    });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light"],
      dependsOn: ["primitives"],
      tokens: [
        token({
          path: "color/surface",
          modes: { light: "#FF0000" },
          alias: { byMode: { light: { collection: "primitives", path: "color/red" } } },
        }),
      ],
    });
    const model = buildTokenModel(document([primitives, base]));
    const file = generateCollectionKotlinFile(model, base, { packageName: "com.test" })!;
    expect(file.contents).toContain("fun baseLight(primitives: Primitives): Base =");
    expect(file.contents).toContain("surface = primitives.color.red,");
    expect(file.contents).not.toContain("#FF0000");
  });

  it("falls back to a baked literal when the alias target was excluded by policy", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light"],
      tokens: [
        token({
          path: "color/surface",
          modes: { light: "#00FF00" },
          alias: {
            byMode: { light: { collection: "excluded-lib", path: "color/x", excluded: true } },
          },
        }),
      ],
    });
    const model = buildTokenModel(document([primitives, base]));
    const file = generateCollectionKotlinFile(model, base, { packageName: "com.test" })!;
    expect(file.contents).toContain("androidx.compose.ui.graphics.Color(0.0f, 1.0f, 0.0f, 1.0f)");
  });

  it("throws MissingDependencyParamError when an alias edge names a collection absent from dependsOn", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light"],
      // Deliberately missing "primitives" in dependsOn, despite the alias below.
      tokens: [
        token({
          path: "color/surface",
          modes: { light: "#FF0000" },
          alias: { byMode: { light: { collection: "primitives", path: "color/red" } } },
        }),
      ],
    });
    const model = buildTokenModel(document([primitives, base]));
    expect(() => generateCollectionKotlinFile(model, base, { packageName: "com.test" })).toThrow(
      MissingDependencyParamError,
    );
  });

  it("makes a leaf property nullable and emits a null literal when a token has no alias and a null value in an emitted mode", () => {
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      tokens: [token({ path: "color/surface", modes: { light: null, dark: "#FF0000" } })],
    });
    const model = buildTokenModel(document([base]));
    const file = generateCollectionKotlinFile(model, base, { packageName: "com.test" })!;
    expect(file.contents).toContain("val surface: androidx.compose.ui.graphics.Color?,");
    expect(file.contents).toContain("fun baseLight(): Base =");
    expect(file.contents).toContain("fun baseDark(): Base =");
    // The null-valued mode gets a literal `null`; the resolvable mode still gets the real value.
    const lightFn = file.contents.slice(file.contents.indexOf("fun baseLight"));
    expect(lightFn.slice(0, lightFn.indexOf("fun baseDark"))).toContain("surface = null,");
    const darkFn = file.contents.slice(file.contents.indexOf("fun baseDark"));
    expect(darkFn).toContain(
      "surface = androidx.compose.ui.graphics.Color(1.0f, 0.0f, 0.0f, 1.0f),",
    );
  });

  it("filters modes matching excludeModePattern, but keeps everything if that would exclude all modes", () => {
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      tokens: [token({ path: "color/surface", modes: { light: "#FF0000", dark: "#00FF00" } })],
    });
    const model = buildTokenModel(document([base]));
    const filtered = generateCollectionKotlinFile(model, base, {
      packageName: "com.test",
      excludeModePattern: /dark/,
    })!;
    expect(filtered.contents).toContain("fun baseLight()");
    expect(filtered.contents).not.toContain("fun baseDark()");

    const allExcluded = generateCollectionKotlinFile(model, base, {
      packageName: "com.test",
      excludeModePattern: /.*/,
    })!;
    expect(allExcluded.contents).toContain("fun baseLight()");
    expect(allExcluded.contents).toContain("fun baseDark()");
  });
});

describe("generateKotlinFiles — synthetic", () => {
  it("throws DuplicateClassNameError when two collections share a PascalCase class name", () => {
    const a = collection({
      id: "a",
      name: "base color",
      modes: ["value"],
      tokens: [token({ path: "x", modes: { value: "#FFFFFF" } })],
    });
    const b = collection({
      id: "b",
      name: "base-color",
      modes: ["value"],
      tokens: [token({ path: "y", modes: { value: "#000000" } })],
    });
    const model = buildTokenModel(document([a, b]));
    expect(() => generateKotlinFiles(model, { packageName: "com.test" })).toThrow(
      DuplicateClassNameError,
    );
  });

  it("generates one file per non-empty collection, in the model's declared order", () => {
    const primitives = collection({
      id: "p",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "color/red", modes: { value: "#FF0000" } })],
    });
    const layout = collection({ id: "l", name: "layout", modes: ["value"] });
    const model = buildTokenModel(document([primitives, layout]));
    const files = generateKotlinFiles(model, { packageName: "com.test" });
    expect(files.map((f) => f.relativePath)).toEqual(["com/test/Primitives.kt"]);
  });
});

describe("generateCollectionLegacyKotlinFiles — synthetic", () => {
  it("returns an empty array for an empty collection", () => {
    const primitives = collection({ id: "p", name: "primitives", modes: ["value"] });
    const model = buildTokenModel(document([primitives]));
    expect(
      generateCollectionLegacyKotlinFiles(model, primitives, { packageName: "com.test" }),
    ).toEqual([]);
  });

  it("splits a collection into one file per top-level branch, in its own subpackage, plus a root aggregator file", () => {
    const primitives = collection({
      id: "p",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "color/red", modes: { value: "#FF0000" } })],
    });
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      dependsOn: ["primitives"],
      tokens: [
        token({
          path: "color/surface",
          modes: { light: "#FF0000", dark: "#00FF00" },
          alias: { byMode: { light: { collection: "primitives", path: "color/red" } } },
        }),
        token({ path: "scale/base", type: "FLOAT", modes: { light: 4, dark: 4 } }),
      ],
    });
    const model = buildTokenModel(document([primitives, base]));
    const files = generateCollectionLegacyKotlinFiles(model, base, { packageName: "com.test" });
    const byPath = new Map(files.map((f) => [f.relativePath, f]));

    // Root file: restores the "com.test.base" subpackage (the flat emitter
    // puts collection root classes directly under "com.test").
    const root = byPath.get("com/test/base/Base.kt")!;
    expect(root).toBeDefined();
    expect(root.contents).toContain("package com.test.base");
    expect(root.contents).toContain(
      "val color: com.test.base.color.Color,",
    );
    expect(root.contents).toContain(
      "val scale: com.test.base.scale.Scale,",
    );
    expect(root.contents).not.toContain("data class Color(");
    expect(root.contents).toContain(
      "fun baseLight(primitives: com.test.primitives.Primitives): Base = Base(",
    );
    expect(root.contents).toContain("color = colorLight(primitives),");
    expect(root.contents).toContain("scale = scaleLight(primitives),");

    // Branch file: full nested data class + per-mode factory, restoring
    // the old "token.base.color.Color" package shape.
    const colorFile = byPath.get("com/test/base/color/Color.kt")!;
    expect(colorFile).toBeDefined();
    expect(colorFile.contents).toContain("package com.test.base.color");
    expect(colorFile.contents).toContain("data class Color(");
    expect(colorFile.contents).toContain(
      "fun colorLight(primitives: com.test.primitives.Primitives): Color =",
    );
    expect(colorFile.contents).toContain("surface = primitives.color.red,");
    expect(colorFile.contents).toContain(
      "fun colorDark(primitives: com.test.primitives.Primitives): Color =",
    );
  });
});

describe("generateLegacyKotlinFiles — synthetic", () => {
  it("generates legacy-layout files for every non-empty collection in the model", () => {
    const primitives = collection({
      id: "p",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "color/red", modes: { value: "#FF0000" } })],
    });
    const layout = collection({ id: "l", name: "layout", modes: ["value"] });
    const model = buildTokenModel(document([primitives, layout]));
    const files = generateLegacyKotlinFiles(model, { packageName: "com.test" });
    expect(files.map((f) => f.relativePath)).toEqual([
      "com/test/primitives/color/Color.kt",
      "com/test/primitives/Primitives.kt",
    ]);
  });
});

describe("generateKotlinFiles — real-world fixture", () => {
  it("generates valid output for every null-free collection, and a nullable field for base's known null-valued token", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const files = generateKotlinFiles(model, {
      packageName: "com.dexcom.tokens",
      excludeModePattern: /ios/i,
    });
    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    expect(byPath.has("com/dexcom/tokens/Primitives.kt")).toBe(true);
    expect(byPath.has("com/dexcom/tokens/Typography.kt")).toBe(true);
    expect(byPath.has("com/dexcom/tokens/Components.kt")).toBe(true);
    // "layout" has zero tokens in this fixture -- no file, not an error.
    expect(byPath.has("com/dexcom/tokens/Layout.kt")).toBe(false);

    const base = byPath.get("com/dexcom/tokens/Base.kt")!;
    expect(base).toBeDefined();
    expect(base.contents).toContain("val pressed: androidx.compose.ui.graphics.Color?,");
    expect(base.contents).toContain("pressed = null,");
  });

  it("throws UnrepresentableTokenValueError as a defensive guard when a mode key is entirely absent from token.modes", () => {
    const base = collection({
      id: "b",
      name: "base",
      modes: ["light", "dark"],
      // "dark" is declared by the collection but the token's own `modes` map
      // omits it entirely -- a schema invariant violation, not a real null.
      tokens: [token({ path: "color/surface", modes: { light: "#FF0000" } })],
    });
    const model = buildTokenModel(document([base]));
    expect(() => generateCollectionKotlinFile(model, base, { packageName: "com.test" })).toThrow(
      UnrepresentableTokenValueError,
    );
  });

  it("legacy layout also generates valid, non-throwing output for every null-free collection", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const files = generateLegacyKotlinFiles(model, {
      packageName: "com.dexcom.tokens",
      excludeModePattern: /ios/i,
    });
    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    // Restores the old "token.base.color.Color" package shape.
    expect(byPath.has("com/dexcom/tokens/base/color/Color.kt")).toBe(true);
    expect(byPath.has("com/dexcom/tokens/base/Base.kt")).toBe(true);
    expect(byPath.has("com/dexcom/tokens/primitives/Primitives.kt")).toBe(true);
  });
});
