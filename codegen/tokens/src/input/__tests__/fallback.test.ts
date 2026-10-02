import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-exporter/schema";
import {
  applyCollectionFallbacks,
  detectCollectionFallbacks,
  parseFallbackCollectionArg,
} from "../fallback.js";

function collection(overrides: Partial<TokenCollection>): TokenCollection {
  return {
    name: "base",
    id: "VariableCollectionId:1:1",
    remote: false,
    defaultMode: "light",
    modes: ["light", "dark"],
    branches: ["color"],
    dependsOn: [],
    tokens: [],
    ...overrides,
  };
}

function document(collections: TokenCollection[]): TokenDocument {
  return {
    envelope: { schemaVersion: 1, kind: "tokens", fileKey: "abc", version: "v1" },
    policy: { excludedCollections: [], excludedBranches: [], unmatchedPatterns: [] },
    collections,
    unresolved: [],
  };
}

describe("parseFallbackCollectionArg", () => {
  it("splits child=parent", () => {
    expect(parseFallbackCollectionArg("stelo=base")).toEqual(["stelo", "base"]);
  });

  it("rejects a spec with no '='", () => {
    expect(() => parseFallbackCollectionArg("stelo")).toThrow(/expects/);
  });

  it("rejects an empty child or parent", () => {
    expect(() => parseFallbackCollectionArg("=base")).toThrow(/expects/);
    expect(() => parseFallbackCollectionArg("stelo=")).toThrow(/expects/);
  });
});

describe("applyCollectionFallbacks", () => {
  it("fills a null, non-aliased mode value in the child from the parent's same-path value", () => {
    const base = collection({
      name: "base",
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#111111",
          modes: { light: "#111111", dark: "#222222" },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: null,
          modes: { light: null, dark: null },
        },
      ],
    });
    const doc = document([base, stelo]);
    doc.unresolved.push(
      {
        collection: "stelo",
        path: "color/surface/primary",
        reason: "unsupported-value",
        detail:
          'Mode "light" has no value at all in this variable\'s valuesByMode (sparse mode coverage).',
      },
      {
        collection: "stelo",
        path: "color/surface/primary",
        reason: "unsupported-value",
        detail:
          'Mode "dark" has no value at all in this variable\'s valuesByMode (sparse mode coverage).',
      },
    );

    const { document: result, applied } = applyCollectionFallbacks(
      doc,
      new Map([["stelo", "base"]]),
    );

    const resultStelo = result.collections.find((c) => c.name === "stelo")!;
    expect(resultStelo.tokens[0]!.modes).toEqual({ light: "#111111", dark: "#222222" });
    expect(resultStelo.tokens[0]!.value).toBe("#111111");
    expect(result.unresolved).toEqual([]);
    expect(applied).toHaveLength(2);
  });

  it("copies a live alias edge from the parent, not just its resolved literal", () => {
    const base = collection({
      name: "base",
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#111111",
          modes: { light: "#111111", dark: "#222222" },
          alias: {
            byMode: {
              light: { collection: "primitives", path: "palette/halo/500" },
              dark: { collection: "primitives", path: "palette/lavender/500" },
            },
          },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      dependsOn: [],
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: null,
          modes: { light: null, dark: null },
        },
      ],
    });
    const doc = document([base, stelo]);

    const { document: result, applied } = applyCollectionFallbacks(
      doc,
      new Map([["stelo", "base"]]),
    );

    const resultStelo = result.collections.find((c) => c.name === "stelo")!;
    expect(resultStelo.tokens[0]!.modes).toEqual({ light: "#111111", dark: "#222222" });
    expect(resultStelo.tokens[0]!.alias).toEqual({
      byMode: {
        light: { collection: "primitives", path: "palette/halo/500" },
        dark: { collection: "primitives", path: "palette/lavender/500" },
      },
    });
    expect(resultStelo.dependsOn).toEqual(["primitives"]);
    expect(applied[0]).toMatch(/alias into \[primitives\] palette\/halo\/500/);
  });

  it("adds an opacity sub-alias's collection to dependsOn too", () => {
    const base = collection({
      name: "base",
      tokens: [
        {
          path: "color/surface/pressed",
          type: "COLOR",
          value: "#111111",
          modes: { light: "#111111" },
          alias: {
            byMode: {
              light: {
                collection: "primitives",
                path: "palette/halo/500",
                opacity: { collection: "primitives", path: "opacity/40" },
              },
            },
          },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      modes: ["light"],
      dependsOn: [],
      tokens: [
        {
          path: "color/surface/pressed",
          type: "COLOR",
          value: null,
          modes: { light: null },
        },
      ],
    });
    const doc = document([base, stelo]);

    const { document: result } = applyCollectionFallbacks(doc, new Map([["stelo", "base"]]));

    const resultStelo = result.collections.find((c) => c.name === "stelo")!;
    expect(resultStelo.dependsOn).toEqual(["primitives"]);
  });

  it("does not add an excluded alias's target to dependsOn, but keeps the literal fallback", () => {
    const base = collection({
      name: "base",
      tokens: [
        {
          path: "color/system/white",
          type: "COLOR",
          value: "#ffffff",
          modes: { light: "#ffffff" },
          alias: {
            byMode: {
              light: { collection: "figma-only", path: "apple-color/white", excluded: true },
            },
          },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      modes: ["light"],
      dependsOn: [],
      tokens: [
        {
          path: "color/system/white",
          type: "COLOR",
          value: null,
          modes: { light: null },
        },
      ],
    });
    const doc = document([base, stelo]);

    const { document: result, applied } = applyCollectionFallbacks(
      doc,
      new Map([["stelo", "base"]]),
    );

    const resultStelo = result.collections.find((c) => c.name === "stelo")!;
    expect(resultStelo.tokens[0]!.modes).toEqual({ light: "#ffffff" });
    expect(resultStelo.tokens[0]!.alias).toEqual({
      byMode: { light: { collection: "figma-only", path: "apple-color/white", excluded: true } },
    });
    expect(resultStelo.dependsOn).toEqual([]);
    expect(applied[0]).toMatch(/literal "#ffffff" \(alias into excluded collection/);
  });

  it("does not overwrite an already-resolved literal or alias", () => {
    const base = collection({
      name: "base",
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#111111",
          modes: { light: "#111111", dark: "#222222" },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#ABCDEF",
          modes: { light: "#ABCDEF", dark: null },
          alias: { byMode: { dark: { collection: "primitives", path: "some/other" } } },
        },
      ],
    });
    const doc = document([base, stelo]);

    const { document: result, applied } = applyCollectionFallbacks(
      doc,
      new Map([["stelo", "base"]]),
    );

    const resultStelo = result.collections.find((c) => c.name === "stelo")!;
    expect(resultStelo.tokens[0]!.modes).toEqual({ light: "#ABCDEF", dark: null });
    expect(applied).toEqual([]);
  });

  it("throws when the mapped parent collection does not exist", () => {
    const doc = document([collection({ name: "stelo" })]);
    expect(() => applyCollectionFallbacks(doc, new Map([["stelo", "base"]]))).toThrow(
      /no collection named/,
    );
  });

  it("is a no-op when the mapping is empty", () => {
    const doc = document([collection({ name: "base" })]);
    const result = applyCollectionFallbacks(doc, new Map());
    expect(result.document).toBe(doc);
    expect(result.applied).toEqual([]);
  });
});

describe("detectCollectionFallbacks", () => {
  function sparseColorToken(path: string): Token {
    return { path, type: "COLOR", value: null, modes: { light: null, dark: null } };
  }
  function resolvedColorToken(path: string, light: string, dark: string): Token {
    return { path, type: "COLOR", value: light, modes: { light, dark } };
  }

  it("auto-detects a single structurally matching parent", () => {
    const base = collection({
      name: "base",
      tokens: [resolvedColorToken("color/surface/primary", "#111111", "#222222")],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [sparseColorToken("color/surface/primary")],
    });
    const doc = document([base, stelo]);

    const { detected, ambiguous } = detectCollectionFallbacks(doc);
    expect(detected.get("stelo")).toBe("base");
    expect(ambiguous.size).toBe(0);
  });

  it("matches modes case-insensitively", () => {
    const base = collection({
      name: "base",
      modes: ["Light", "Dark"],
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#111111",
          modes: { Light: "#111111", Dark: "#222222" },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [sparseColorToken("color/surface/primary")],
    });
    const doc = document([base, stelo]);

    expect(detectCollectionFallbacks(doc).detected.get("stelo")).toBe("base");
  });

  it("reports ambiguity instead of guessing when more than one candidate resolves something", () => {
    const base = collection({
      name: "base",
      tokens: [resolvedColorToken("color/surface/primary", "#111111", "#222222")],
    });
    const alt = collection({
      name: "alt",
      tokens: [resolvedColorToken("color/surface/primary", "#333333", "#444444")],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [sparseColorToken("color/surface/primary")],
    });
    const doc = document([base, alt, stelo]);

    const { detected, ambiguous } = detectCollectionFallbacks(doc);
    expect(detected.has("stelo")).toBe(false);
    expect(ambiguous.get("stelo")?.sort()).toEqual(["alt", "base"]);
  });

  it("ignores a same-shaped collection that resolves nothing for the child's gaps", () => {
    const base = collection({
      name: "base",
      tokens: [resolvedColorToken("color/other/path", "#111111", "#222222")],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [sparseColorToken("color/surface/primary")],
    });
    const doc = document([base, stelo]);

    expect(detectCollectionFallbacks(doc).detected.size).toBe(0);
  });

  it("skips a collection with no sparse values entirely", () => {
    const base = collection({
      name: "base",
      tokens: [resolvedColorToken("color/surface/primary", "#111111", "#222222")],
    });
    const doc = document([base]);
    expect(detectCollectionFallbacks(doc).detected.size).toBe(0);
  });

  it("requires an equal mode set, not just an overlapping one", () => {
    const base = collection({
      name: "base",
      modes: ["light", "dark", "Tan"],
      tokens: [
        {
          path: "color/surface/primary",
          type: "COLOR",
          value: "#111111",
          modes: { light: "#111111", dark: "#222222", Tan: "#333333" },
        },
      ],
    });
    const stelo = collection({
      name: "stelo",
      tokens: [sparseColorToken("color/surface/primary")],
    });
    const doc = document([base, stelo]);

    expect(detectCollectionFallbacks(doc).detected.size).toBe(0);
  });
});
