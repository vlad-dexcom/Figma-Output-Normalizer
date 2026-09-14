// End-to-end check that what the plugin's token export actually produces
// validates against schema/tokens/v1/schema.json.
//
// This lives in `fixtures/` rather than `plugin/` because it is a
// cross-package integration test: it runs the real extractor (plugin) over a
// real Figma variables slice, then validates the result against the real
// schema (schema) with ajv. A unit test inside `plugin/` can assert field
// values, but only this can catch the extractor and the schema drifting
// apart — e.g. the extractor emitting a field the schema forbids under
// `additionalProperties: false`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { tokensSchemaV1, TOKENS_SCHEMA_VERSION } from "@figma-normalizator/schema";
import { extractTokens } from "@figma-normalizator/plugin/src/extractor/tokenExport.js";
import type {
  FigmaVariable,
  FigmaVariableCollection,
  TokenExportFigmaAPI,
} from "@figma-normalizator/plugin/src/extractor/types.js";

const dumpPath = fileURLToPath(
  new URL(
    "../../../plugin/src/extractor/__tests__/fixtures/figma-variables.sample.json",
    import.meta.url,
  ),
);

async function loadMockFigma(): Promise<TokenExportFigmaAPI> {
  const dump = JSON.parse(await readFile(dumpPath, "utf8")) as {
    variableCollections: Record<string, FigmaVariableCollection>;
    variables: Record<string, FigmaVariable>;
  };
  return {
    variables: {
      getVariableByIdAsync: async (id) => dump.variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id) => dump.variableCollections[id] ?? null,
      getLocalVariableCollectionsAsync: async () => Object.values(dump.variableCollections),
    },
  };
}

describe("token document schema validation", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validate = ajv.compile(tokensSchemaV1);

  it("a real token export validates against tokens/v1/schema.json", async () => {
    const { document } = await extractTokens(await loadMockFigma(), {
      fileKey: "gPHx1sqQHIfMs8706VDGM1",
    });

    const valid = validate(document);
    if (!valid) {
      throw new Error(
        `token export failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(valid).toBe(true);
    expect(document.envelope.schemaVersion).toBe(TOKENS_SCHEMA_VERSION);
  });

  it("rejects a document carrying a field the schema does not define", async () => {
    // Proves the validation above has teeth: the schema is
    // additionalProperties:false throughout, so a stray field must fail.
    const { document } = await extractTokens(await loadMockFigma(), { fileKey: "f" });
    const tampered = {
      ...document,
      collections: document.collections.map((c) => ({ ...c, unexpectedField: true })),
    };
    expect(validate(tampered)).toBe(false);
  });
});
