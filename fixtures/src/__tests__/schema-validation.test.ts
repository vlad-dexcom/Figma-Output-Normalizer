// Validates every fixture's frozen IR against schema/ir/v1/schema.json,
// reusing the same ajv-based pattern as schema/src/ir-schema.test.ts. This
// catches a fixture that's internally consistent with extractor output but
// happens to violate the schema (e.g. after a schema change lands without
// updating the extractor to match).
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { irSchemaV1 } from "@figma-normalizator/schema";
import { scenarios } from "../corpus/index.js";
import { expectedIrPath } from "../scenario.js";

describe("fixture corpus schema validation", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validateNode = ajv.compile(irSchemaV1);
  // `irSchemaV1`'s root `$ref` is `#/$defs/irNode` (validates one node, not
  // the export envelope — see backlog G6). Compile a second validator
  // against `$defs/irDocument` (same `$defs`, different root `$ref`) to
  // also cover the envelope shape (`schemaVersion`/`nodes`/`unresolved`/
  // `version`) each fixture is frozen as. `$id` is dropped on this copy —
  // otherwise ajv rejects it as a duplicate of the schema already
  // registered via `validateNode` above (same `$id`, different `$ref`).
  const validateDocument = ajv.compile({
    ...irSchemaV1,
    $id: undefined,
    $ref: "#/$defs/irDocument",
  });

  for (const scenario of scenarios) {
    it(`${scenario.name}: the whole export envelope validates against ir/v1/schema.json's irDocument`, async () => {
      const expected: unknown = JSON.parse(await readFile(expectedIrPath(scenario), "utf8"));
      const valid = validateDocument(expected);
      if (!valid) {
        throw new Error(
          `${scenario.name}/expected.ir.json failed irDocument schema validation: ${JSON.stringify(
            validateDocument.errors,
            null,
            2,
          )}`,
        );
      }
    });

    it(`${scenario.name}: every root IR node validates against ir/v1/schema.json`, async () => {
      const expected = JSON.parse(await readFile(expectedIrPath(scenario), "utf8")) as {
        nodes: unknown[];
      };
      expect(expected.nodes.length).toBeGreaterThan(0);

      for (const node of expected.nodes) {
        const valid = validateNode(node);
        if (!valid) {
          throw new Error(
            `${scenario.name}/expected.ir.json failed schema validation: ${JSON.stringify(
              validateNode.errors,
              null,
              2,
            )}`,
          );
        }
      }
    });
  }
});
