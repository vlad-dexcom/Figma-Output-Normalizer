import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { loadTokenDocument } from "../../input/load.js";
import { buildTokenModel } from "../build.js";
import { AliasExpansionError, expandTokenModes } from "../modes.js";

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
  return {
    type: "COLOR",
    value: Object.values(overrides.modes)[0] ?? null,
    ...overrides,
  };
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

describe("expandTokenModes — real-world regression (plan 4.4)", () => {
  it("expands a components token's single 'value' mode into base's light/dark, giving two distinct values", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const components = doc.collections.find((c) => c.name === "components");
    const banner = components?.tokens.find(
      (t) => t.path === "banners/type/informative/color/surface",
    );
    expect(components).toBeDefined();
    expect(banner).toBeDefined();

    // Before expansion: the collapsed literal is silently just the light value.
    expect(banner?.modes.value).toBe("#DCE1EA");

    const result = expandTokenModes(model, components as TokenCollection, banner as Token);
    expect(result.expanded).toBe(true);
    expect(result.modes).toEqual(["light", "dark"]);
    expect(result.values.light).toBe("#DCE1EA");
    expect(result.values.dark).toBe("#96959F");
    // The regression this exists to catch: light and dark must differ.
    expect(result.values.light).not.toBe(result.values.dark);
  });

  it("does not expand an alias edge flagged excluded — keeps the documented literal fallback (plan 4.3)", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    const components = doc.collections.find((c) => c.name === "components");
    const progressBar = components?.tokens.find((t) => t.path === "progress-bars/base/size/width");
    expect(progressBar?.alias?.byMode.value?.excluded).toBe(true);

    const result = expandTokenModes(model, components as TokenCollection, progressBar as Token);
    expect(result.expanded).toBe(false);
    expect(result.values).toEqual(progressBar?.modes);
  });
});

describe("expandTokenModes — synthetic edge cases", () => {
  it("leaves a multi-mode collection's own token untouched", () => {
    const base = collection({
      id: "base",
      name: "base",
      modes: ["light", "dark"],
      tokens: [token({ path: "x", modes: { light: "#fff", dark: "#000" } })],
    });
    const model = buildTokenModel(document([base]));
    const result = expandTokenModes(model, base, base.tokens[0] as Token);
    expect(result.expanded).toBe(false);
    expect(result.modes).toEqual(["light", "dark"]);
  });

  it("leaves a single-mode token with no alias untouched", () => {
    const primitives = collection({
      id: "primitives",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "x", modes: { value: 4 } })],
    });
    const model = buildTokenModel(document([primitives]));
    const result = expandTokenModes(model, primitives, primitives.tokens[0] as Token);
    expect(result.expanded).toBe(false);
    expect(result.values).toEqual({ value: 4 });
  });

  it("does not expand into a target collection that is itself single-mode", () => {
    const leaf = collection({ id: "leaf", name: "leaf", modes: ["value"] });
    const primitives = collection({
      id: "primitives",
      name: "primitives",
      modes: ["value"],
      tokens: [token({ path: "target", modes: { value: 1 } })],
    });
    const t = token({
      path: "source",
      modes: { value: 1 },
      alias: { byMode: { value: { collection: "primitives", path: "target" } } },
    });
    leaf.tokens = [t];
    const model = buildTokenModel(document([leaf, primitives]));
    const result = expandTokenModes(model, leaf, t);
    expect(result.expanded).toBe(false);
  });

  it("throws AliasExpansionError when the alias target collection name is ambiguous", () => {
    const base1 = collection({ id: "base-1", name: "base", modes: ["light", "dark"] });
    const base2 = collection({ id: "base-2", name: "base", modes: ["light", "dark"] });
    const leaf = collection({ id: "leaf", name: "leaf", modes: ["value"] });
    const t = token({
      path: "source",
      modes: { value: "#fff" },
      alias: { byMode: { value: { collection: "base", path: "x" } } },
    });
    leaf.tokens = [t];
    const model = buildTokenModel(document([leaf, base1, base2]));
    expect(() => expandTokenModes(model, leaf, t)).toThrow(AliasExpansionError);
    expect(() => expandTokenModes(model, leaf, t)).toThrow(/collections share that name/);
  });

  it("throws AliasExpansionError when the alias target collection is entirely missing", () => {
    const leaf = collection({ id: "leaf", name: "leaf", modes: ["value"] });
    const t = token({
      path: "source",
      modes: { value: "#fff" },
      alias: { byMode: { value: { collection: "nowhere", path: "x" } } },
    });
    leaf.tokens = [t];
    const model = buildTokenModel(document([leaf]));
    expect(() => expandTokenModes(model, leaf, t)).toThrow(/not present in this document/);
  });

  it("throws AliasExpansionError when the alias target token cannot be found by path", () => {
    const base = collection({ id: "base", name: "base", modes: ["light", "dark"] });
    const leaf = collection({ id: "leaf", name: "leaf", modes: ["value"] });
    const t = token({
      path: "source",
      modes: { value: "#fff" },
      alias: { byMode: { value: { collection: "base", path: "does/not/exist" } } },
    });
    leaf.tokens = [t];
    const model = buildTokenModel(document([leaf, base]));
    expect(() => expandTokenModes(model, leaf, t)).toThrow(/no token with that path exists/);
  });
});
