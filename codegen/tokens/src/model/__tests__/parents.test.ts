import { describe, expect, it } from "vitest";
import type { Token, TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { CollectionParentError, resolveCollectionParents } from "../parents.js";

function tokens(paths: string[], type: Token["type"] = "COLOR"): Token[] {
  return paths.map((path) => ({ path, type, value: "#000000", modes: { light: "#000000" } }));
}

function collection(name: string, overrides: Partial<TokenCollection> = {}): TokenCollection {
  return {
    name,
    id: `id:${name}`,
    remote: false,
    defaultMode: "light",
    modes: ["light"],
    branches: ["color"],
    dependsOn: [],
    tokens: tokens(["color/a", "color/b"]),
    ...overrides,
  };
}

function document(collections: TokenCollection[]): TokenDocument {
  return {
    envelope: { schemaVersion: 1, kind: "tokens", fileKey: "f", version: "v" },
    policy: { excludedCollections: [], excludedBranches: [], unmatchedPatterns: [] },
    collections,
    unresolved: [],
  };
}

describe("resolveCollectionParents", () => {
  it("uses the Figma-recorded extends link", () => {
    const { parents, notes } = resolveCollectionParents(
      document([collection("base"), collection("stelo", { extends: "base" })]),
    );
    expect([...parents]).toEqual([["stelo", "base"]]);
    expect(notes).toEqual([]);
  });

  it("throws when a recorded extends link is structurally impossible", () => {
    const doc = document([
      collection("base"),
      collection("stelo", { extends: "base", tokens: tokens(["color/a"]) }),
    ]);
    expect(() => resolveCollectionParents(doc)).toThrow(CollectionParentError);
  });

  it("notes, and skips, an extends link whose parent is absent", () => {
    const { parents, notes } = resolveCollectionParents(
      document([collection("stelo", { extends: "base" })]),
    );
    expect(parents.size).toBe(0);
    expect(notes[0]).toMatch(/not \(uniquely\) present/);
  });

  it("detects by structure when the export records no extends at all, first-declared as parent", () => {
    const { parents, notes } = resolveCollectionParents(
      document([
        collection("base"),
        collection("stelo"),
        collection("other", { tokens: tokens(["x"]) }),
      ]),
    );
    expect([...parents]).toEqual([["stelo", "base"]]);
    expect(notes[0]).toMatch(/detected by structure/);
  });

  it("does not detect by structure when token types or modes differ", () => {
    const { parents } = resolveCollectionParents(
      document([
        collection("base"),
        collection("sizes", { tokens: tokens(["color/a", "color/b"], "FLOAT") }),
        collection("dark", { modes: ["dark"] }),
      ]),
    );
    expect(parents.size).toBe(0);
  });

  it("does not detect by structure when the match is ambiguous", () => {
    const { parents } = resolveCollectionParents(
      document([collection("a"), collection("b"), collection("c")]),
    );
    // "b" matches both "a" and "c"; "c" matches "a" and "b".
    expect(parents.size).toBe(0);
  });

  it("skips structural detection once any collection records extends", () => {
    const { parents } = resolveCollectionParents(
      document([
        collection("base"),
        collection("stelo", { extends: "base" }),
        collection("twin", { tokens: tokens(["x"]) }),
        collection("twin2", { tokens: tokens(["x"]) }),
      ]),
    );
    expect([...parents]).toEqual([["stelo", "base"]]);
  });
});
