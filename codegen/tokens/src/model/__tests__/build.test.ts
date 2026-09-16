import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import { loadTokenDocument } from "../../input/load.js";
import { DuplicateCollectionIdError, buildTokenModel } from "../build.js";
import { hasNameCollision } from "../types.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

function collection(
  overrides: Partial<TokenCollection> & Pick<TokenCollection, "id" | "name">,
): TokenCollection {
  return {
    remote: false,
    defaultMode: null,
    modes: ["value"],
    branches: [],
    dependsOn: [],
    tokens: [],
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

describe("buildTokenModel", () => {
  it("indexes the real-world fixture's 5 collections by id, with no name collisions", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);

    expect(model.collections).toBe(doc.collections); // preserves declared order, no copy needed
    expect(model.byId.size).toBe(5);
    for (const c of doc.collections) {
      expect(model.byId.get(c.id)).toBe(c);
    }
    for (const name of model.idsByName.keys()) {
      expect(hasNameCollision(model, name)).toBe(false);
    }
  });

  it("passes the envelope through unchanged", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const model = buildTokenModel(doc);
    expect(model.envelope).toBe(doc.envelope);
  });

  it("throws DuplicateCollectionIdError when two collections share an id", () => {
    const doc = document([
      collection({ id: "shared-id", name: "base" }),
      collection({ id: "shared-id", name: "base-copy" }),
    ]);
    expect(() => buildTokenModel(doc)).toThrow(DuplicateCollectionIdError);
  });

  it("records but does not throw on a name collision across distinct ids", () => {
    const doc = document([
      collection({ id: "id-1", name: "Primitives" }),
      collection({ id: "id-2", name: "Primitives" }),
      collection({ id: "id-3", name: "base" }),
    ]);
    const model = buildTokenModel(doc);

    expect(model.idsByName.get("Primitives")).toEqual(["id-1", "id-2"]);
    expect(hasNameCollision(model, "Primitives")).toBe(true);
    expect(hasNameCollision(model, "base")).toBe(false);
    // Both colliding collections remain independently reachable by id.
    expect(model.byId.get("id-1")?.name).toBe("Primitives");
    expect(model.byId.get("id-2")?.name).toBe("Primitives");
  });

  it("hasNameCollision is false for a name that does not exist at all", () => {
    const doc = document([collection({ id: "id-1", name: "base" })]);
    const model = buildTokenModel(doc);
    expect(hasNameCollision(model, "nonexistent")).toBe(false);
  });
});
