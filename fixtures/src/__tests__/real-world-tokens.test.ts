// Validates the captured real-world *token* export against
// schema/tokens/v1/schema.json — the token-side counterpart to
// `real-world.test.ts`.
//
// This is a different kind of check from `token-schema-validation.test.ts`,
// which runs the live extractor over a small mock variables dump. That one
// proves the extractor and the schema agree *today*, on data this repository
// controls. This one proves the schema still accepts a real production
// file's shape: 5 collections, 2030 tokens, 190 `unresolved` entries, alias
// edges into an excluded collection, COMPOSE_COLOR expressions the schema has
// to represent as unsupported, and a collection with zero tokens.
//
// Unlike the real-world *IR* fixture, this artifact was captured after the
// envelope stabilized, so it validates as a whole `tokenDocument` rather than
// entry-by-entry.
import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { tokensSchemaV1, TOKENS_SCHEMA_VERSION } from "@figma-normalizator/schema";
import type { TokenDocument } from "@figma-normalizator/schema";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../real-world/gPHx1sqQHIfMs8706VDGM1_c1-88d0431a4019ec4b.tokens.json",
);

async function loadDocument(): Promise<TokenDocument> {
  return JSON.parse(await readFile(REAL_WORLD_TOKENS_PATH, "utf8")) as TokenDocument;
}

describe("real-world golden token fixture (gPHx1sqQHIfMs8706VDGM1)", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validate = ajv.compile(tokensSchemaV1);

  it("validates as a whole tokenDocument against tokens/v1/schema.json", async () => {
    const doc = await loadDocument();

    const valid = validate(doc);
    if (!valid) {
      throw new Error(
        `real-world token export failed schema validation: ${JSON.stringify(
          validate.errors,
          null,
          2,
        )}`,
      );
    }
    expect(valid).toBe(true);
  });

  it("carries the envelope this package's generated types implement", async () => {
    const doc = await loadDocument();

    expect(doc.envelope.schemaVersion).toBe(TOKENS_SCHEMA_VERSION);
    expect(doc.envelope.kind).toBe("tokens");
    expect(doc.envelope.fileKey).toBe("gPHx1sqQHIfMs8706VDGM1");
    // The filename encodes the same version, which is what makes an export
    // identifiable on disk without opening it.
    expect(REAL_WORLD_TOKENS_PATH).toContain(doc.envelope.version);
  });

  it("preserves Figma's declared mode order rather than sorting it", async () => {
    const doc = await loadDocument();
    const base = doc.collections.find((c) => c.name === "base");

    // The generator this fixture exists to migrate alphabetized modes to
    // ["dark", "light"], which put `dark` first and lost the fact that
    // `light` is the default. Both halves of that regression are asserted
    // here because the fix is only meaningful if both hold.
    expect(base?.modes).toEqual(["light", "dark"]);
    expect(base?.defaultMode).toBe("light");
  });

  it("records an alias into an excluded collection instead of dropping it", async () => {
    const doc = await loadDocument();

    // The documented fallback: the value degrades to the resolved literal so
    // generated code never references a class that was not emitted, but the
    // edge survives, flagged, and is reported. Asserting all three together
    // is the point — any one of them alone would let a silent drop through.
    const excludedAliasEntries = doc.unresolved.filter(
      (u) => u.reason === "excluded-collection-alias",
    );
    expect(excludedAliasEntries.length).toBeGreaterThan(0);

    const flaggedEdges = doc.collections
      .flatMap((c) => c.tokens)
      .flatMap((t) => Object.values(t.alias?.byMode ?? {}))
      .filter((edge) => edge.excluded);
    expect(flaggedEdges.length).toBeGreaterThan(0);

    for (const collection of doc.collections) {
      // An excluded collection is never emitted, so nothing may depend on it.
      expect(collection.dependsOn).not.toContain("figma-only");
    }
  });

  it("keeps an empty collection as an empty collection, not a missing one", async () => {
    const doc = await loadDocument();
    const layout = doc.collections.find((c) => c.name === "layout");

    // `layout` has zero variables in the real file. The schema requires it to
    // survive as an empty `tokens` array so "this collection is empty" stays
    // distinguishable from "this collection disappeared" — which is exactly
    // the distinction that made a deleted collection hard to diagnose.
    expect(layout).toBeDefined();
    expect(layout?.tokens).toEqual([]);
  });
});
